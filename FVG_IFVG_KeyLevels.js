// FVG · IFVG · Key Liquidity Levels — Tradovate port of "FVG+IFVG+KL" (Pine v6).
//
// Put this on a 1-MINUTE chart (anything that divides the FVG timeframes works: 1m, 5m).
// Tradovate indicators only see the chart's own bars, so the 5m / 15m / 60m FVG bars are
// built here from the chart's bars, aligned to the clock exactly like TradingView's.
// Times are New York (DST handled internally, no browser timezone needed).
//
// Ported: FVG/IFVG engine on up to 3 timeframes (keep-as-IFVG, only-IFVG, spent IFVGs retired,
// max kept per TF, min size), displacement READ (percentile), size percentile, VOL ×avg,
// swept-level stamp, proximity band; prev day / week / month H/L on the 18:00 session day;
// Asia / London H/L; daily + weekly open; NDOG / NWOG; daily + weekly VWAP and prev-day VWAP
// close; 3 moving averages (EMA / SMA / WMA / RMA, chart timeframe); impulse candles;
// key-level sweeps; the zone table (drawn as a text panel - Tradovate has no table object).
// Not ported: per-chart learned RETEST/DEPTH/THROUGH (the panel shows the NQ reference
// figures by distance band, as the Pine falls back to), HTF moving averages, prev-year H/L,
// alerts (set Tradovate price alerts on the levels instead).

const predef = require("./tools/predef");
const { du, op, px } = require("./tools/graphics");

// ───────────────────────────── New York clock ─────────────────────────────
function nthSundayUTC(y, m, n) {                       // m: 0-11
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + 7 * (n - 1);
}
function nyOffsetH(ms) {
    const y = new Date(ms).getUTCFullYear();
    const start = Date.UTC(y, 2, nthSundayUTC(y, 2, 2), 7);   // 2am EST = 07:00 UTC
    const end = Date.UTC(y, 10, nthSundayUTC(y, 10, 1), 6);   // 2am EDT = 06:00 UTC
    return ms >= start && ms < end ? -4 : -5;
}
function nyInfo(ms) {
    const loc = ms + nyOffsetH(ms) * 3600000;
    const t = new Date(loc);
    const mod = t.getUTCHours() * 60 + t.getUTCMinutes();
    const localDay = Math.floor(loc / 86400000);
    const tradeDay = localDay + (mod >= 1080 ? 1 : 0);          // 18:00 belongs to the next day
    const tdow = (tradeDay + 4) % 7;                             // 0 = Sunday
    const week = tradeDay - ((tdow + 6) % 7);                    // Monday of the trade week
    const td = new Date(tradeDay * 86400000);
    return { mod, tradeDay, week, month: td.getUTCFullYear() * 12 + td.getUTCMonth() };
}

// ───────────────────────────── helpers ─────────────────────────────
const DASH = { Solid: 1, Dashed: 3, Dotted: 5 };
const REF5 = [[95.3, 42, 37.5], [96.0, 67, 47.5], [95.7, 100, 50.2], [94.3, 117, 55.5], [92.5, 158, 59.9]];
const REF15 = [[91.4, 30, 31.6], [92.9, 67, 46.3], [91.9, 79, 48.0], [89.9, 100, 50.6], [87.0, 120, 54.3]];
const HISTN = 500;
function pushCap(a, v, cap) { if (v > 0 && isFinite(v)) { a.push(v); if (a.length > cap) a.shift(); } }
function pctRank(a, v, minN) {
    if (a.length < minN || !isFinite(v)) return NaN;
    let c = 0; for (const x of a) if (x <= v) c++;
    return 100 * c / a.length;
}
function fmt(v, d) { return isFinite(v) ? v.toFixed(d) : "–"; }
function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length); }
function band(dpc) { return !isFinite(dpc) ? 4 : dpc <= 0 ? 0 : dpc <= 0.02 ? 1 : dpc <= 0.06 ? 2 : dpc <= 0.15 ? 3 : 4; }

