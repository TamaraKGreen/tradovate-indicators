// OHLC StatMap (Multi-Timeframe) — Tradovate port of "Statmap HTF no like for like lookback" (Pine v6).
//
// For each selected timeframe, levels are projected from the CURRENT candle's open using the last
// N completed candles of that timeframe:
//   manipulation = the wick against the candle's direction (bull: open-low, bear: high-open)
//   distribution = the move with it                       (bull: high-open, bear: open-low)
//   +M / -M  open -/+ mean manipulation        (labels follow the Pine: the UPPER line is "-M")
//   +D / -D  open +/- mean distribution
//   medians, quantile bands (Q25/Q75 by default), average high / low, shading between mean and median.
// Candles are built from the chart's bars on the New York clock, anchored like TradingView's CME
// candles: 1H and 4H from 18:00 (4H = 18,22,02,06,10,14), 1D = 18:00-17:00 session, 1W = Sunday 18:00,
// 1M = trade-date month. Use a 1-minute to 15-minute chart.
//
// Additions (off-by-default ones keep the original behaviour):
//   likeForLike   lookback uses only candles of the same slot (e.g. only past 10:00-14:00 candles)
//   showPrior     also draw the PRIOR candle's levels that it never reached ("untested")
//   hit panel     how often each level was actually reached inside its own candle, and how often the
//                 prior candle's untested levels were reached in the next one (current vs prior hit rates)

const predef = require("./tools/predef");
const { du, op, px } = require("./tools/graphics");

