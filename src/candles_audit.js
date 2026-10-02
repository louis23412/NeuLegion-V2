// candles_audit.js
//
// Pure integrity auditing for the shipped candle streams plus the manifest of
// files the legion ships with. `candle_fetcher.js` is the *acquisition* toolkit
// (URL building, pagination, merge/dedupe); this module is the complementary
// *verification* toolkit: it takes an already-parsed series and proves the
// invariants the legion relies on.
//
// Why a separate module: the shipped JSONL files are large (tens of MB, ~570k
// rows in total) and are the only data the model ever sees, so they deserve a
// dedicated, network-free, fs-free audit that can be run both in the browser
// harness (reading through `globalThis.__fs`) and in the node suite (reading a
// real filesystem). Nothing here touches fs or the network — callers parse the
// JSONL with `parseCandlesJsonl` and pass the candles in.
//
// The invariants checked are the ones a bad merge/edit would break silently:
//   * exactly the manifest's files exist (adding/removing data is deliberate);
//   * every row is a finite, positive OHLCV candle with high >= low and
//     high >= body, low <= body;
//   * timestamps strictly increase, are unique, and are aligned to the
//     interval grid;
//   * no still-forming bar is stored (a partial bar would leak into training);
//   * historical gaps stay under a budget (exchange outages are expected, a
//     corrupted file is not);
//   * separately-listed series from the same exchange/interval (BTC/ETH on
//     Binance) share an identical timestamp grid — the strongest cross-file
//     consistency check available.

export const HOUR_MS = 3_600_000;
export const QUARTER_HOUR_MS = 900_000;

// Canonical list of the candle files that ship with the project. `minRows` is a
// floor, not an exact count: the incremental updater appends rows over time, so
// the audit asserts "at least this much history", never equality. `assets`
// groups files that must share a timestamp grid (same venue + same interval).
export const CANDLE_MANIFEST = Object.freeze([
    { symbol: 'BTCUSDT', interval: '1h', file: 'src/candles.jsonl', minRows: 78_000, group: 'binance-1h' },
    { symbol: 'ETHUSDT', interval: '1h', file: 'src/data/candles_ethusdt_1h.jsonl', minRows: 78_000, group: 'binance-1h' },
    { symbol: 'SOLUSDT', interval: '1h', file: 'src/data/candles_solusdt_1h.jsonl', minRows: 52_000, group: 'binance-1h' },
    { symbol: 'BNBUSDT', interval: '1h', file: 'src/data/candles_bnbusdt_1h.jsonl', minRows: 75_000, group: 'binance-1h' },
    { symbol: 'XRPUSDT', interval: '1h', file: 'src/data/candles_xrpusdt_1h.jsonl', minRows: 71_000, group: 'binance-1h' },
    { symbol: 'ADAUSDT', interval: '1h', file: 'src/data/candles_adausdt_1h.jsonl', minRows: 71_000, group: 'binance-1h' },
    { symbol: 'DOGEUSDT', interval: '1h', file: 'src/data/candles_dogeusdt_1h.jsonl', minRows: 61_000, group: 'binance-1h' },
    { symbol: 'LINKUSDT', interval: '1h', file: 'src/data/candles_linkusdt_1h.jsonl', minRows: 65_000, group: 'binance-1h' },
]);