function newRng() { return { ch: NaN, cl: NaN, ph: NaN, pl: NaN, bi: NaN, full: false }; }
function rollRng(r, isNew, h, l, i) {
    if (isNew) {
        r.ph = r.full ? r.ch : NaN; r.pl = r.full ? r.cl : NaN; r.full = true;
        r.ch = h; r.cl = l; r.bi = i;
    } else {
        r.ch = isNaN(r.ch) ? h : Math.max(r.ch, h); r.cl = isNaN(r.cl) ? l : Math.min(r.cl, l);
        if (isNaN(r.bi)) r.bi = i;
    }
}
function newMA(type, len) { return { type, len, v: NaN, n: 0, buf: [] }; }
function maNext(m, x, commit) {                               // returns the value incl. x
    const L = m.len;
    let v;
    if (m.type === "EMA" || m.type === "RMA") {
        const a = m.type === "EMA" ? 2 / (L + 1) : 1 / L;
        v = isNaN(m.v) ? x : m.v + a * (x - m.v);
        if (commit) m.v = v;
    } else {
        const buf = m.buf.concat([x]); if (buf.length > L) buf.shift();
        if (m.type === "SMA") v = buf.reduce((s, y) => s + y, 0) / buf.length;
        else { let s = 0, w = 0; buf.forEach((y, k) => { s += y * (k + 1); w += k + 1; }); v = s / w; }  // WMA
        if (commit) m.buf = buf;
        if (buf.length < L) v = NaN;
    }
    return v;
}

// ───────────────────────────── calculator ─────────────────────────────
class FvgIfvgKl {
    init() {
        const p = this.props;
        this.done = -1;                    // last committed (closed) chart bar
        this.prev = null;                  // last committed bar + its clock
        this.rD = newRng(); this.rW = newRng(); this.rM = newRng();
        this.asia = { h: NaN, l: NaN, bi: NaN, inS: false };
        this.lon = { h: NaN, l: NaN, bi: NaN, inS: false };
        this.sess = { h: NaN, l: NaN };
        this.vw = { dPV: 0, dV: 0, wPV: 0, wV: 0, pd: NaN, pw: NaN, d: NaN, w: NaN };
        this.dOpen = NaN; this.wOpen = NaN; this.dOpenBi = NaN; this.wOpenBi = NaN;
        this.ndog = []; this.nwog = [];
        this.mas = [newMA(p.ma1Type, p.ma1Len), newMA(p.ma2Type, p.ma2Len), newMA(p.ma3Type, p.ma3Len)];
        this.atr = { v: NaN, n: 0, seed: 0, prevC: NaN, hist: [] };
        this.imp = { hist: [], bi: NaN, sz: NaN, up: false };
        this.sw = { ms: NaN, bi: NaN, name: "", hi: false };
        const slots = [[p.tf1On, p.tf1, p.tf1Keep], [p.tf2On, p.tf2, p.tf2Keep], [p.tf3On, p.tf3, p.tf3Keep]];
        this.slots = slots.map(([on, tf, keep], k) => ({
            id: k + 1, on, tf: Number(tf), keep, ms: Number(tf) * 60000, label: Number(tf) >= 60 ? (Number(tf) / 60) + "h" : tf + "m",
            cur: null, bars: [], atr: NaN, atrN: 0, atrSeed: 0, atrHist: [], st: [], szH: [], dsH: []
        }));
    }

    // levels used for the proximity band (the twelve key levels of the Pine, minus month/year)
    nearDist(top, bot, price) {
        const lv = [this.rD.ph, this.rD.pl, this.rW.ph, this.rW.pl, this.vw.d, this.vw.w,
            this.asia.h, this.asia.l, this.lon.h, this.lon.l];
        let m = Infinity;
        for (const x of lv) {
            if (!isFinite(x)) continue;
            m = Math.min(m, x >= bot && x <= top ? 0 : Math.min(Math.abs(x - bot), Math.abs(x - top)));
        }
        return isFinite(m) && price > 0 ? m / price * 100 : NaN;
    }

