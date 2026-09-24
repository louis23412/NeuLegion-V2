// The funding/basis CARRY sleeve (round 29 -> 30, P4).
//
// `1912.03270` (funding is Granger-causal with price and heteroskedastic),
// `2506.08573` (funding is a carry return) and `2605.06405` (the perpetual's
// funding is a first-class market driver) are the literature basis; `METHOD.md`
// §5 is the reason it matters here: the shipped basket's eight price streams are
// one factor wearing eight hats (design effect 5.5x, ~1.26 effective streams of
// 8 on the 15m grid), and the ONLY way to buy real independence is a new data
// source. The perpetual funding rate is such a source: the delta-neutral book
// (short perp / long spot) is paid `+fundingRate` every funding period, and that
// return is *structurally* not the price return.
//
// This module is deliberately pure and network-free: the caller fetches the
// funding JSONL (Binance `fapi/v1/fundingRate`, the same venue the candle fetcher
// uses) and hands the parsed rows in. The measured numbers for this basket live in
// `docs/RUN-ANALYSIS.md` §16.5.
//
// Sign convention: a POSITIVE funding rate means longs pay shorts, so the
// short-perp/long-spot book EARNS `+rate` per period. `signFlip: true` inverts the
// sleeve (long perp / short spot), i.e. it pays the funding — the plan's
// "sign-flipped variant", retained because a negative-funding regime is a real
// regime (mean funding has been negative for whole quarters).

// Binance's standard funding interval. Some symbols have run 4h funding periods
// (`intervalHistogram` in the audit reports them), so the audit tolerates both and
// the bar-grid projection divides by the period actually observed.
export const FUNDING_GRID_MS = 28_800_000;
export const FUNDING_PER_YEAR = 365 * 3;      // 8h periods in a year
// Binance's few-millisecond jitter on `fundingTime` (e.g. ...:00.004Z).
const GRID_TOLERANCE_MS = 5000;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Timestamps arrive in two shapes: epoch ms (what `parseFundingJsonl` produces) and
// the ISO strings the shipped JSONL files store (e.g. `"2026-09-24T08:00:00.000Z"`).
// `readCandles` in `analyze.js` passes the raw candle `timestamp` through unchanged,
// so a comparison between the two would be `number <= "ISO"` — always false, i.e. a
// silently all-zero sleeve. Normalise to epoch ms at the comparison site.
const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t));

// Parses the funding JSONL written by the fetcher. Unparseable lines are COUNTED,
// never thrown (a partially-written file must still load).
export function parseFundingJsonl(text) {
    const rows = [];
    let invalid = 0;
    let blank = 0;
    for (const line of String(text).split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') { blank += 1; continue; }
        let parsed;
        try { parsed = JSON.parse(trimmed); } catch { invalid += 1; continue; }
        const timestamp = typeof parsed.timestamp === 'number' ? parsed.timestamp : Date.parse(parsed.timestamp);
        const fundingRate = Number(parsed.fundingRate);
        const markPrice = parsed.markPrice == null ? null : Number(parsed.markPrice);
        if (!finite(timestamp) || !finite(fundingRate)) { invalid += 1; continue; }
        rows.push({ timestamp, fundingRate, markPrice: finite(markPrice) ? markPrice : null });
    }
    rows.sort((a, b) => a.timestamp - b.timestamp);
    return { rows, invalid, blank };
}

// Audits a parsed funding series on the funding grid. Same contract as
// `auditSeries` for candles: it measures, it never throws.
export function auditFundingSeries(rows, { gridMs = FUNDING_GRID_MS, maxAbsRate = 0.01, now = Date.now() } = {}) {
    if (!Array.isArray(rows)) throw new Error('auditFundingSeries: rows must be an array');
    const count = rows.length;
    const intervalHistogram = {};
    let offGrid = 0;
    let missingPeriods = 0;
    let extremeRates = 0;
    let zeroRates = 0;
    let unclosed = 0;
    let nonMonotonic = 0;
    let sum = 0;
    let sumAbs = 0;
    let negative = 0;
    for (let i = 0; i < count; i++) {
        const r = rows[i];
        if (r.fundingRate === 0) zeroRates += 1;
        if (Math.abs(r.fundingRate) > maxAbsRate) extremeRates += 1;
        // A funding row is REALIZED at its own timestamp — the exchange charges the
        // rate then, so there is no "bar covering [t, t+interval)" to wait for (unlike
        // a candle). A still-forming period would therefore be a row dated in the
        // FUTURE; a row dated in the past is complete by definition.
        if (r.timestamp > now) unclosed += 1;
        sum += r.fundingRate;
        sumAbs += Math.abs(r.fundingRate);
        if (r.fundingRate < 0) negative += 1;
        if (i > 0) {
            const dt = r.timestamp - rows[i - 1].timestamp;
            if (dt <= 0) nonMonotonic += 1;
            const k = Math.round(dt / (gridMs / 2));           // halves: 4h or 8h
            const key = `${k * (gridMs / 2) / 3_600_000}h`;
            const off = Math.abs(dt - k * (gridMs / 2));
            if (off > GRID_TOLERANCE_MS) offGrid += 1;
            else intervalHistogram[key] = (intervalHistogram[key] || 0) + 1;
            // a step longer than one full period means the exchange published
            // nothing for that period (a real gap, not jitter)
            if (dt > gridMs + GRID_TOLERANCE_MS) missingPeriods += Math.round(dt / gridMs) - 1;
        }
    }
    return {
        count,
        first: count ? rows[0].timestamp : null,
        last: count ? rows[count - 1].timestamp : null,
        spanDays: count > 1 ? (rows[count - 1].timestamp - rows[0].timestamp) / 86_400_000 : 0,
        intervalHistogram,
        offGrid,
        missingPeriods,
        extremeRates,
        zeroRates,
        unclosed,
        nonMonotonic,
        meanRate: count ? sum / count : NaN,
        meanAbsRate: count ? sumAbs / count : NaN,
        negativeFraction: count ? negative / count : NaN,
    };
}