// The 15-minute basket (round 29 -> 30, P3). The same venue and the same eight
// symbols as the 1h basket, at a *genuinely different horizon* — `METHOD.md`
// §5: a really independent stream needs a new data source or a new bar interval,
// and 15m is the horizon where the documented crypto reversal (`2608.21888`)
// lives. It is a SEPARATE manifest on purpose: every row is on a 15m grid, so an
// audit of these files must pass `intervalMs: QUARTER_HOUR_MS` (the 1h basket's
// interval-blind checks, e.g. the `CANDLE_FILES` sweep in `candles.test.js`,
// would report every row misaligned). Keeping it separate also leaves the shipped
// 1h basket and `--symbols=all` exactly as they were; a 15m run addresses these
// files by path (`--files=` / `runAnalysis({files})`).
export const CANDLE_MANIFEST_15M = Object.freeze([
    { symbol: 'BTCUSDT', interval: '15m', file: 'src/data/candles_btcusdt_15m.jsonl', minRows: 70_000, group: 'binance-15m' },
    { symbol: 'ETHUSDT', interval: '15m', file: 'src/data/candles_ethusdt_15m.jsonl', minRows: 70_000, group: 'binance-15m' },
    { symbol: 'SOLUSDT', interval: '15m', file: 'src/data/candles_solusdt_15m.jsonl', minRows: 70_000, group: 'binance-15m' },
    { symbol: 'BNBUSDT', interval: '15m', file: 'src/data/candles_bnbusdt_15m.jsonl', minRows: 70_000, group: 'binance-15m' },
    { symbol: 'XRPUSDT', interval: '15m', file: 'src/data/candles_xrpusdt_15m.jsonl', minRows: 70_000, group: 'binance-15m' },
    { symbol: 'ADAUSDT', interval: '15m', file: 'src/data/candles_adausdt_15m.jsonl', minRows: 70_000, group: 'binance-15m' },
    { symbol: 'DOGEUSDT', interval: '15m', file: 'src/data/candles_dogeusdt_15m.jsonl', minRows: 70_000, group: 'binance-15m' },
    { symbol: 'LINKUSDT', interval: '15m', file: 'src/data/candles_linkusdt_15m.jsonl', minRows: 70_000, group: 'binance-15m' },
]);

export const CANDLE_FILES = Object.freeze(CANDLE_MANIFEST.map((entry) => entry.file));

export const CANDLE_FILES_15M = Object.freeze(CANDLE_MANIFEST_15M.map((entry) => entry.file));

// The funding/carry baskets (round 29 -> 30, P4). Binance perpetual FUNDING RATES
// (`fapi/v1/fundingRate`, the same venue the candle fetcher uses), one row per
// funding period. This is a genuinely independent data source — the delta-neutral
// short-perp/long-spot return is not the price return — which is why it is the one
// lever the design effect responds to (`METHOD.md` §5). Parsed/audited/built by
// `analysis/carry.js`; the files are POSITIONALLY matched to the candle basket.
export const FUNDING_MANIFEST = Object.freeze([
    { symbol: 'BTCUSDT', interval: '8h', file: 'src/data/funding_btcusdt_8h.jsonl', minRows: 5_000, group: 'binance-funding' },
    { symbol: 'ETHUSDT', interval: '8h', file: 'src/data/funding_ethusdt_8h.jsonl', minRows: 5_000, group: 'binance-funding' },
    { symbol: 'SOLUSDT', interval: '8h', file: 'src/data/funding_solusdt_8h.jsonl', minRows: 5_000, group: 'binance-funding' },
    { symbol: 'BNBUSDT', interval: '8h', file: 'src/data/funding_bnbusdt_8h.jsonl', minRows: 5_000, group: 'binance-funding' },
    { symbol: 'XRPUSDT', interval: '8h', file: 'src/data/funding_xrpusdt_8h.jsonl', minRows: 5_000, group: 'binance-funding' },
    { symbol: 'ADAUSDT', interval: '8h', file: 'src/data/funding_adausdt_8h.jsonl', minRows: 5_000, group: 'binance-funding' },
    { symbol: 'DOGEUSDT', interval: '8h', file: 'src/data/funding_dogeusdt_8h.jsonl', minRows: 5_000, group: 'binance-funding' },
    { symbol: 'LINKUSDT', interval: '8h', file: 'src/data/funding_linkusdt_8h.jsonl', minRows: 5_000, group: 'binance-funding' },
]);

export const FUNDING_FILES = Object.freeze(FUNDING_MANIFEST.map((entry) => entry.file));

// A gap budget: legitimate exchange downtime exists (Binance has had a handful
// of multi-hour outages since 2017), but it must stay a rounding error. Expressed
// as a fraction of the whole series so it is robust to series length.
export const MAX_MISSING_FRACTION = 0.01;