    htfClose(s, b) {
        const p = this.props;
        // HTF ATR(14), Wilder, and its 100-bar average
        const pc = s.bars.length ? s.bars[s.bars.length - 1].c : NaN;
        const tr = isNaN(pc) ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
        if (s.atrN < 14) { s.atrSeed += tr; s.atrN++; if (s.atrN === 14) s.atr = s.atrSeed / 14; }
        else s.atr = (s.atr * 13 + tr) / 14;
        if (isFinite(s.atr)) { s.atrHist.push(s.atr); if (s.atrHist.length > 100) s.atrHist.shift(); }
        const atrRel = s.atrHist.length >= 100 ? s.atr / (s.atrHist.reduce((a, x) => a + x, 0) / 100) : NaN;
        s.bars.push(b); if (s.bars.length > 3) s.bars.shift();
        const atrH = s.atr;
        // 1. inversion / retirement on this HTF close
        for (let k = s.st.length - 1; k >= 0; k--) {
            const g = s.st[k];
            if (g.t >= b.t) continue;
            if (!g.inv) {
                const through = g.bull ? b.c < g.bot : b.c > g.top;
                if (!through) continue;
                if (!p.keepIFVG) { s.st.splice(k, 1); continue; }
                g.inv = true; g.tInv = b.t; g.biInv = b.lastBi;
                g.pband = band(this.nearDist(g.top, g.bot, b.c));
                const szp = isFinite(g.atrF) && g.atrF > 0 ? pctRank(s.szH, (g.top - g.bot) / g.atrF, p.pctMinN) : NaN;
                g.szq = isNaN(szp) ? 1 : szp >= 67 ? 2 : szp >= 33 ? 1 : 0;
                if (isFinite(atrH) && atrH > 0) {
                    g.disp = (g.bull ? g.bot - b.c : b.c - g.top) / atrH;
                    g.dispP = pctRank(s.dsH, g.disp, p.pctMinN);
                    pushCap(s.dsH, g.disp, HISTN);
                }
            } else if (g.bull ? b.c > g.top : b.c < g.bot) {
                s.st.splice(k, 1);                                     // spent IFVG
            }
        }
        // 2. new gap: A = two bars before C (= b)
        if (s.bars.length === 3) {
            const A = s.bars[0], C = b;
            const isBull = C.l > A.h, isBear = C.h < A.l;
            if (isBull || isBear) {
                const gt = isBull ? C.l : A.l, gb = isBull ? A.h : C.h;
                const tick = this.contractInfo && this.contractInfo.tickSize ? this.contractInfo.tickSize : 0.25;
                if (gt > gb && gt - gb >= p.minTicks * tick) {
                    const g = {
                        top: gt, bot: gb, t: C.t, tInv: NaN, biA: A.firstBi, biInv: NaN, bull: isBull, inv: false,
                        atrF: atrH, atrRel, pband: band(this.nearDist(gt, gb, C.c)), szq: 1,
                        thrust: isFinite(atrH) && atrH > 0 ? (C.c - A.o) / atrH : NaN, disp: NaN, dispP: NaN,
                        swept: "", swAlign: false, slot: s
                    };
                    if (isFinite(atrH) && atrH > 0) pushCap(s.szH, (gt - gb) / atrH, HISTN);
                    const tEnd = C.t + s.ms;
                    if (p.sweepOn && isFinite(this.sw.ms) && this.sw.ms <= tEnd && tEnd - this.sw.ms <= p.sweepBars * s.ms) {
                        g.swept = this.sw.name; g.swAlign = isBull ? !this.sw.hi : this.sw.hi;
                    }
                    s.st.push(g);
                }
            }
        }
        while (s.st.length > s.keep) s.st.shift();
    }

