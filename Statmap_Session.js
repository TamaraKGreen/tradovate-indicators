// Session Based Statistical Levels w/ Closes Table — Tradovate port of
// "Session Based Statmap with closing stats" (Pine v5).
//
// One session per indicator instance (add it twice for two sessions). From the session's OPEN it
// projects, using the last N completed sessions (only sessions that closed up or down count):
//   -M / +M      open +/- mean manipulation     (upper line labelled "-M", as in the Pine)
//   +D / -D      open +/- mean distribution
//   medians of both, mean and median up/down expansion (high-open, open-low), shading
//   between mean and median, a session-start marker, and the statistics panel
//   (bull/bear counts, % of session closes beyond the manipulation / distribution levels,
//   average range). New York clock, DST handled internally.
//
// Sessions: NY RTH 09:30-16:00, NY Futures 08:00-17:00, London 02:00-08:00, Asia 19:00-02:00,
// Midnight-17:00, Custom (start/end hour and minute), Auto.
// NOTE on Auto: in the Pine the first test (00:00-17:00) catches every daytime hour, so Auto only
// ever returns "Midnight to 5pm" (00:00-17:00), "Asia" (19:00-02:00) or RTH (17:00-19:00). That
// behaviour is kept here so both match; pick a session explicitly if you want London / NY.
// Additions: "prior session" untested levels and a hit-rate block (how often each level was reached
// inside its own session, and how often the prior session's unreached levels were hit in the next).

const predef = require("./tools/predef");
const { du, op, px } = require("./tools/graphics");

// Settings saved on a chart before an update can come through blank for new or changed inputs; fall back to
// each input's default (and turn numeric text into numbers) so an updated indicator still works without re-adding.
function withDefaults(props, params) {
    const out = {};
    for (const k of Object.keys(params)) {
        const def = params[k].def; let v = props ? props[k] : undefined;
        if (v === undefined || v === null || v === "" || (typeof def === "number" && !isFinite(Number(v)))) v = def;
        else if (typeof def === "number") v = Number(v);
        out[k] = v;
    }
    return out;
}
function applyDefaults(self) {
    const merged = withDefaults(self.props, module.exports.params);
    try { self.props = merged; } catch (e) { for (const k of Object.keys(merged)) { try { self.props[k] = merged[k]; } catch (e2) { } } }
}


function nthSundayUTC(y, m, n) { const f = new Date(Date.UTC(y, m, 1)).getUTCDay(); return 1 + ((7 - f) % 7) + 7 * (n - 1); }
function nyOffsetH(ms) {
    const y = new Date(ms).getUTCFullYear();
    return ms >= Date.UTC(y, 2, nthSundayUTC(y, 2, 2), 7) && ms < Date.UTC(y, 10, nthSundayUTC(y, 10, 1), 6) ? -4 : -5;
}
function nyMod(ms) { const t = new Date(ms + nyOffsetH(ms) * 3600000); return t.getUTCHours() * 60 + t.getUTCMinutes(); }
// hour box accepts an hour (18) or HHMM (1800 / 930); the minute box is added to a plain hour
const toMin = (hour, minute) => { let h = Math.floor(Number(hour)) || 0, m = Math.floor(Number(minute)) || 0; if (h >= 100) { m = h % 100; h = Math.floor(h / 100); } return (h % 24) * 60 + (m % 60); };
const hhmm = s => { const v = parseInt(String(s).replace(":", ""), 10); return Math.floor(v / 100) * 60 + (v % 100); };
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const median = a => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const stdev = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length); };
const DASH = { Solid: 1, Dashed: 3, Dotted: 5 };
const SESS = { rth: ["New York RTH", "0930", "1600"], fut: ["New York Futures", "0800", "1700"], lon: ["London", "0200", "0800"],
    asia: ["Asia", "1900", "0200"], mid: ["Midnight to 5pm", "0000", "1700"] };

