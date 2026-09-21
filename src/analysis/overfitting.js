// Probability of Backtest Overfitting (PBO) via Combinatorially Symmetric
// Cross-Validation (CSCV).
//
// A strategy selected as "best in-sample" out of many trials is the *maximum of
// a noisy set*, so its in-sample Sharpe is a biased estimate of its skill. CSCV
// makes that selection bias measurable without assuming independence between
// trials or Normality: partition the timeline into S equal blocks, and for every
// choice of S/2 blocks as the in-sample set, score each candidate in-sample and
// out-of-sample. If the in-sample winner tends to land below the out-of-sample
// median, the selection was overfitting.
//
// Reference: Bailey, Borwein, Lopez de Prado & Zhu, "The Probability of Backtest
// Overfitting", Journal of Computational Finance (2016); Lopez de Prado, AFML
// ch. 12. This is the natural companion to `performance.js#deflatedSharpeRatio`
// (a parametric selection-bias correction) — PBO is the non-parametric,
// rank-based counterpart, and it needs only the *matrix* of candidate returns.
//
// Pure: no I/O, no RNG. Deterministic given the returns matrix.
//
// Definitions used here (matching the reference implementation):
//   - blocks must be even; there are C(S, S/2) symmetric splits;
//   - for a split, the in-sample winner is argmax_j perf_IS(j);
//   - its out-of-sample *relative rank* is omega = rank/(N+1), rank in 1..N
//     (1 = worst OOS) with average ranks for ties;
//   - the split's logit is lambda = ln(omega / (1 - omega));
//   - PBO = fraction of splits with lambda <= 0 (the IS winner is at or below
//     the OOS median, i.e. no out-of-sample edge).

import { sharpeRatio, mean } from './performance.js';

export const DEFAULT_PBO_CONFIG = Object.freeze({ blocks: 10, periodsPerYear: 1, metric: null });

// Enumerate all combinations of `r` indices drawn from 0..k-1, lexicographically.
function combinations(k, r) {
    const out = [];
    const combo = [];
    const recurse = (start) => {
        if (combo.length === r) { out.push(combo.slice()); return; }
        for (let i = start; i <= k - (r - combo.length); i++) { combo.push(i); recurse(i + 1); combo.pop(); }
    };
    recurse(0);
    return out;
}

// Binomial coefficient without enumerating, so an oversized `blocks` is rejected
// instead of attempting an astronomical enumeration (BUGS.md #13).
function binomialCount(n, r) {
    if (r < 0 || r > n) return 0;
    r = Math.min(r, n - r);
    let c = 1;
    for (let i = 1; i <= r; i++) {
        c = (c * (n - r + i)) / i;
        if (!Number.isFinite(c)) return Infinity;
    }
    return Math.round(c);
}

const MAX_CSCV_SPLITS = 200000;

// Partition n observations into S contiguous blocks, as equal as possible (the
// remainder is spread over the first blocks, exactly like the CV splitters).
export function cscvBlocks(n, blocks) {
    if (!Number.isInteger(n) || n <= 0) throw new Error('cscvBlocks: n must be a positive integer');
    if (!Number.isInteger(blocks) || blocks < 2 || blocks % 2 !== 0) throw new Error('cscvBlocks: blocks must be an even integer >= 2');
    if (blocks > n) throw new Error('cscvBlocks: blocks must be <= n');
    const base = Math.floor(n / blocks);
    const rem = n % blocks;
    const out = [];
    let cursor = 0;
    for (let b = 0; b < blocks; b++) {
        const len = base + (b < rem ? 1 : 0);
        const idx = new Array(len);
        for (let i = 0; i < len; i++) idx[i] = cursor + i;
        cursor += len;
        out.push(idx);
    }
    return out;
}

// All C(S, S/2) combinatorially symmetric splits. Each split's in-sample set is a
// union of whole blocks and its out-of-sample set is the complementary blocks, so
// the two are disjoint and together cover every observation.
export function cscvSplit({ n, blocks }) {
    const groups = cscvBlocks(n, blocks);
    const half = blocks / 2;
    const splitCount = binomialCount(blocks, half);
    if (splitCount > MAX_CSCV_SPLITS) {
        throw new Error(`cscvSplit: C(${blocks},${half}) = ${splitCount} splits exceeds the cap of ${MAX_CSCV_SPLITS}; reduce blocks`);
    }
    return combinations(blocks, half).map((isBlocks) => {
        const isSet = new Set();
        for (const b of isBlocks) for (const i of groups[b]) isSet.add(i);
        const oosBlocks = [];
        for (let b = 0; b < blocks; b++) if (!isBlocks.includes(b)) oosBlocks.push(b);
        const oosSet = new Set();
        for (const b of oosBlocks) for (const i of groups[b]) oosSet.add(i);
        return {
            is: [...isSet].sort((a, b) => a - b),
            oos: [...oosSet].sort((a, b) => a - b),
            isBlocks: isBlocks.slice(),
            oosBlocks,
        };
    });
}