    commit(e, i) {
        const p = this.props;
        const ms = e.timestamp().getTime();
        const o = e.open(), h = e.high(), l = e.low(), c = e.close(), v = e.volume() || 0;
        const k = nyInfo(ms);
        const pr = this.prev;
        const newSD = pr && k.tradeDay !== pr.k.tradeDay, newSW = pr && k.week !== pr.k.week, newSM = pr && k.month !== pr.k.month;
        // session-day ranges
        rollRng(this.rD, !!newSD, h, l, i); rollRng(this.rW, !!newSW, h, l, i); rollRng(this.rM, !!newSM, h, l, i);
        // opens, opening gaps, VWAP anchors
        if (newSD) {
            this.vw.pd = this.vw.d; this.vw.dPV = 0; this.vw.dV = 0;
            this.dOpen = o; this.dOpenBi = i;
            if (!newSW && pr) { this.addGap(this.ndog, p.ndogKeep, pr.c, o, i); }
        }
        if (newSW) {
            this.vw.pw = this.vw.w; this.vw.wPV = 0; this.vw.wV = 0;
            this.wOpen = o; this.wOpenBi = i;
            if (pr) this.addGap(this.nwog, p.nwogKeep, pr.c, o, i);
        }
        if (!pr) { this.dOpen = o; this.dOpenBi = i; this.wOpen = o; this.wOpenBi = i; }
        const src = (h + l + c) / 3;
        this.vw.dPV += src * v; this.vw.dV += v; this.vw.wPV += src * v; this.vw.wV += v;
        this.vw.d = this.vw.dV > 0 ? this.vw.dPV / this.vw.dV : NaN;
        this.vw.w = this.vw.wV > 0 ? this.vw.wPV / this.vw.wV : NaN;
        // sessions (values of the previous bar are used for the sweep test, as in the Pine)
        const prevAsia = { h: this.asia.h, l: this.asia.l }, prevLon = { h: this.lon.h, l: this.lon.l };
        const prevSess = { h: this.sess.h, l: this.sess.l };
        const inAsia = k.mod >= p.asiaStart * 60 || k.mod < p.asiaEnd * 60;
        const inLon = k.mod >= p.lonStart * 60 && k.mod < p.lonEnd * 60;
        for (const [S, inS] of [[this.asia, inAsia], [this.lon, inLon]]) {
            if (inS) {
                if (!S.inS) { S.h = h; S.l = l; S.bi = i; }
                else { S.h = Math.max(S.h, h); S.l = Math.min(S.l, l); }
            }
            S.inS = inS;
        }
        if (newSD || !pr) { this.sess.h = h; this.sess.l = l; } else { this.sess.h = Math.max(this.sess.h, h); this.sess.l = Math.min(this.sess.l, l); }
        // moving averages and chart ATR
        this.mas.forEach(m => maNext(m, c, true));
        const A = this.atr;
        const tr = isNaN(A.prevC) ? h - l : Math.max(h - l, Math.abs(h - A.prevC), Math.abs(l - A.prevC));
        if (A.n < 14) { A.seed += tr; A.n++; if (A.n === 14) A.v = A.seed / 14; } else A.v = (A.v * 13 + tr) / 14;
        A.prevC = c;
        if (isFinite(A.v)) { A.hist.push(A.v); if (A.hist.length > 100) A.hist.shift(); }
        // impulse candle
        if (p.impOn && isFinite(A.v) && A.v > 0 && Math.abs(c - o) / A.v >= p.impMin) {
            pushCap(this.imp.hist, Math.abs(c - o) / A.v, HISTN);
            this.imp.bi = i; this.imp.sz = Math.abs(c - o) / A.v; this.imp.up = c > o;
        }
        // key-level sweeps: trade through, close back
        if (p.sweepOn) {
            const tests = [["PDH", this.rD.ph, true], ["PDL", this.rD.pl, false], ["PWH", this.rW.ph, true], ["PWL", this.rW.pl, false],
                ["ASH", prevAsia.h, true], ["ASL", prevAsia.l, false], ["LNH", prevLon.h, true], ["LNL", prevLon.l, false],
                ["SH", prevSess.h, true], ["SL", prevSess.l, false]];
            for (const [nm, lv, hi] of tests) {
                if (!isFinite(lv)) continue;
                if (hi ? (h > lv && c < lv) : (l < lv && c > lv)) { this.sw = { ms, bi: i, name: nm, hi }; break; }
            }
        }
        // higher-timeframe bars for the FVG engine
        if (p.fvgOn) {
            for (const s of this.slots) {
                if (!s.on) continue;
                const bucket = Math.floor(ms / s.ms) * s.ms;
                if (s.cur && s.cur.t !== bucket) { this.htfClose(s, s.cur); s.cur = null; }
                if (!s.cur) s.cur = { t: bucket, o, h, l, c, firstBi: i, lastBi: i };
                else { s.cur.h = Math.max(s.cur.h, h); s.cur.l = Math.min(s.cur.l, l); s.cur.c = c; s.cur.lastBi = i; }
            }
        }
        this.prev = { k, c };
        this.lastMs = ms;
        this.done = i;
    }

    addGap(store, keep, a, b, i) {
        const gt = Math.max(a, b), gb = Math.min(a, b);
        if (gt - gb > 0) { store.push({ top: gt, bot: gb, bi: i }); while (store.length > keep) store.shift(); }
    }

