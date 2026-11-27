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
   **Session Statmap carries its own history:** the preset sessions (Asia, London, NY RTH, NY Futures,
   Midnight-5pm, Globex Day 18:00-16:00, and custom sessions with the same times) include the last 300 NQ
   sessions built in, so the levels are right even when Tradovate loads only a few days. The built-in
   history is **NQ only** (used on NQ and MNQ charts); on any other product the indicator uses the chart's
   own history. Newer sessions on
   the chart are added on top automatically. Set *Stats Source* to "Chart history only" to ignore it. The
   built-in history is refreshed with `dev/build_session_history.py` (see the top of that file). The chart
   has to reach back to where the built-in history ends; if it doesn't (e.g. a chart that loads 3 days and a
   built-in history a week old), the panel says which dates are missing - refresh the history and re-paste.
   **Otherwise the Statmaps draw no levels until at least one full session / candle has finished inside the
   loaded history.** Their panel shows "Chart bars loaded ... sessions found ..." so you can see what they have;
   if it says 0, scroll the chart left (Tradovate loads more history as you scroll) and the levels appear.
5. Session Statmap, **Custom** session: set *Start Hour / Start Minute / End Hour / End Minute*
   (New York time, 24-hour clock, e.g. 9 / 30 / 11 / 0 for 09:30-11:00; overnight sessions like
   20:00-02:00 work). The hour boxes also accept HHMM, so Start Hour 1800 and End Hour 1600 means
   18:00-16:00.
6. **After pasting an updated version over an indicator that's already on a chart**, check its settings:
   Tradovate keeps the old saved values, and inputs that are new in the update may start blank. The
   indicators fall back to the defaults for blank inputs, so set the new ones (or remove and re-add the
   indicator).

## If something doesn't draw: `dev/Layout_Test.js`
A small diagnostic indicator. Load it like the others and send a screenshot: it shows which text
alignments are readable in each corner, whether lines anchored by bar index draw, how many bars the
indicator received (with first/last bar time), and whether a text-type setting appears in the settings
dialog. Tradovate's documentation doesn't pin these down, so this is the quickest way to check them on
your setup.

## How these differ from the Pine versions
- Tradovate indicators only see the chart's own bars, so higher-timeframe candles (5m/15m/60m FVG bars,
  1H/4H/1D/1W/1M Statmap candles) are built from the chart's bars. FVG bars are clock-aligned like
  TradingView's; Statmap candles are anchored at 18:00 New York like TradingView's CME candles.
- All times are New York; daylight saving is computed in the code, so the chart's timezone setting
  does not matter.
- Tradovate has no table object: tables are drawn as monospace text panels pinned to a chart corner.
  In Tradovate's text alignment, `rightMiddle` places the text to the *right* of its anchor point and
  `leftMiddle` to the *left* (the first versions had this backwards, which pushed the right-hand panels
  off the chart under the price scale - fixed).
- Drawings are recalculated on each new bar and refreshed on the forming bar; levels from the forming
  bar's own high/low appear once that bar closes.
- FVG indicator: the per-chart learned RETEST / DEPTH / THROUGH columns are not ported; the panel shows
  the NQ reference figures by distance band (what the Pine shows until its own sample fills), marked "·".
  Not ported either: HTF moving averages (MAs use the chart timeframe), previous-year H/L, the 9 extra
  MA types (EMA / SMA / WMA / RMA kept), alerts.
- Statmap Session: checked against TradingView (Asia session, 75 sessions, NQ 5m, 27 Nov 2026): every level
  within a point or two, bullish/bearish counts identical, and the "% Session Closes Above/Below" rows
  identical (29.33 / 38.67 / 16.00 / 20.00) once the history starts where TradingView's does. Those four
  rows use the Pine's running counts, which depend on where the chart's history starts - so they can differ
  from TradingView if Tradovate has loaded more or less history. The levels don't have this issue: they
  only use the last N sessions, but **N sessions must be loaded** (the panel warns when fewer are).
  The Pine's "Auto" session is reproduced as written: its first
  test (00:00-17:00) catches every daytime hour, so Auto never selects London / NY - pick the session.
- Added (switch off to match the Pine): prior candle / session untested levels; hit-rate rows;
  `likeForLike` (HTF lookback of the same slot only, off by default = Pine behaviour); `extendToNow`
  (lines run to the current bar rather than stopping 24 bars after the candle start).

## Checked
`dev/harness.js` runs an indicator outside Tradovate (stubs for Tradovate's `tools/graphics`, real
`tools/predef` from github.com/tradovate/custom-indicators). On NQ 1-minute and 15-minute bars Oct-Nov 2026 all three
run without errors (< 0.3 s for 54k bars) and the FVG engine finds exactly the same 5m/15m/60m gaps as
the Python port of the Pine engine used in the research.