class StatmapSession {
    init() {
        applyDefaults(this);
        const p = this.props;
        let name, a, b;
        if (p.session === "custom") { name = "Custom"; a = toMin(p.startHour, p.startMinute); b = toMin(p.endHour, p.endMinute); }
        else if (p.session === "auto") {
            const m = nyMod(Date.now());                                    // same branch order as the Pine
            [name, a, b] = m < 1020 ? ["Midnight to 5pm", 0, 1020] : (m >= 1140 || m < 120) ? ["Asia", 1140, 120] : ["New York RTH", 570, 960];
        } else { const s = SESS[p.session]; name = s[0]; a = hhmm(s[1]); b = hhmm(s[2]); }
        this.name = name; this.a = a; this.b = b;
        this.done = -1; this.inS = false; this.cur = null; this.prior = null;
        this.H = { manip: [], dist: [], up: [], dn: [], range: [], type: [], close: [], open: [] };
        this.cnt = { am: 0, bm: 0, ad: 0, bd: 0 };
        this.stats = { Mu: [], Md: [], Du: [], Dd: [], prior: [] };
        this.lv = null;
    }

    inSession(mod) { return this.a < this.b ? mod >= this.a && mod < this.b : mod >= this.a || mod < this.b; }

    levelsFrom(o) {
        const H = this.H;
        if (!H.manip.length) return null;
        const aM = mean(H.manip), aD = mean(H.dist), mM = median(H.manip), mD = median(H.dist);
        return { open: o, Mu: o + aM, Md: o - aM, Du: o + aD, Dd: o - aD, mMu: o + mM, mMd: o - mM, mDu: o + mD, mDd: o - mD,
            eU: o + mean(H.up), eD: o - mean(H.dn), meU: o + median(H.up), meD: o - median(H.dn) };
    }

    endSession(S) {
        const p = this.props, H = this.H;
        if (S.lv) {
            for (const [k, v] of [["Mu", S.h >= S.lv.Mu], ["Md", S.l <= S.lv.Md], ["Du", S.h >= S.lv.Du], ["Dd", S.l <= S.lv.Dd]]) {
                this.stats[k].push(v); if (this.stats[k].length > p.statN) this.stats[k].shift();
            }
        }
        if (this.prior && this.prior.lv) {
            const P = this.prior;
            for (const [lv, up] of [["Mu", true], ["Md", false], ["Du", true], ["Dd", false]]) {
                if (up ? P.h >= P.lv[lv] : P.l <= P.lv[lv]) continue;           // already reached in its own session
                this.stats.prior.push(P.lv[lv] > S.o ? S.h >= P.lv[lv] : S.l <= P.lv[lv]);
                if (this.stats.prior.length > 4 * p.statN) this.stats.prior.shift();
            }
        }
        const type = S.c > S.o ? 1 : S.c < S.o ? -1 : 0;
        if (type !== 0) {
            H.manip.push(type === 1 ? S.o - S.l : S.h - S.o); H.dist.push(type === 1 ? S.h - S.o : S.o - S.l);
            H.up.push(S.h - S.o); H.dn.push(S.o - S.l); H.range.push(S.h - S.l); H.type.push(type); H.close.push(S.c); H.open.push(S.o);
            // running "% closes beyond" counts, kept exactly as the Pine does: a session is counted against the mean
            // that includes it at its own close, and uncounted (if still beyond) against the mean left after removal
            const C = this.cnt, aM = mean(H.manip), aD = mean(H.dist);
            if (S.c > S.o + aM) C.am++; if (S.c < S.o - aM) C.bm++;
            if (S.c > S.o + aD) C.ad++; if (S.c < S.o - aD) C.bd++;
            if (H.type.length > p.histSessions) {
                const oc = H.close[0], oo = H.open[0];
                for (const k of Object.keys(H)) H[k].shift();
                const hM = mean(H.manip), hD = mean(H.dist);
                if (oc > oo + hM) C.am = Math.max(0, C.am - 1); if (oc < oo - hM) C.bm = Math.max(0, C.bm - 1);
                if (oc > oo + hD) C.ad = Math.max(0, C.ad - 1); if (oc < oo - hD) C.bd = Math.max(0, C.bd - 1);
            }
        }
        this.prior = S;
    }