    map(d, index, series) {
        const p = this.props;
        // commit every bar before this one exactly once (the current bar may still be forming)
        for (let k = this.done + 1; k < index; k++) this.commit(series.get(k), k);
        const c = d.close(), o = d.open();
        const out = {};
        // live VWAP / MA values including the current bar, without changing committed state
        const k = nyInfo(d.timestamp().getTime());
        const newSD = this.prev && k.tradeDay !== this.prev.k.tradeDay, newSW = this.prev && k.week !== this.prev.k.week;
        const src = (d.high() + d.low() + c) / 3, v = d.volume() || 0;
        const dPV = (newSD ? 0 : this.vw.dPV) + src * v, dV = (newSD ? 0 : this.vw.dV) + v;
        const wPV = (newSW ? 0 : this.vw.wPV) + src * v, wV = (newSW ? 0 : this.vw.wV) + v;
        if (p.showDV && dV > 0 && !newSD) out.dVwap = dPV / dV;
        if (p.showWV && wV > 0 && !newSW) out.wVwap = wPV / wV;
        const maOn = [p.ma1On, p.ma2On, p.ma3On];
        this.mas.forEach((m, j) => { const x = maNext(m, c, false); if (maOn[j] && isFinite(x)) out["ma" + (j + 1)] = x; });
        // impulse candle colour
        if (p.impOn && p.impPaint && isFinite(this.atr.v) && this.atr.v > 0 && Math.abs(c - o) / this.atr.v >= p.impMin) {
            out.candlestick = { color: c > o ? p.colImpU : p.colImpD };
        }
        if (index === series.size() - 1) out.graphics = { items: this.drawAll(index, c, out) };
        return out;
    }