function nthSundayUTC(y, m, n) { const f = new Date(Date.UTC(y, m, 1)).getUTCDay(); return 1 + ((7 - f) % 7) + 7 * (n - 1); }
function nyOffsetH(ms) {
    const y = new Date(ms).getUTCFullYear();
    return ms >= Date.UTC(y, 2, nthSundayUTC(y, 2, 2), 7) && ms < Date.UTC(y, 10, nthSundayUTC(y, 10, 1), 6) ? -4 : -5;
}
function nyInfo(ms) {
    const loc = ms + nyOffsetH(ms) * 3600000, t = new Date(loc);
    const mod = t.getUTCHours() * 60 + t.getUTCMinutes();
    const tradeDay = Math.floor(loc / 86400000) + (mod >= 1080 ? 1 : 0);
    const tdow = (tradeDay + 4) % 7, td = new Date(tradeDay * 86400000);
    return { mod, sm: (mod - 1080 + 1440) % 1440, tradeDay, week: tradeDay - ((tdow + 6) % 7), month: td.getUTCFullYear() * 12 + td.getUTCMonth() };
}
function candleKey(tf, k) {
    switch (tf) {
        case "1H": return [k.tradeDay * 100 + Math.floor(k.sm / 60), Math.floor(k.sm / 60)];
        case "4H": return [k.tradeDay * 100 + Math.min(Math.floor(k.sm / 240), 5), Math.min(Math.floor(k.sm / 240), 5)];
        case "1D": return [k.tradeDay, 0];
        case "1W": return [k.week, 0];
        case "1M": return [k.month, 0];
    }
    return [null, 0];
}
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
function quantile(a, q) {
    if (!a.length) return NaN;
    const s = a.slice().sort((x, y) => x - y), pos = (q / 100) * (s.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
const pct = (a) => a.length ? (100 * a.filter(Boolean).length / a.length).toFixed(0) + "%" : "–";
const DASH = { Solid: 1, Dashed: 3, Dotted: 5 };

class StatmapHTF {
    init() {
        const p = this.props;
        this.done = -1;
        this.tfs = [[p.tf1, p.col1], [p.tf2, p.col2], [p.tf3, p.col3], [p.tf4, p.col4]]
            .filter(([tf]) => tf !== "None")
            .map(([tf, col]) => ({ tf, col, cur: null, prior: null, hist: {}, stats: { Mu: [], Md: [], Du: [], Dd: [], eitherM: [], bothM: [], prior: [] } }));
    }

    history(T, slot) {                       // arrays the levels are built from
        const key = this.props.likeForLike ? slot : "all";
        if (!T.hist[key]) T.hist[key] = { manip: [], dist: [], hi: [], lo: [] };
        return T.hist[key];
    }

    levels(T, slot, o) {
        const p = this.props, H = this.history(T, slot);
        if (!H.manip.length) return null;
        const aM = mean(H.manip), aD = mean(H.dist), mM = quantile(H.manip, 50), mD = quantile(H.dist, 50);
        return {
            open: o, Mu: o + aM, Md: o - aM, Du: o + aD, Dd: o - aD, mMu: o + mM, mMd: o - mM, mDu: o + mD, mDd: o - mD,
            aH: o + mean(H.hi), aL: o - mean(H.lo),
            qMu: o + quantile(H.manip, p.qManipHigh), qMd: o - quantile(H.manip, p.qManipLow),
            qDu: o + quantile(H.dist, p.qDistHigh), qDd: o - quantile(H.dist, p.qDistLow),
        };
    }

    closeCandle(T, c) {
        const p = this.props;
        // hit statistics for this candle's own levels (levels fixed at its open)
        if (c.lv) {
            const s = T.stats, hit = (lv, up) => up ? c.h >= c.lv[lv] : c.l <= c.lv[lv];
            const mu = hit("Mu", true), md = hit("Md", false);
            for (const [k, v] of [["Mu", mu], ["Md", md], ["Du", hit("Du", true)], ["Dd", hit("Dd", false)], ["eitherM", mu || md], ["bothM", mu && md]]) {
                s[k].push(v); if (s[k].length > p.statN) s[k].shift();
            }
        }
        // prior candle's untested levels, reached inside this candle?
        if (T.prior && T.prior.lv) {
            const P = T.prior;
            for (const [lv, up] of [["Mu", true], ["Md", false], ["Du", true], ["Dd", false]]) {
                const untested = up ? P.h < P.lv[lv] : P.l > P.lv[lv];
                if (!untested) continue;
                const reached = P.lv[lv] > c.o ? c.h >= P.lv[lv] : c.l <= P.lv[lv];
                T.stats.prior.push(reached); if (T.stats.prior.length > 4 * p.statN) T.stats.prior.shift();
            }
        }
        // add the candle to the lookback (direction-less candles are skipped, as in the Pine)
        if (c.c !== c.o) {
            const H = this.history(T, c.slot), bull = c.c > c.o;
            H.manip.push(bull ? c.o - c.l : c.h - c.o); H.dist.push(bull ? c.h - c.o : c.o - c.l);
            H.hi.push(c.h - c.o); H.lo.push(c.o - c.l);
            for (const a of [H.manip, H.dist, H.hi, H.lo]) if (a.length > p.histCandles) a.shift();
        }
        T.prior = c;
    }

    commit(e, i) {
        const k = nyInfo(e.timestamp().getTime());
        const o = e.open(), h = e.high(), l = e.low(), cl = e.close();
        for (const T of this.tfs) {
            const [key, slot] = candleKey(T.tf, k);
            if (T.cur && T.cur.key !== key) { this.closeCandle(T, T.cur); T.cur = null; }
            if (!T.cur) T.cur = { key, slot, o, h, l, c: cl, bi: i, lv: this.levels(T, slot, o) };
            else { T.cur.h = Math.max(T.cur.h, h); T.cur.l = Math.min(T.cur.l, l); T.cur.c = cl; }
        }
        this.done = i;
    }

    map(d, index, series) {
        for (let k = this.done + 1; k < index; k++) this.commit(series.get(k), k);
        if (index !== series.size() - 1) return {};
        // the forming bar may open a new candle: preview it so its levels show immediately
        const k = nyInfo(d.timestamp().getTime());
        return { graphics: { items: this.draw(index, k, d) } };
    }

    draw(i, k, d) {
        const p = this.props, items = [], fs = p.fontSize;
        const line = (key, x1, x2, y, col, sty, w, txt) => {
            if (!isFinite(y)) return;
            items.push({ tag: "LineSegments", key: "L" + key, global: true, lines: [{ tag: "Line", a: { x: du(x1), y: du(y) }, b: { x: du(x2), y: du(y) } }],
                lineStyle: { lineWidth: w, color: col, lineStyle: DASH[sty] || 1 } });
            if (txt && p.showLabels) items.push({ tag: "Text", key: "T" + key, global: true, point: { x: du(x2), y: du(y) }, text: " " + txt, style: { fontSize: fs, fill: col }, textAlignment: "rightMiddle" });
        };
        const shade = (key, x1, x2, a, b, col) => {
            if (!isFinite(a) || !isFinite(b)) return;
            items.push({ tag: "Shapes", key: "S" + key, global: true, primitives: [{ tag: "Polygon", points: [
                { x: du(x1), y: du(Math.max(a, b)) }, { x: du(x2), y: du(Math.max(a, b)) }, { x: du(x2), y: du(Math.min(a, b)) }, { x: du(x1), y: du(Math.min(a, b)) }] }],
                fillStyle: { color: col, opacity: p.shadeOpacity } });
        };
        const panel = [];
        this.tfs.forEach((T, n) => {
            let C = T.cur;
            const [key, slot] = candleKey(T.tf, k);
            if (C && C.key !== key) C = { key, slot, o: d.open(), h: d.high(), l: d.low(), bi: i, lv: this.levels(T, slot, d.open()) };  // new candle on the live bar
            if (!C || !C.lv) return;
            const L = C.lv, x1 = C.bi, x2 = p.extendToNow ? Math.max(C.bi + p.projOffset, i + 2) : C.bi + p.projOffset, tf = T.tf, col = T.col;
            if (p.showAnchor) {
                items.push({ tag: "LineSegments", key: "A" + n, global: true, lines: [{ tag: "Line", a: { x: du(x1), y: du(L.aL) }, b: { x: du(x1), y: du(L.aH) } }],
                    lineStyle: { lineWidth: 1, color: p.colAnchor, lineStyle: 5 } });
                if (p.showLabels) items.push({ tag: "Text", key: "At" + n, global: true, point: { x: du(x1), y: du(L.Du) }, text: "Start " + tf, style: { fontSize: fs, fill: p.colAnchor }, textAlignment: "centerAbove" });
            }
            if (p.showOpen) line("o" + n, x1, x2, L.open, p.colOpen, p.styOpen, 1, "Open " + tf);
            if (p.showManip) { line("mu" + n, x1, x2, L.Mu, col, p.styManip, p.width, "-M " + tf); line("md" + n, x1, x2, L.Md, col, p.styManip, p.width, "+M " + tf); }
            if (p.showDist) { line("du" + n, x1, x2, L.Du, col, p.styDist, p.width, "+D " + tf); line("dd" + n, x1, x2, L.Dd, col, p.styDist, p.width, "-D " + tf); }
            if (p.showMedian) {
                line("mmu" + n, x1, x2, L.mMu, p.colMedian, p.styMedian, 1, "-M (Med) " + tf); line("mmd" + n, x1, x2, L.mMd, p.colMedian, p.styMedian, 1, "+M (Med) " + tf);
                line("mdu" + n, x1, x2, L.mDu, p.colMedian, p.styMedian, 1, "+D (Med) " + tf); line("mdd" + n, x1, x2, L.mDd, p.colMedian, p.styMedian, 1, "-D (Med) " + tf);
            }
            if (p.showAvgHL) { line("ah" + n, x1, x2, L.aH, p.colAvgHL, p.styAvgHL, 1, "Avg High " + tf); line("al" + n, x1, x2, L.aL, p.colAvgHL, p.styAvgHL, 1, "Avg Low " + tf); }
            if (p.useQuantiles) {
                line("qmu" + n, x1, x2, L.qMu, p.colQuant, p.styQuant, 1, "-Q" + p.qManipHigh + "M " + tf);
                line("qmd" + n, x1, x2, L.qMd, p.colQuant, p.styQuant, 1, "+Q" + p.qManipLow + "M " + tf);
                line("qdu" + n, x1, x2, L.qDu, p.colQuant, p.styQuant, 1, "+Q" + p.qDistHigh + "D " + tf);
                line("qdd" + n, x1, x2, L.qDd, p.colQuant, p.styQuant, 1, "-Q" + p.qDistLow + "D " + tf);
            }
            if (p.showShading) {
                shade("su" + n, x1, x2, L.Mu, L.mMu, col); shade("sd" + n, x1, x2, L.Md, L.mMd, col);
                shade("tu" + n, x1, x2, L.Du, L.mDu, col); shade("td" + n, x1, x2, L.Dd, L.mDd, col);
            }
            // prior candle's untested levels
            const P = T.cur && T.cur.key !== key ? T.cur : T.prior;
            if (p.showPrior && P && P.lv) {
                for (const [lv, up, nm] of [["Mu", true, "-M"], ["Md", false, "+M"], ["Du", true, "+D"], ["Dd", false, "-D"]]) {
                    const untested = up ? P.h < P.lv[lv] : P.l > P.lv[lv];
                    if (untested) line("p" + lv + n, P.bi, x2, P.lv[lv], p.colPrior, "Dashed", 1, "prior " + nm + " " + tf);
                }
            }
            // hit-rate panel rows
            const s = T.stats, now = (lv, up) => (up ? C.h >= L[lv] : C.l <= L[lv]) ? "✓" : "·";
            panel.push([tf + " (" + s.Mu.length + " candles)", pct(s.Mu), pct(s.Md), pct(s.Du), pct(s.Dd), pct(s.eitherM), pct(s.bothM),
                pct(s.prior) + " (" + s.prior.length + ")", now("Mu", true) + now("Md", false) + now("Du", true) + now("Dd", false)]);
        });
        if (p.showPanel && panel.length) {
            const pad = (x, w) => { x = String(x); return x.length >= w ? x.slice(0, w) : x + " ".repeat(w - x.length); };
            const rows = [pad("TF", 18) + pad("-M", 6) + pad("+M", 6) + pad("+D", 6) + pad("-D", 6) + pad("either M", 10) + pad("both M", 8) + pad("prior untested", 16) + "now"]
                .concat(panel.map(r => pad(r[0], 18) + pad(r[1], 6) + pad(r[2], 6) + pad(r[3], 6) + pad(r[4], 6) + pad(r[5], 10) + pad(r[6], 8) + pad(r[7], 16) + r[8]));
            rows.push("hit rate = level reached inside its own candle; prior = prior candle's unreached levels hit in the next one");
            rows.forEach((t, k2) => items.push({ tag: "Text", key: "P" + k2, global: true, origin: { cs: "frame", h: p.panelLeft ? "left" : "right", v: p.panelTop ? "top" : "bottom" },
                point: { x: px(p.panelLeft ? 10 : -10), y: px(p.panelTop ? 14 + k2 * (p.panelFont + 5) : -(14 + (rows.length - 1 - k2) * (p.panelFont + 5))) },
                text: t, style: { fontSize: p.panelFont, fill: k2 === 0 ? p.colPanelHead : p.colPanel, fontFamily: "monospace, Courier New" },
                textAlignment: p.panelLeft ? "rightMiddle" : "leftMiddle" }));
        }
        return items;
    }
}

const S = predef.paramSpecs;
const TFO = { None: "None", "1H": "1H", "4H": "4H", "1D": "1D (18:00-17:00)", "1W": "1W", "1M": "1M" };
const STY = { Solid: "Solid", Dashed: "Dashed", Dotted: "Dotted" };

module.exports = {
    name: "statmapHTF",
    description: "OHLC StatMap (Multi-Timeframe)",
    calculator: StatmapHTF,
    inputType: "bars",
    areaChoice: "overlay",
    tags: ["Custom"],
    params: {
        tf1: S.enum(TFO, "4H"), col1: S.color("#ff5252"), tf2: S.enum(TFO, "None"), col2: S.color("#448aff"),
        tf3: S.enum(TFO, "None"), col3: S.color("#ffab40"), tf4: S.enum(TFO, "None"), col4: S.color("#69f0ae"),
        histCandles: S.number(60, 1, 1), likeForLike: S.bool(false), showPrior: S.bool(true), colPrior: S.color("#9e9e9e"),
        useQuantiles: S.bool(true), qManipLow: S.number(25, 5, 0), qManipHigh: S.number(75, 5, 0), qDistLow: S.number(25, 5, 0), qDistHigh: S.number(75, 5, 0),
        colQuant: S.color("#b388ff"), styQuant: S.enum(STY, "Dashed"),
        showAnchor: S.bool(true), colAnchor: S.color("#9e9e9e"),
        showOpen: S.bool(true), colOpen: S.color("#bdbdbd"), styOpen: S.enum(STY, "Dotted"),
        showManip: S.bool(true), styManip: S.enum(STY, "Dotted"), showDist: S.bool(true), styDist: S.enum(STY, "Dotted"), width: S.number(1, 1, 1),
        showMedian: S.bool(true), colMedian: S.color("#757575"), styMedian: S.enum(STY, "Dotted"),
        showAvgHL: S.bool(true), colAvgHL: S.color("#26a69a"), styAvgHL: S.enum(STY, "Dashed"),
        showShading: S.bool(true), shadeOpacity: S.number(0.12, 0.02, 0),
        projOffset: S.number(24, 1, 0), extendToNow: S.bool(true), showLabels: S.bool(true), fontSize: S.number(10, 1, 6),
        showPanel: S.bool(true), statN: S.number(250, 10, 10), panelLeft: S.bool(false), panelTop: S.bool(false), panelFont: S.number(11, 1, 6),
        colPanel: S.color("#d1d4dc"), colPanelHead: S.color("#ffb300"),
    },
};