// The reasons a funding series cannot be used (empty when healthy).
export function auditFundingProblems(report, { label = 'funding', maxOffGridFraction = 0.02 } = {}) {
    const problems = [];
    if (report.count === 0) problems.push(`${label}: no funding rows`);
    if (report.nonMonotonic) problems.push(`${label}: ${report.nonMonotonic} non-increasing timestamp(s)`);
    if (report.unclosed) problems.push(`${label}: ${report.unclosed} still-forming period(s)`);
    if (report.count > 1 && report.offGrid / (report.count - 1) > maxOffGridFraction) {
        problems.push(`${label}: ${report.offGrid} off-grid step(s) (${(100 * report.offGrid / (report.count - 1)).toFixed(2)}% > ${(maxOffGridFraction * 100).toFixed(1)}%)`);
    }
    if (report.missingPeriods) problems.push(`${label}: ${report.missingPeriods} missing funding period(s)`);
    return problems;
}

// The carry return earned by the delta-neutral book over one funding period.
export const carryPerPeriod = (row, { signFlip = false } = {}) => (signFlip ? -row.fundingRate : row.fundingRate);

// The carry sleeve at the funding grid: one return per period.
export function carryReturns(rows, { signFlip = false } = {}) {
    return rows.map((r) => carryPerPeriod(r, { signFlip }));
}

// The carry of a BAR grid, causally: bar `i` earns the funding of the most recent
// period that has already CLOSED at that bar's open, divided across the bars of
// that period (so the sum over a period equals the 8h sleeve exactly). A bar with
// no closed period yet earns 0.
export function carryOnBarGrid(barTimestamps, rows, { gridMs = FUNDING_GRID_MS, signFlip = false } = {}) {
    if (!Array.isArray(barTimestamps) || !Array.isArray(rows) || rows.length === 0) return barTimestamps.map(() => 0);
    const perBar = gridMs;                              // bars are finer than the grid
    const out = new Array(barTimestamps.length).fill(0);
    // The number of bars in a funding period for THIS grid: infer it from the bar
    // spacing (a 15m grid -> 32 bars in an 8h period).
    let barsPerPeriod = 0;
    if (barTimestamps.length > 1) {
        const step = toMs(barTimestamps[1]) - toMs(barTimestamps[0]);
        if (step > 0) barsPerPeriod = Math.max(1, Math.round(perBar / step));
    }
    if (!(barsPerPeriod > 0)) barsPerPeriod = 1;
    // Normalise both sides to epoch ms before comparing (see `toMs`).
    const rowMs = rows.map((r) => toMs(r.timestamp));
    let ri = -1;
    for (let i = 0; i < barTimestamps.length; i++) {
        const t = toMs(barTimestamps[i]);
        while (ri + 1 < rows.length && rowMs[ri + 1] <= t) ri += 1;
        if (ri < 0) continue;                            // no closed funding period yet
        out[i] = carryPerPeriod(rows[ri], { signFlip }) / barsPerPeriod;
    }
    return out;
}

// The carry series a STREAM would contribute to the panel: for every fold of a
// world, the carry over that fold's TEST bars (the same index space the pooled
// price returns use, so the dependence machinery can treat it as a ninth stream).
export function carryPanelStream({ timestamps, folds, rows, signFlip = false, gridMs = FUNDING_GRID_MS }) {
    const series = carryOnBarGrid(timestamps, rows, { gridMs, signFlip });
    const out = [];
    for (const fold of folds) {
        for (let t = fold.testStart; t <= fold.testEnd; t++) out.push(finite(series[t]) ? series[t] : 0);
    }
    return out;
}

// Pearson correlation of two equal-length series (NaN when either is degenerate).
export function correlation(a, b) {
    const n = Math.min(a.length, b.length);
    if (!n) return NaN;
    let ma = 0; let mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let num = 0; let da = 0; let db = 0;
    for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    if (!(da > 0) || !(db > 0)) return NaN;
    return num / Math.sqrt(da * db);
}

// The equal-weight pooled carry sleeve across symbols (the sleeve the panel uses).
export function pooledCarry(streams) {
    const series = streams.filter((s) => Array.isArray(s) && s.length);
    if (!series.length) return [];
    const n = Math.min(...series.map((s) => s.length));
    const out = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        let acc = 0;
        for (const s of series) acc += s[i];
        out[i] = acc / series.length;
    }
    return out;
}