    // ───────────────────────────── drawing (last bar only, global objects) ─────────────────────────────
    drawAll(i, close, liveVals) {
        const p = this.props, items = [];
        const fs = p.fontSize;
        const right = i + 1;
        const tick = this.contractInfo && this.contractInfo.tickSize ? this.contractInfo.tickSize : 0.25;
        const level = (key, show, y, x1, txt, col, sty) => {
            if (!show || !isFinite(y)) return;
            const xa = p.lvlAnchor && isFinite(x1) ? Math.min(x1, i) : i - p.lvlBack;
            items.push({ tag: "LineSegments", key: "L" + key, global: true,
                lines: [{ tag: "Line", a: { x: du(xa), y: du(y) }, b: { x: du(i + p.lvlExt), y: du(y) } }],
                lineStyle: { lineWidth: p.lvlWidth, color: col, lineStyle: DASH[sty] || 1 } });
            if (p.labShow) items.push({ tag: "Text", key: "T" + key, global: true, point: { x: du(i + p.labOff), y: du(y) },
                text: txt + (p.labPrice ? "  " + y.toFixed(2) : ""), style: { fontSize: fs, fill: col }, textAlignment: "rightMiddle" });
        };
        const rect = (key, x1, x2, top, bot, fill, opac, border) => {
            const pts = [{ x: du(x1), y: du(top) }, { x: du(x2), y: du(top) }, { x: du(x2), y: du(bot) }, { x: du(x1), y: du(bot) }];
            items.push({ tag: "Shapes", key: "R" + key, global: true, primitives: [{ tag: "Polygon", points: pts }], fillStyle: { color: fill, opacity: opac } });
            if (border) items.push({ tag: "ContourShapes", key: "B" + key, global: true, primitives: [{ tag: "Polygon", points: pts }], lineStyle: { lineWidth: 1, color: fill, opacity: 0.6 } });
        };
        // key levels
        level("pdh", p.showPD, this.rD.ph, this.rD.bi, "PDH", p.colPD, p.styPD);
        level("pdl", p.showPD, this.rD.pl, this.rD.bi, "PDL", p.colPD, p.styPD);
        level("pwh", p.showPW, this.rW.ph, this.rW.bi, "PWH", p.colPW, p.styPW);
        level("pwl", p.showPW, this.rW.pl, this.rW.bi, "PWL", p.colPW, p.styPW);
        level("pmh", p.showPM, this.rM.ph, this.rM.bi, "PMH", p.colPM, p.styPM);
        level("pml", p.showPM, this.rM.pl, this.rM.bi, "PML", p.colPM, p.styPM);
        level("ash", p.showAsia, this.asia.h, this.asia.bi, "Asia High", p.colAsia, p.styAsia);
        level("asl", p.showAsia, this.asia.l, this.asia.bi, "Asia Low", p.colAsia, p.styAsia);
        level("lnh", p.showLon, this.lon.h, this.lon.bi, "London High", p.colLon, p.styLon);
        level("lnl", p.showLon, this.lon.l, this.lon.bi, "London Low", p.colLon, p.styLon);
        level("do", p.showDO, this.dOpen, this.dOpenBi, "Daily Open", p.colDO, p.styDO);
        level("wo", p.showWO, this.wOpen, this.wOpenBi, "Weekly Open", p.colWO, p.styWO);
        level("pdv", p.showPDV, this.vw.pd, this.dOpenBi, "Prev D VWAP", p.colDV, "Dotted");
        if (p.labShow && isFinite(liveVals.dVwap)) items.push({ tag: "Text", key: "TdV", global: true, point: { x: du(i + p.labOff), y: du(liveVals.dVwap) }, text: "D VWAP", style: { fontSize: fs, fill: p.colDV }, textAlignment: "rightMiddle" });
        if (p.labShow && isFinite(liveVals.wVwap)) items.push({ tag: "Text", key: "TwV", global: true, point: { x: du(i + p.labOff), y: du(liveVals.wVwap) }, text: "W VWAP", style: { fontSize: fs, fill: p.colWV }, textAlignment: "rightMiddle" });
        // opening gaps
        if (p.showNDOG) this.ndog.forEach((g, k) => rect("nd" + k, g.bi - 1, right + p.lvlExt, g.top, g.bot, p.colGap, 0.25, false));
        if (p.showNWOG) this.nwog.forEach((g, k) => rect("nw" + k, g.bi - 1, right + p.lvlExt, g.top, g.bot, p.colWGap, 0.3, false));
        // FVG / IFVG zones
        const zones = [];
        if (p.fvgOn) for (const s of this.slots) if (s.on) for (const g of s.st) {
            if (p.onlyIFVG && !g.inv) continue;
            zones.push(g);
        }
        const dist = g => close >= g.bot && close <= g.top ? 0 : close < g.bot ? (g.bot - close) / close * 100 : (close - g.top) / close * 100;
        zones.sort((a, b) => dist(a) - dist(b));
        const shown = zones.filter(g => !p.tblIFVG || g.inv).slice(0, p.tblRows);
        const rank = new Map(shown.map((g, k) => [g, k + 1]));
        zones.forEach((g, k) => {
            const actBull = g.bull !== g.inv;
            const col = g.inv ? (p.invFlip ? (g.bull ? p.colBear : p.colBull) : p.colInv) : (g.bull ? p.colBull : p.colBear);
            const opac = g.slot.id === 1 ? 0.18 : g.slot.id === 2 ? 0.14 : 0.11;
            rect("z" + k, g.biA, right, g.top, g.bot, col, opac, p.borderOn);
            if (p.showMidFvg) items.push({ tag: "LineSegments", key: "Zm" + k, global: true,
                lines: [{ tag: "Line", a: { x: du(g.biA), y: du((g.top + g.bot) / 2) }, b: { x: du(right), y: du((g.top + g.bot) / 2) } }],
                lineStyle: { lineWidth: 1, color: col, lineStyle: 5 } });
            if (p.labShow && p.showTfTxt) {
                const rk = rank.get(g);
                items.push({ tag: "Text", key: "Zt" + k, global: true, point: { x: du(right), y: du((g.top + g.bot) / 2) },
                    text: (p.tblLink && rk ? "#" + rk + "  " : "") + g.slot.label + (g.inv ? " IFVG" : " FVG") + (actBull ? " ↑" : " ↓"),
                    style: { fontSize: fs, fill: col }, textAlignment: "leftMiddle" });
            }
        });
        // stats panel (top-right, monospace text lines)
        if (p.tblOn) {
            const lines = [];
            lines.push(pad("ZONE", 12) + pad("TF", 5) + pad("SIZE ATR", 12) + pad("READ", 9) + pad("VOL", 7) + pad("SWEPT", 7) + pad("AGE", 5) + pad("INV", 5) + pad("RETEST", 8) + pad("DEPTH", 7) + pad("THRU", 6));
            if (!shown.length) lines.push("no live zones");
            shown.forEach((g, k) => {
                const actBear = g.inv ? g.bull : !g.bull;
                const s = g.slot;
                const szA = isFinite(g.atrF) && g.atrF > 0 ? (g.top - g.bot) / g.atrF : NaN;
                const szP = pctRank(s.szH, szA, p.pctMinN);
                const P = g.inv ? g.dispP : NaN;
                const read = !g.inv ? "pending" : isNaN(P) ? "–" : P >= 90 ? "STRONG" : P >= 70 ? "fair" : P >= 30 ? "average" : "poor";
                const ref = (s.tf >= 15 ? REF15 : REF5)[g.pband];
                const age = Math.floor((this.prevMs() - g.t) / s.ms), ageI = g.inv ? Math.floor((this.prevMs() - g.tInv) / s.ms) : -1;
                lines.push(pad("#" + (k + 1) + " " + (g.inv ? "IFVG" : "FVG") + (actBear ? " ↓" : " ↑"), 12) + pad(s.label, 5) +
                    pad(fmt(szA, 2) + (isFinite(szP) ? " p" + Math.round(szP) : ""), 12) + pad(read, 9) +
                    pad(isFinite(g.atrRel) ? g.atrRel.toFixed(2) + "x" : "–", 7) + pad(g.swept || "–", 7) + pad(age, 5) + pad(ageI < 0 ? "–" : ageI, 5) +
                    pad("·" + Math.round(ref[0]) + "%", 8) + pad("·" + Math.round(ref[1]) + "%", 7) + pad("·" + Math.round(ref[2]) + "%", 6));
            });
            if (p.tblMA) {
                lines.push("MOVING AVERAGES — distance from price");
                [[p.ma1On, p.ma1Type, p.ma1Len, liveVals.ma1], [p.ma2On, p.ma2Type, p.ma2Len, liveVals.ma2], [p.ma3On, p.ma3Type, p.ma3Len, liveVals.ma3]].forEach(([on, t, L, v]) => {
                    if (!on || !isFinite(v)) return;
                    const dd = (close - v) / close * 100;
                    lines.push(pad(t + " " + L, 12) + pad((dd >= 0 ? "+" : "") + dd.toFixed(3) + "%", 10) + v.toFixed(2) + (close > v ? "  price above" : "  price below"));
                });
            }
            if (p.impOn) {
                const ip = pctRank(this.imp.hist, this.imp.sz, p.pctMinN);
                lines.push(isNaN(this.imp.bi) ? "IMPULSE   none on the loaded history" :
                    "IMPULSE   last " + this.imp.sz.toFixed(2) + " ATR " + (this.imp.up ? "up" : "down") + (isFinite(ip) ? "  p" + Math.round(ip) : "") +
                    ",  " + (i - this.imp.bi) + " bars ago   ·   " + this.imp.hist.length + " seen");
            }
            const A = this.atr, avg = A.hist.length ? A.hist.reduce((s, x) => s + x, 0) / A.hist.length : NaN;
            lines.push((isFinite(A.v) ? "ATR " + A.v.toFixed(2) + (isFinite(avg) && avg > 0 ? " (" + (A.v / avg).toFixed(2) + "x avg)" : "") : "ATR –") +
                "     ·     " + (isNaN(this.sw.ms) ? "no sweep yet" : "last sweep " + this.sw.name + ", " + (i - this.sw.bi) + " bars ago"));
            lines.push("RETEST/DEPTH/THRU: · = NQ reference by distance band (2010-2025), not measured on this chart");
            lines.forEach((t, k) => items.push({ tag: "Text", key: "P" + k, global: true,
                origin: { cs: "frame", h: p.tblLeft ? "left" : "right", v: "top" },
                point: { x: px(p.tblLeft ? 10 : -10), y: px(14 + k * (p.tblFont + 5)) }, text: t,
                style: { fontSize: p.tblFont, fill: k === 0 ? p.tblHeader : p.tblText, fontFamily: "monospace, Courier New" },
                textAlignment: p.tblLeft ? "rightBelow" : "leftBelow" }));
        }
        return items;
    }