    // which session a bar belongs to: its New York date, +1 for the evening part of an overnight session.
    // A new session starts when this changes, so a holiday halt with no bars between sessions (e.g. Thanksgiving,
    // trading stops 13:00 and restarts 18:00) still ends one session and starts the next.
    sessId(ms, mod) { const day = Math.floor((ms + nyOffsetH(ms) * 3600000) / 86400000); return this.a > this.b && mod >= this.a ? day + 1 : day; }

    commit(e, i) {
        const ms = e.timestamp().getTime(), mod = nyMod(ms);
        const inS = this.inSession(mod), sid = inS ? this.sessId(ms, mod) : null;
        const xi = typeof e.index === "function" ? e.index() : i;
        const fresh = inS && (!this.inS || !this.cur || this.cur.sid !== sid);
        if (this.cur && (!inS || fresh)) { if (!this.cur.partial) this.endSession(this.cur); this.cur = null; }
        if (fresh) this.cur = { o: e.open(), h: e.high(), l: e.low(), c: e.close(), bi: xi, sid, lv: this.levelsFrom(e.open()),
            partial: i === 0 && mod !== this.a };                            // history starts mid-session: wrong open, skip it
        else if (inS && this.cur) { this.cur.h = Math.max(this.cur.h, e.high()); this.cur.l = Math.min(this.cur.l, e.low()); this.cur.c = e.close(); }
        this.inS = inS;
        this.done = i; this.nBars = i + 1;
    }

    map(d, index, series) {
        // Tradovate may load more history (e.g. after raising the bars to load) without restarting the indicator:
        // if the first bar or the bar order changes, start again from scratch on the new bars
        const t0 = series.size() ? series.get(0).timestamp().getTime() : 0;
        if (this.t0 !== undefined && (t0 !== this.t0 || index < this.done)) this.init();
        this.t0 = t0;
        for (let k = this.done + 1; k < index; k++) this.commit(series.get(k), k);
        if (index !== series.size() - 1) return {};
        return { graphics: { items: this.draw(typeof d.index === "function" ? d.index() : index, d) } };
    }

