// Layout test for Tradovate custom indicators - load it once on any chart, take a screenshot, and it answers:
//   1. how text alignment behaves at each corner of the chart (which labels are fully visible)
//   2. whether horizontal lines anchored by bar index draw (two lines ending at the last bar)
//   3. how much history the indicator receives (bars loaded, first / last bar time in New York time)
//   4. whether a "text" setting shows up in the settings dialog (look for "Text Setting")
// Nothing here is used by the real indicators; it's only for checking how Tradovate renders.

const predef = require("./tools/predef");
const { du, op, px } = require("./tools/graphics");

function nthSundayUTC(y, m, n) { const f = new Date(Date.UTC(y, m, 1)).getUTCDay(); return 1 + ((7 - f) % 7) + 7 * (n - 1); }
function nyOffsetH(ms) {
    const y = new Date(ms).getUTCFullYear();
    return ms >= Date.UTC(y, 2, nthSundayUTC(y, 2, 2), 7) && ms < Date.UTC(y, 10, nthSundayUTC(y, 10, 1), 6) ? -4 : -5;
}
function nyStr(ms) {
    const t = new Date(ms + nyOffsetH(ms) * 3600000);
    const z = n => String(n).padStart(2, "0");
    return t.getUTCFullYear() + "-" + z(t.getUTCMonth() + 1) + "-" + z(t.getUTCDate()) + " " + z(t.getUTCHours()) + ":" + z(t.getUTCMinutes()) + " NY";
}

class LayoutTest {
    init() { this.first = null; }

    map(d, index, series) {
        if (this.first === null) this.first = d.timestamp().getTime();
        if (index !== series.size() - 1) return {};
        const items = [], fs = this.props.fontSize;
        const di = typeof d.index === "function" ? d.index() : "n/a";

        // 1. corner alignment test: at each corner, one label per alignment. Report which ones you can read.
        const corners = [["TL", "left", "top", 10, 30], ["TR", "right", "top", -10, 30], ["BL", "left", "bottom", 10, -30], ["BR", "right", "bottom", -10, -30]];
        corners.forEach(([nm, h, v, x, y]) => {
            ["leftMiddle", "rightMiddle"].forEach((al, k) => items.push({
                tag: "Text", key: "c" + nm + k, global: true, origin: { cs: "frame", h, v },
                point: { x: px(x), y: px(y + (v === "top" ? 1 : -1) * k * (fs + 8)) },
                text: nm + " " + al + " <-->", style: { fontSize: fs, fill: k ? "#4fc3f7" : "#ffb74d", fontFamily: "monospace, Courier New" },
                textAlignment: al }));
        });

        // 2. lines ending at the last bar, anchored by the map index and by d.index()
        const c = d.close(), tick = (this.contractInfo && this.contractInfo.tickSize) || 0.25;
        const hline = (key, x1, x2, y, col, label) => {
            items.push({ tag: "LineSegments", key: "L" + key, global: true, lines: [{ tag: "Line", a: { x: du(x1), y: du(y) }, b: { x: du(x2), y: du(y) } }],
                lineStyle: { lineWidth: 2, color: col } });
            items.push({ tag: "Text", key: "T" + key, global: true, point: { x: du(x2), y: du(y) }, text: "  " + label,
                style: { fontSize: fs, fill: col }, textAlignment: "rightMiddle" });
        };
        hline("a", index - 40, index, c + 20 * tick, "#ffee58", "A: 40 bars back, map index");
        if (typeof d.index === "function") hline("b", di - 40, di, c - 20 * tick, "#ab47bc", "B: 40 bars back, d.index()");

        // 3. diagnostics, top-left under the corner labels
        const rows = [
            "bars loaded (series.size): " + series.size() + "    map index: " + index + "    d.index(): " + di,
            "first bar: " + nyStr(this.first) + "    last bar: " + nyStr(d.timestamp().getTime()),
            "tick size: " + tick + "    text setting value: '" + this.props.textSetting + "'",
        ];
        rows.forEach((t, k) => items.push({ tag: "Text", key: "D" + k, global: true, origin: { cs: "frame", h: "left", v: "top" },
            point: { x: px(10), y: px(30 + 2 * (fs + 8) + 10 + k * (fs + 8)) }, text: t,
            style: { fontSize: fs, fill: "#e0e0e0", fontFamily: "monospace, Courier New" }, textAlignment: "rightMiddle" }));
        return { graphics: { items } };
    }
}

module.exports = {
    name: "layoutTest",
    description: "Layout Test (diagnostic)",
    calculator: LayoutTest,
    inputType: "bars",
    areaChoice: "overlay",
    tags: ["Custom"],
    params: {
        fontSize: predef.paramSpecs.number(12, 1, 6),
        textSetting: predef.paramSpecs.text("hello"),
    },
};