// Audits one parsed series (epoch-ms timestamps, as produced by
// `parseCandlesJsonl`). Returns a plain report object; never throws on bad data
// (bad data is what is being measured), only on a non-array argument.
export function auditSeries(candles, { intervalMs = HOUR_MS, now = Date.now() } = {}) {
    if (!Array.isArray(candles)) throw new Error('auditSeries: candles must be an array');
    const count = candles.length;

    let badNumeric = 0;
    let badOHLC = 0;
    let nonMonotonic = 0;
    let duplicates = 0;
    let misaligned = 0;
    let unclosed = 0;
    let zeroVolumeRows = 0;
    let minLow = Infinity;
    let maxHigh = -Infinity;
    let maxAbsReturn = 0;
    let maxVolume = 0;
    const seen = new Set();

    for (let i = 0; i < count; i++) {
        const c = candles[i];
        const values = [c.timestamp, c.open, c.high, c.low, c.close, c.volume];
        if (!values.every((n) => typeof n === 'number' && Number.isFinite(n))) badNumeric++;
        if (!(c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 && c.volume >= 0)) badNumeric++;
        if (c.high < c.low || c.high < c.open || c.high < c.close || c.low > c.open || c.low > c.close) badOHLC++;
        if (c.volume === 0) zeroVolumeRows++;
        if (c.timestamp + intervalMs > now) unclosed++;
        if (c.timestamp % intervalMs !== 0) misaligned++;

        if (c.low < minLow) minLow = c.low;
        if (c.high > maxHigh) maxHigh = c.high;
        if (c.volume > maxVolume) maxVolume = c.volume;

        if (seen.has(c.timestamp)) duplicates++;
        else seen.add(c.timestamp);

        if (i > 0) {
            const prev = candles[i - 1];
            if (c.timestamp <= prev.timestamp) nonMonotonic++;
            if (prev.close > 0) {
                const ret = Math.abs(c.close / prev.close - 1);
                if (ret > maxAbsReturn) maxAbsReturn = ret;
            }
        }
    }

    // Gap analysis over the union span (only meaningful when timestamps are
    // monotonic and on-grid; the report exposes the flags so callers can decide).
    let missingCandles = 0;
    let gaps = 0;
    let maxGapMissing = 0;
    if (count > 1 && nonMonotonic === 0) {
        const span = Math.round((candles[count - 1].timestamp - candles[0].timestamp) / intervalMs) + 1;
        missingCandles = Math.max(0, span - count);
        for (let i = 1; i < count; i++) {
            const step = Math.round((candles[i].timestamp - candles[i - 1].timestamp) / intervalMs) - 1;
            if (step > 0) {
                gaps++;
                if (step > maxGapMissing) maxGapMissing = step;
            }
        }
    }

    return {
        count,
        first: count ? candles[0].timestamp : null,
        last: count ? candles[count - 1].timestamp : null,
        spanDays: count > 1 ? (candles[count - 1].timestamp - candles[0].timestamp) / 86_400_000 : 0,
        badNumeric,
        badOHLC,
        nonMonotonic,
        duplicates,
        misaligned,
        unclosed,
        zeroVolumeRows,
        minLow: Number.isFinite(minLow) ? minLow : null,
        maxHigh: Number.isFinite(maxHigh) ? maxHigh : null,
        maxAbsReturn,
        maxVolume,
        gaps,
        missingCandles,
        maxGapMissing,
        missingFraction: count > 0 ? missingCandles / count : 0,
    };
}

// Asserts a report satisfies the invariants above. Kept here (not in the test)
// so the browser entry and the node mirror share one definition of "healthy".
export function auditProblems(report, { intervalLabel = 'series', maxMissingFraction = MAX_MISSING_FRACTION } = {}) {
    const problems = [];
    if (report.count === 0) problems.push(`${intervalLabel}: no candles`);
    if (report.badNumeric) problems.push(`${intervalLabel}: ${report.badNumeric} non-finite/non-positive row(s)`);
    if (report.badOHLC) problems.push(`${intervalLabel}: ${report.badOHLC} OHLC-inconsistent row(s)`);
    if (report.nonMonotonic) problems.push(`${intervalLabel}: ${report.nonMonotonic} non-increasing timestamp(s)`);
    if (report.duplicates) problems.push(`${intervalLabel}: ${report.duplicates} duplicate timestamp(s)`);
    if (report.misaligned) problems.push(`${intervalLabel}: ${report.misaligned} off-grid timestamp(s)`);
    if (report.unclosed) problems.push(`${intervalLabel}: ${report.unclosed} still-forming bar(s)`);
    if (report.missingFraction > maxMissingFraction) {
        problems.push(`${intervalLabel}: missing fraction ${(report.missingFraction * 100).toFixed(3)}% > ${(maxMissingFraction * 100).toFixed(1)}%`);
    }
    return problems;
}