    draw(i, d) {
        const p = this.props, items = [], fs = p.fontSize;
        const mod = nyMod(d.timestamp().getTime());
        // the session shown is the running one, or the last completed one when outside it
        let S = this.cur;
        const nowMs = d.timestamp().getTime();
        if (this.inSession(mod) && (!S || S.sid !== this.sessId(nowMs, mod)))   // live bar opens a new session
            S = { o: d.open(), h: d.high(), l: d.low(), bi: i, sid: this.sessId(nowMs, mod), lv: this.levelsFrom(d.open()) };
        if (!S) S = this.prior;
        const line = (key, y, col, sty, w, txt, x1, x2) => {
            if (!isFinite(y)) return;
            items.push({ tag: "LineSegments", key: "L" + key, global: true, lines: [{ tag: "Line", a: { x: du(x1), y: du(y) }, b: { x: du(x2), y: du(y) } }],
                lineStyle: { lineWidth: w, color: col, lineStyle: DASH[sty] || 1 } });
            if (p.showLabels && txt) items.push({ tag: "Text", key: "T" + key, global: true, point: { x: du(x2), y: du(y) }, text: " " + txt, style: { fontSize: fs, fill: col }, textAlignment: "rightMiddle" });
        };
        const shade = (key, a, b, col, x1, x2) => {
            if (!isFinite(a) || !isFinite(b)) return;
            items.push({ tag: "Shapes", key: "S" + key, global: true, primitives: [{ tag: "Polygon", points: [
                { x: du(x1), y: du(Math.max(a, b)) }, { x: du(x2), y: du(Math.max(a, b)) }, { x: du(x2), y: du(Math.min(a, b)) }, { x: du(x1), y: du(Math.min(a, b)) }] }],
                fillStyle: { color: col, opacity: p.shadeOpacity } });
        };
        if (S && S.lv) {
            const L = S.lv, x1 = S.bi, x2 = p.extendToNow ? Math.max(S.bi + p.projOffset, i + 2) : S.bi + p.projOffset;
            if (p.showAnchor) {
                items.push({ tag: "LineSegments", key: "A", global: true, lines: [{ tag: "Line", a: { x: du(x1), y: du(L.eD) }, b: { x: du(x1), y: du(L.eU) } }],
                    lineStyle: { lineWidth: 1, color: p.colAnchor, lineStyle: 5 } });
                if (p.showLabels) items.push({ tag: "Text", key: "At", global: true, point: { x: du(x1), y: du(L.eU) }, text: "Session Start", style: { fontSize: fs, fill: p.colAnchor }, textAlignment: "centerAbove" });
            }
            if (p.showOpen) line("o", L.open, p.colOpen, p.styOpen, 1, "Session Open", x1, x2);
            if (p.showManip) { line("mu", L.Mu, p.colManip, p.styManip, p.width, "-M", x1, x2); line("md", L.Md, p.colManip, p.styManip, p.width, "+M", x1, x2); }
            if (p.showDist) { line("du", L.Du, p.colDist, p.styDist, p.width, "+D", x1, x2); line("dd", L.Dd, p.colDist, p.styDist, p.width, "-D", x1, x2); }
            if (p.showMedian) {
                line("mmu", L.mMu, p.colMedian, p.styMedian, 1, "-M Median", x1, x2); line("mmd", L.mMd, p.colMedian, p.styMedian, 1, "+M Median", x1, x2);
                line("mdu", L.mDu, p.colMedian, p.styMedian, 1, "+D Median", x1, x2); line("mdd", L.mDd, p.colMedian, p.styMedian, 1, "-D Median", x1, x2);
            }
            if (p.showExpansion) {
                line("eu", L.eU, p.colExp, p.styExp, 1, "+Exp Mean", x1, x2); line("ed", L.eD, p.colExp, p.styExp, 1, "-Exp Mean", x1, x2);
                line("meu", L.meU, p.colExp, p.styExp, 1, "+Exp Med", x1, x2); line("med", L.meD, p.colExp, p.styExp, 1, "-Exp Med", x1, x2);
            }
            if (p.showShading) {
                shade("mu", L.Mu, L.mMu, p.colManip, x1, x2); shade("md", L.Md, L.mMd, p.colManip, x1, x2);
                shade("du", L.Du, L.mDu, p.colDist, x1, x2); shade("dd", L.Dd, L.mDd, p.colDist, x1, x2);
            }
            const P = S === this.prior ? null : this.prior;
            if (p.showPrior && P && P.lv) {
                for (const [lv, up, nm] of [["Mu", true, "-M"], ["Md", false, "+M"], ["Du", true, "+D"], ["Dd", false, "-D"]]) {
                    if (up ? P.h < P.lv[lv] : P.l > P.lv[lv]) line("p" + lv, P.lv[lv], p.colPrior, "Dashed", 1, "prior " + nm, P.bi, x2);
                }
            }
        }
        if (p.showTable) {
            const H = this.H, n = H.type.length, aM = mean(H.manip), aD = mean(H.dist);
            const { am, bm, ad, bd } = this.cnt;                            // Pine's running counts (see endSession)
            const f = v => n ? Math.max(0, Math.min(100, 100 * v / n)).toFixed(2) + "%" : "–", r = v => v.length ? (100 * v.filter(Boolean).length / v.length).toFixed(0) + "%" : "–";
            const pad = (x, w) => { x = String(x); return x.length >= w ? x.slice(0, w) : x + " ".repeat(w - x.length); };
            const rng = H.range, z = rng.length > 1 ? (rng[rng.length - 1] - mean(rng)) / stdev(rng) : NaN;
            const rows = [pad(this.name + " (" + String(Math.floor(this.a / 60)).padStart(2, "0") + String(this.a % 60).padStart(2, "0") + "-" +
                String(Math.floor(this.b / 60)).padStart(2, "0") + String(this.b % 60).padStart(2, "0") + ")", 34) + "Total Sessions: " + n,
                pad("Bullish", 34) + H.type.filter(t => t === 1).length, pad("Bearish", 34) + H.type.filter(t => t === -1).length,
                pad("% Session Closes Above Manip", 34) + f(am), pad("% Session Closes Below Manip", 34) + f(bm),
                pad("% Session Closes Above Dist", 34) + f(ad), pad("% Session Closes Below Dist", 34) + f(bd),
                pad("Avg Session Range", 34) + (isFinite(mean(rng)) ? mean(rng).toFixed(2) : "–") + (isFinite(z) ? "   last z " + z.toFixed(2) : ""),
                pad("Hit rate -M / +M / +D / -D", 34) + [r(this.stats.Mu), r(this.stats.Md), r(this.stats.Du), r(this.stats.Dd)].join(" / ") + "  (" + this.stats.Mu.length + ")",
                pad("Prior untested levels hit next", 34) + r(this.stats.prior) + "  (" + this.stats.prior.length + ")",
                pad("Chart bars loaded", 34) + (this.nBars || 0) + "   sessions found " + n];
            if (!n) rows.push("No completed session in the loaded history yet - double-click a candle and raise the number of bars loaded");
            else if (n < p.histSessions) rows.push("Only " + n + " of " + p.histSessions + " sessions in the loaded history - double-click a candle and raise the number of bars loaded");
            rows.forEach((t, k) => items.push({ tag: "Text", key: "P" + k, global: true, origin: { cs: "frame", h: p.tableLeft ? "left" : "right", v: p.tableTop ? "top" : "bottom" },
                point: { x: px(p.tableLeft ? 10 : -10), y: px(p.tableTop ? 14 + k * (p.tableFont + 5) : -(14 + (rows.length - 1 - k) * (p.tableFont + 5))) },
                text: t, style: { fontSize: p.tableFont, fill: k === 0 ? p.colTableHead : p.colTable, fontFamily: "monospace, Courier New" },
                textAlignment: p.tableLeft ? "rightMiddle" : "leftMiddle" }));
        }
        return items;
    }
}