    prevMs() { return this.lastMs || 0; }      // last committed bar time, for the AGE columns
}

const TF = { "5": "5 min", "15": "15 min", "30": "30 min", "60": "60 min" };
const MAT = { EMA: "EMA", SMA: "SMA", WMA: "WMA", RMA: "RMA" };
const STY = { Solid: "Solid", Dashed: "Dashed", Dotted: "Dotted" };
const S = predef.paramSpecs;

module.exports = {
    name: "fvgIfvgKeyLevels",
    description: "FVG · IFVG · Key Liquidity Levels",
    calculator: FvgIfvgKl,
    inputType: "bars",
    areaChoice: "overlay",
    tags: ["Custom"],
    params: {
        fvgOn: S.bool(true), keepIFVG: S.bool(true), onlyIFVG: S.bool(false), invFlip: S.bool(true),
        showMidFvg: S.bool(false), showTfTxt: S.bool(true), borderOn: S.bool(true), minTicks: S.number(0, 1, 0),
        tf1On: S.bool(true), tf1: S.enum(TF, "5"), tf1Keep: S.number(12, 1, 1),
        tf2On: S.bool(true), tf2: S.enum(TF, "15"), tf2Keep: S.number(10, 1, 1),
        tf3On: S.bool(false), tf3: S.enum(TF, "60"), tf3Keep: S.number(8, 1, 1),
        colBull: S.color("#089981"), colBear: S.color("#f23645"), colInv: S.color("#787b86"),
        showPD: S.bool(true), colPD: S.color("#2962ff"), styPD: S.enum(STY, "Solid"),
        showPW: S.bool(true), colPW: S.color("#089981"), styPW: S.enum(STY, "Solid"),
        showPM: S.bool(true), colPM: S.color("#f23645"), styPM: S.enum(STY, "Solid"),
        showAsia: S.bool(true), colAsia: S.color("#ff9800"), styAsia: S.enum(STY, "Dashed"), asiaStart: S.number(18, 1, 0), asiaEnd: S.number(2, 1, 0),
        showLon: S.bool(true), colLon: S.color("#7e57c2"), styLon: S.enum(STY, "Dashed"), lonStart: S.number(2, 1, 0), lonEnd: S.number(8, 1, 0),
        showNDOG: S.bool(true), colGap: S.color("#9598a1"), ndogKeep: S.number(3, 1, 1),
        showNWOG: S.bool(true), colWGap: S.color("#e1bee7"), nwogKeep: S.number(5, 1, 1),
        showDO: S.bool(true), colDO: S.color("#ffb300"), styDO: S.enum(STY, "Dotted"),
        showWO: S.bool(true), colWO: S.color("#00897b"), styWO: S.enum(STY, "Dotted"),
        showDV: S.bool(true), colDV: S.color("#2962ff"), showPDV: S.bool(true), showWV: S.bool(true), colWV: S.color("#e91e63"),
        ma1On: S.bool(true), ma1Type: S.enum(MAT, "EMA"), ma1Len: S.period(20),
        ma2On: S.bool(true), ma2Type: S.enum(MAT, "EMA"), ma2Len: S.period(50),
        ma3On: S.bool(true), ma3Type: S.enum(MAT, "EMA"), ma3Len: S.period(200),
        impOn: S.bool(true), impMin: S.number(1.0, 0.1, 0.2), impPaint: S.bool(true), colImpU: S.color("#089981"), colImpD: S.color("#f23645"),
        sweepOn: S.bool(true), sweepBars: S.number(10, 1, 1),
        tblOn: S.bool(true), tblLeft: S.bool(false), tblRows: S.number(6, 1, 1), tblIFVG: S.bool(false), tblLink: S.bool(true), tblMA: S.bool(true),
        tblFont: S.number(11, 1, 6), tblText: S.color("#d1d4dc"), tblHeader: S.color("#ffb300"), pctMinN: S.number(40, 1, 10),
        labShow: S.bool(true), labPrice: S.bool(false), labOff: S.number(38, 1, 0), fontSize: S.number(11, 1, 6),
        lvlWidth: S.number(1, 1, 1), lvlExt: S.number(30, 1, 0), lvlAnchor: S.bool(true), lvlBack: S.number(80, 1, 5),
    },
    plots: {
        dVwap: { title: "Daily VWAP" }, wVwap: { title: "Weekly VWAP" },
        ma1: { title: "MA 1" }, ma2: { title: "MA 2" }, ma3: { title: "MA 3" },
    },
    plotter: [predef.plotters.multiline(["dVwap", "wVwap", "ma1", "ma2", "ma3"])],
    schemeStyles: {
        dark: {
            dVwap: predef.styles.plot({ color: "#2962ff" }), wVwap: predef.styles.plot({ color: "#e91e63" }),
            ma1: predef.styles.plot({ color: "#42a5f5" }), ma2: predef.styles.plot({ color: "#ab47bc" }), ma3: predef.styles.plot({ color: "#ef5350" }),
        },
    },
};