// Relative rank of values[index] within `values`, mapped to (0, 1) as
// rank/(N+1). rank 1 = worst, N = best; ties share their average rank. This is
// the omega of Bailey et al. (the logit is lambda = ln(omega/(1-omega))).
export function relativeRank(values, index) {
    const n = values.length;
    if (n === 0) return NaN;
    const v = values[index];
    if (!Number.isFinite(v)) return NaN;
    let less = 0;
    let ties = 0;
    for (let j = 0; j < n; j++) {
        if (j === index) continue;
        if (!Number.isFinite(values[j])) continue;
        if (values[j] < v) less++;
        else if (values[j] === v) ties++;
    }
    const rank = 1 + less + 0.5 * ties;
    return rank / (n + 1);
}

// OLS of out-of-sample on in-sample performance across every (split, strategy)
// pair. A negative slope is the classic overfitting signature: what looked good
// in-sample does worse out-of-sample.
export function oosOnIsRegression(isValues, oosValues) {
    const n = isValues.length;
    if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN, n };
    const mx = mean(isValues);
    const my = mean(oosValues);
    let sxy = 0; let sxx = 0; let syy = 0;
    for (let i = 0; i < n; i++) {
        const dx = isValues[i] - mx;
        const dy = oosValues[i] - my;
        sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    const slope = sxx > 0 ? sxy / sxx : 0;
    return { slope, intercept: my - slope * mx, r2: (sxx > 0 && syy > 0) ? (sxy * sxy) / (sxx * syy) : 0, n };
}

// Core CSCV estimator.
//   returnsMatrix — array of N strategy return series, each of length T.
//   blocks        — even number of contiguous blocks S (default 10 => 252 splits).
//   metric        — default per-period Sharpe; any (series) => number works.
// Returns { pbo, splits, strategies, bars, logits, ..., degradation, config }.
export function probabilityOfBacktestOverfitting(returnsMatrix, options = {}) {
    const { blocks, periodsPerYear, metric } = { ...DEFAULT_PBO_CONFIG, ...options };
    if (!Array.isArray(returnsMatrix) || returnsMatrix.length < 2) {
        throw new Error('probabilityOfBacktestOverfitting: need at least 2 strategies');
    }
    const N = returnsMatrix.length;
    const T = returnsMatrix[0].length;
    for (const row of returnsMatrix) {
        if (!Array.isArray(row) || row.length !== T) {
            throw new Error('probabilityOfBacktestOverfitting: returnsMatrix must be rectangular');
        }
    }
    if (blocks > Math.floor(T / 2)) {
        throw new Error('probabilityOfBacktestOverfitting: need at least 2 observations per half (blocks <= T/2)');
    }
    const perf = metric || ((series) => sharpeRatio(series, { periodsPerYear }));

    const splits = cscvSplit({ n: T, blocks });
    const logits = [];
    const isBestIndex = [];
    const oosRankOfBest = [];
    const isBestPerformance = [];
    const oosPerformanceOfBest = [];
    const oosMedianPerformance = [];
    const oosMeanPerformance = [];
    const isPairs = [];
    const oosPairs = [];

    for (const sp of splits) {
        const isPerf = new Array(N);
        const oosPerf = new Array(N);
        for (let j = 0; j < N; j++) {
            const row = returnsMatrix[j];
            isPerf[j] = perf(sp.is.map((i) => row[i]));
            oosPerf[j] = perf(sp.oos.map((i) => row[i]));
        }
        let best = 0;
        for (let j = 1; j < N; j++) if (isPerf[j] > isPerf[best]) best = j;

        const omega = relativeRank(oosPerf, best);
        logits.push(omega > 0 && omega < 1 ? Math.log(omega / (1 - omega)) : NaN);
        isBestIndex.push(best);
        oosRankOfBest.push(omega);
        isBestPerformance.push(isPerf[best]);
        oosPerformanceOfBest.push(oosPerf[best]);
        const sorted = oosPerf.slice().sort((a, b) => a - b);
        oosMedianPerformance.push(sorted.length % 2 === 1
            ? sorted[(sorted.length - 1) / 2]
            : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
        oosMeanPerformance.push(mean(oosPerf));
        for (let j = 0; j < N; j++) { isPairs.push(isPerf[j]); oosPairs.push(oosPerf[j]); }
    }

    const overfit = logits.filter((l) => l <= 0).length;
    return {
        pbo: overfit / splits.length,
        splits: splits.length,
        strategies: N,
        bars: T,
        blocks,
        logits,
        isBestIndex,
        oosRankOfBest,
        isBestPerformance,
        oosPerformanceOfBest,
        oosMedianPerformance,
        oosMeanPerformance,
        degradation: oosOnIsRegression(isPairs, oosPairs),
        config: { blocks, periodsPerYear },
    };
}
