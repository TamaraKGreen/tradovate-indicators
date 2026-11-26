// Minimal stand-in for Tradovate's runtime: init(), props from param defaults, map(d, i, series) bar by bar.
const path = require("path"), fs = require("fs");
const file = process.argv[2], overrides = JSON.parse(process.argv[3] || "{}");
const src = fs.readFileSync(file, "utf8");
const Module = require("module");
const m = new Module(file, module); m.paths = [path.join(__dirname, "node_modules")];
m.filename = path.join(__dirname, "indicator.js");            // so require("./tools/...") resolves here
m._compile(src, m.filename);
const ind = m.exports;
const bars = JSON.parse(fs.readFileSync(path.join(__dirname, "bars.json")));
const ents = bars.map(([t, o, h, l, c, v], i) => ({ timestamp: () => new Date(t), open: () => o, high: () => h, low: () => l, close: () => c, volume: () => v, value: () => c, index: () => i }));
const series = { data: ents, size: () => ents.length, get: i => ents[i], last: () => ents[ents.length - 1] };
const calc = new ind.calculator();
calc.props = {}; for (const [k, s] of Object.entries(ind.params)) calc.props[k] = s.def; Object.assign(calc.props, overrides);
calc.contractInfo = { tickSize: 0.25 };
calc.init();
let last, plotsSeen = {}, t0 = Date.now();
for (let i = 0; i < ents.length; i++) {
    const r = calc.map(ents[i], i, series);
    if (r) for (const k of Object.keys(r)) if (k !== "graphics" && r[k] !== undefined) plotsSeen[k] = (plotsSeen[k] || 0) + 1;
    if (i === ents.length - 1) last = r;
}
// simulate a few live ticks on the last bar (map called again for the same index)
for (let k = 0; k < 3; k++) last = calc.map(ents[ents.length - 1], ents.length - 1, series);
const items = (last.graphics && last.graphics.items) || [];
const tags = {}; items.forEach(x => tags[x.tag] = (tags[x.tag] || 0) + 1);
const keys = items.map(x => x.key); const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
console.log(`${ind.name}: ${ents.length} bars in ${Date.now() - t0} ms | plots non-empty: ${JSON.stringify(plotsSeen)}`);
console.log("graphics:", JSON.stringify(tags), "| duplicate keys:", dup.length);
items.filter(x => x.tag === "Text").map(x => x.text).forEach(t => console.log("  ", t));
fs.writeFileSync(path.join(__dirname, ind.name + "_state.json"), JSON.stringify(calc.slots ? calc.slots.map(s => ({ tf: s.tf, gaps: s.st.length })) : {}, null, 0));
