// Causal, point-in-time row/series helpers for the sleeve and risk plugins.
//
// These are the small pieces the lab's book constructions share, extracted from
// `e17_low_turnover.js` (rank/level weighting, the EWMA/hold policy),
// `e21_open_interest.js` + `e22_toptrader_validate.js` (the masked cross-sectional
// target — the two are the same formula) and `e16_cost_capacity.js` (the Sharpe
// reading). Every function reads only its arguments; none of them read the clock,
// the filesystem or an RNG.

const fin = (x) => (Number.isFinite(x) ? x : 0);

// Mean of the FINITE entries (the lab convention: a missing symbol is excluded
// from a demean/mean, never zeroed — L10-r).
export function rowMean(row) {
    let sum = 0;
    let n = 0;
    for (let j = 0; j < row.length; j++) if (Number.isFinite(row[j])) { sum += row[j]; n++; }
    return n ? sum / n : NaN;
}

// Population standard deviation of the finite entries (e12#xsLevelWeights uses
// the population form, not the sample form).
export function rowStdPopulation(row) {
    const m = rowMean(row);
    if (!Number.isFinite(m)) return NaN;
    let acc = 0;
    let n = 0;
    for (let j = 0; j < row.length; j++) if (Number.isFinite(row[j])) { acc += (row[j] - m) ** 2; n++; }
    return n ? Math.sqrt(acc / n) : NaN;
}

// Sample Sharpe of a returns series at a stated annualisation basis
// (`periodsPerYear` = the TRUE period count: 365*3 for the lab's 8h grid, 252 for
// daily bars). Returns NaN for a degenerate series rather than 0.
export function sharpeOf(returns, periodsPerYear) {
    const v = returns.filter(Number.isFinite);
    if (v.length < 3) return NaN;
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const s = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
    return s > 0 ? (m / s) * Math.sqrt(periodsPerYear) : NaN;
}

export function meanOf(returns) {
    const v = returns.filter(Number.isFinite);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

// One EWMA step of a held weight vector toward a target (e17's `ewma` policy).
// A non-finite target counts as 0 (the repo's `fin`, uniformly with the rest of
// this module; on finite rows it is exactly the lab's `target[j]`).
export function ewmaUpdate(held, target, lambda) {
    return held.map((h, j) => (1 - lambda) * h + lambda * fin(target[j]));
}

// Equal-capital blend of two weight rows (the OI sleeve's 50/50, F-46/e52).
// A non-finite second leg counts as 0 (identical to the lab on finite rows).
export function blendRows(a, b, weightA = 0.5) {
    return a.map((x, j) => weightA * x + (1 - weightA) * fin(b[j]));
}

// log(a_t / a_{t-1}) guarded to positive values (the OI signal's definition).
export function dlogPositive(series, i) {
    if (!series) return null;
    const a = series[i];
    const b = series[i - 1];
    return (a > 0 && b > 0) ? Math.log(a / b) : null;
}

// The first index at which every symbol's signal is present (the lab's
// `firstTop`/`firstOI` guards: a cross-sectional book starts when a full
// cross-section exists, so the demean is never computed on a partial panel). A
// `null` COLUMN (`signalBySymbol[j] === null`, a symbol with no series at all —
// the shape `dlogMatrix` returns for an absent symbol) can never be present, so it
// short-circuits to -1 exactly as a wholly-missing symbol must.
export function firstCommonIndex(signalBySymbol, k, { from = 1 } = {}) {
    if (!signalBySymbol || !signalBySymbol[0]) return -1;
    const n = signalBySymbol[0].length;
    for (let i = from; i < n; i++) {
        let all = true;
        for (let j = 0; j < k; j++) {
            const column = signalBySymbol[j];
            if (!column || !Number.isFinite(column[i])) { all = false; break; }
        }
        if (all) return i;
    }
    return -1;
}

// Rank weights (e17#rankWeights / e12): each symbol's rank centred on the panel,
// normalised to sum|w| = 1. Scale-free and robust to the fat funding tails that
// dominate the level variant (F-17/F-21). Ties are broken by symbol order (a
// stable sort), exactly as the lab's `[v, j]` sort does.
export function rowRankWeights(row) {
    const k = row.length;
    const order = row.map((v, j) => [v, j]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const rw = new Array(k).fill(0);
    order.forEach((j, rank) => { rw[j] = rank - (k - 1) / 2; });
    const g = rw.reduce((a, b) => a + Math.abs(b), 0) || 1;
    return rw.map((v) => v / g);
}

// Level (z-score) weights — the dominated sibling of the rank variant, kept so
// the comparison is reproducible (e12#xsLevelWeights).
export function rowLevelWeights(row) {
    const m = row.reduce((a, b) => a + b, 0) / row.length;
    const sd = Math.sqrt(row.reduce((a, b) => a + (b - m) ** 2, 0) / row.length) || 1;
    const z = row.map((v) => (v - m) / sd);
    const g = z.reduce((a, b) => a + Math.abs(b), 0) || 1;
    return z.map((v) => v / g);
}

// The masked, dollar-neutral cross-sectional TARGET row (e21#xsBookImpl /
// e22#buildMasked, verbatim): take the present symbols only, demean, normalise by
// sum|z|, scale by the prior's sign. Fewer than 3 present symbols -> a flat row
// (no book to build from a two-point cross-section).
export function crossSectionalTarget(row, sign = 1) {
    const k = row.length;
    const target = new Array(k).fill(0);
    const present = [];
    for (let j = 0; j < k; j++) if (Number.isFinite(row[j])) present.push(j);
    if (present.length < 3) return { target, present };
    const values = present.map((j) => row[j]);
    const m = values.reduce((a, b) => a + b, 0) / values.length;
    const z = values.map((v) => v - m);
    const g = z.reduce((a, b) => a + Math.abs(b), 0) || 1;
    present.forEach((j, q) => { target[j] = sign * z[q] / g; });
    return { target, present };
}

// Apply a weight policy to a target row. Supported: `daily` (the bare target),
// `ewma` (slow the book toward the target), `hold` (recompute every N periods).
// Anything else throws rather than silently passing through (the R27 lesson).
export function applyWeightPolicy(held, target, policy, counter) {
    const kind = policy ? policy.kind : 'daily';
    if (kind === 'daily') return target.slice();
    if (kind === 'ewma') return ewmaUpdate(held, target, policy.lambda);
    if (kind === 'hold') return (counter % policy.N === 0) ? target.slice() : held.slice();
    throw new Error(`unknown weight policy "${kind}"`);
}

export { fin };