const S = predef.paramSpecs;
const SO = { auto: "Auto", rth: "New York RTH (9.30am - 4pm)", fut: "New York Futures (8am - 5pm)", lon: "London (2am - 8am)",
    asia: "Asia (7pm - 2am)", mid: "Midnight to 5pm", custom: "Custom" };
const STY = { Solid: "Solid", Dashed: "Dashed", Dotted: "Dotted" };

module.exports = {
    name: "statmapSession",
    description: "Session Based Statistical Levels w/Closes Table",
    calculator: StatmapSession,
    inputType: "bars",
    areaChoice: "overlay",
    tags: ["Custom"],
    params: {
        session: S.enum(SO, "rth"), startHour: S.number(9, 1, 0), startMinute: S.number(0, 5, 0), endHour: S.number(12, 1, 0), endMinute: S.number(0, 5, 0),
        histSessions: S.number(60, 1, 1),
        showAnchor: S.bool(true), colAnchor: S.color("#9e9e9e"),
        showOpen: S.bool(true), colOpen: S.color("#bdbdbd"), styOpen: S.enum(STY, "Solid"),
        showManip: S.bool(true), colManip: S.color("#ef5350"), styManip: S.enum(STY, "Dotted"),
        showDist: S.bool(true), colDist: S.color("#42a5f5"), styDist: S.enum(STY, "Dotted"), width: S.number(1, 1, 1),
        showMedian: S.bool(true), colMedian: S.color("#757575"), styMedian: S.enum(STY, "Dotted"),
        showExpansion: S.bool(true), colExp: S.color("#26a69a"), styExp: S.enum(STY, "Dashed"),
        showShading: S.bool(true), shadeOpacity: S.number(0.12, 0.02, 0),
        showPrior: S.bool(true), colPrior: S.color("#9e9e9e"), statN: S.number(250, 10, 10),
        projOffset: S.number(24, 1, 0), extendToNow: S.bool(true), showLabels: S.bool(true), fontSize: S.number(10, 1, 6),
        showTable: S.bool(true), tableLeft: S.bool(false), tableTop: S.bool(false), tableFont: S.number(11, 1, 6),
        colTable: S.color("#d1d4dc"), colTableHead: S.color("#ffb300"),
    },
};
