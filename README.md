# Tradovate ports

| File | Ported from | What it draws |
|---|---|---|
| `FVG_IFVG_KeyLevels.js` | FVG · IFVG · Key Liquidity Levels (Pine v6) | 5m / 15m / 60m FVG + IFVG zones, PDH/PDL, PWH/PWL, PMH/PML, Asia / London H/L, daily + weekly open, NDOG / NWOG, daily + weekly VWAP, prev-day VWAP, 3 MAs, impulse candles, sweep stamps, zone panel |
| `Statmap_HTF.js` | Statmap HTF no like for like lookback (Pine v6) | Up to 4 timeframes (1H, 4H, 1D, 1W, 1M): open, ±M / ±D (mean), medians, quantile bands, avg high/low, shading; plus prior candle's untested levels and a hit-rate panel |
| `Statmap_Session.js` | Session Based Statmap with closing stats (Pine v5) | One session per instance: open, ±M / ±D, medians, expansion mean/median, shading, session-start marker, stats panel; plus prior session's untested levels and hit rates |

## Install
1. In Tradovate open **Code Explorer** (Settings / the `</>` icon), create a new indicator, paste one file, save.
2. Add it to a chart from the indicator list (tag "Custom").
3. Use a **1-minute** chart for the FVG indicator (any chart whose bar size divides 5 / 15 / 60 min works).
   The Statmaps work on 1-minute to 15-minute charts.
4. Load enough history: the FVG percentiles need ~40 zones per timeframe, the 200 EMA ~200 bars,
   Statmap lookbacks N candles of the chosen timeframe (60 x 4H = ~10 trading days of 1m bars).

## How these differ from the Pine versions
- Tradovate indicators only see the chart's own bars, so higher-timeframe candles (5m/15m/60m FVG bars,
  1H/4H/1D/1W/1M Statmap candles) are built from the chart's bars. FVG bars are clock-aligned like
  TradingView's; Statmap candles are anchored at 18:00 New York like TradingView's CME candles.
- All times are New York; daylight saving is computed in the code, so the chart's timezone setting
  does not matter.
- Tradovate has no table object: tables are drawn as monospace text panels pinned to a chart corner.
- Drawings are recalculated on each new bar and refreshed on the forming bar; levels from the forming
  bar's own high/low appear once that bar closes.
- FVG indicator: the per-chart learned RETEST / DEPTH / THROUGH columns are not ported; the panel shows
  the NQ reference figures by distance band (what the Pine shows until its own sample fills), marked "·".
  Not ported either: HTF moving averages (MAs use the chart timeframe), previous-year H/L, the 9 extra
  MA types (EMA / SMA / WMA / RMA kept), alerts.
- Statmap Session: "% Session Closes Above/Below" is computed against the CURRENT mean levels over all
  stored sessions (the Pine updates its counts incrementally with the mean at each session's end, so
  the two can differ by a few percent). The Pine's "Auto" session is reproduced as written: its first
  test (00:00-17:00) catches every daytime hour, so Auto never selects London / NY - pick the session.
- Added (switch off to match the Pine): prior candle / session untested levels; hit-rate rows;
  `likeForLike` (HTF lookback of the same slot only, off by default = Pine behaviour); `extendToNow`
  (lines run to the current bar rather than stopping 24 bars after the candle start).

## Checked
`dev/harness.js` runs an indicator outside Tradovate (stubs for Tradovate's `tools/graphics`, real
`tools/predef` from github.com/tradovate/custom-indicators). On NQ 1-minute bars Oct-Nov 2026 all three
run without errors (< 0.3 s for 54k bars) and the FVG engine finds exactly the same 5m/15m/60m gaps as
the Python port of the Pine engine used in the research.
