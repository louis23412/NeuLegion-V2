// White's Reality Check (RC) and Hansen's Superior Predictive Ability (SPA)
// test — the bootstrap multiple-testing corrections for "is the BEST of K
// strategies actually better than a benchmark, given that we searched?".
//
// Why this exists on top of the deflated Sharpe (performance.js) and PBO
// (overfitting.js):
//   - The deflated Sharpe corrects a *single* statistic for the number of
//     trials, assuming a Gaussian/independent trial structure;
//   - PBO (CSCV) measures the selection bias of an in-sample winner
//     non-parametrically, but answers "does the winner degrade OOS?", not "is
//     the winner significantly > benchmark?";
//   - RC/SPA answer the latter, non-parametrically and WITHOUT assuming the K
//     strategies are independent, by bootstrapping the max statistic over the
//     SAME resampled time indices for every strategy (this preserves the
//     cross-sectional dependence, which is exactly what naive per-strategy
//     p-values get wrong).
//
// References:
//   - White, H. (2000). "A Reality Check for Data Snooping", Econometrica
//     48(5):1097-1126 — the RC statistic V = sqrt(T) * max_k mean(f_k).
//   - Hansen, P.R. (2005). "A Test for Superior Predictive Ability", Journal of
//     Business & Economic Statistics 23(4):365-380 — the studentized, recentred
//     SPA; less conservative than RC when many candidate strategies are poor
//     (their noisy losses inflate RC's null distribution, but SPA divides each
//     candidate by its own standard error).
//   - Romano, J.P. & Wolf, M. (2005). "Stepwise Multiple Testing as Formalized
//     Data Snooping", Econometrica 73(4):1237-1282 — the step-down max-t that
//     names WHICH candidates beat the benchmark while controlling the
//     family-wise error rate. Hansen (2005) §4 gives the consistent recentring
//     used by both the "consistent SPA" p-value and the step-down, where a
//     candidate more than A_k = omega_k * sqrt(2 log log T) below the benchmark
//     is recentred to zero (too poor to be asymptotically relevant).
//   - Politis & Romano (1994). "The Stationary Bootstrap", JASA 89(428):
//     1303-1313 — the geometric-block resampling used here (shared with
//     performance.js#stationaryBootstrapSharpe).
//   - Politis, D.N. & Romano, J.P. (1994). "Large Sample Confidence Regions
//     Based on Subsamples under Minimal Assumptions", Annals of Statistics
//     22(4):2031-2050, and Politis, Romano & Wolf (1999), "Subsampling"
//     (Springer, ch. 3-4) — the variance-consistent *subsampling* inference
//     implemented by `subsamplingSpa`/`subsamplingStepM`. It estimates the
//     statistic's own sampling distribution from overlapping windows, so it
//     needs no long-run-variance estimate and does not inherit the block
//     bootstrap's low-biased variance of the mean under strong persistence.
//   - Politis, D.N. & White, H. (2004). "Automatic Block-Length Selection for
//     the Dependent Bootstrap", Econometric Reviews 23(1):53-70, with the
//     correction of Patton, A., Politis, D.N. & White, H. (2009), Econometric
//     Reviews 28(4):372-375 — the data-driven flat-top-kernel block length
//     selected by `politisWhiteBlockLength` below. Passing
//     `blockLength: "auto"` opts in; the fixed floor(T^(1/3)) rule remains the
//     default so every locked p-value stays bit-stable.
//   - Lopez de Prado, AFML (2018) ch. 8/12 — SPA as the multiple-testing
//     companion to DSR.
//
// Pure and deterministic given `seed`: no I/O, no global RNG. The block indices
// are drawn from an explicit mulberry32 stream, so two calls with the same seed
// return bit-identical p-values.

import { mean } from './performance.js';

export const DEFAULT_RC_CONFIG = Object.freeze({
    benchmark: 0,
    nBoot: 1000,
    blockLength: null, // null => floor(T^(1/3)), matching stationaryBootstrapSharpe
    seed: 1,
});

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// The benchmark may be a scalar (e.g. 0 for "absolute performance", or a
// per-period risk-free rate), a full return series (e.g. buy-and-hold), or
// null/undefined (treated as 0). Returns a length-n Float64Array.
export function benchmarkSeries(benchmark, n) {
    if (benchmark == null) return new Float64Array(n);
    if (typeof benchmark === 'number') {
        if (!Number.isFinite(benchmark)) throw new Error('reality_check: benchmark must be finite');
        const out = new Float64Array(n);
        out.fill(benchmark);
        return out;
    }
    if (Array.isArray(benchmark) || ArrayBuffer.isView(benchmark)) {
        if (benchmark.length !== n) throw new Error('reality_check: benchmark length must equal the number of bars');
        const out = new Float64Array(n);
        for (let t = 0; t < n; t++) {
            const v = Number(benchmark[t]);
            if (!Number.isFinite(v)) throw new Error('reality_check: benchmark contains a non-finite value');
            out[t] = v;
        }
        return out;
    }
    throw new Error('reality_check: benchmark must be a number, a series, or null');
}

// Validate the candidate matrix and subtract the benchmark, giving the K x T
// matrix of relative performances f_{k,t} = r_{k,t} - b_t. This is the input to
// both tests; the "performance measure" here is the mean relative return, which
// is exactly what White/Hansen use (any measure whose mean is the object of
// inference works, but mean is the canonical and exactly checkable choice).
export function relativePerformance(returnsMatrix, benchmark = 0) {
    if (!Array.isArray(returnsMatrix) || returnsMatrix.length < 2) {
        throw new Error('reality_check: need at least 2 candidate strategies');
    }
    const K = returnsMatrix.length;
    const T = returnsMatrix[0] && returnsMatrix[0].length;
    if (!Number.isInteger(T) || T < 2) throw new Error('reality_check: need at least 2 bars');
    for (const row of returnsMatrix) {
        if (!Array.isArray(row) && !ArrayBuffer.isView(row)) throw new Error('reality_check: each strategy must be a return series');
        if (row.length !== T) throw new Error('reality_check: returnsMatrix must be rectangular');
    }
    const bench = benchmarkSeries(benchmark, T);
    const rel = [];
    for (let k = 0; k < K; k++) {
        const row = returnsMatrix[k];
        const out = new Float64Array(T);
        for (let t = 0; t < T; t++) {
            const v = Number(row[t]);
            if (!Number.isFinite(v)) throw new Error('reality_check: returns contain a non-finite value');
            out[t] = v - bench[t];
        }
        rel.push(out);
    }
    return { rel, T, K, benchmark: bench };
}

// One stationary-bootstrap index draw (Politis & Romano 1994): at each step a
// new geometric block starts with probability 1/blockLength, otherwise the
// cursor advances by one (wraparound). blockLength = 1 collapses to i.i.d.
// sampling with replacement. Shared verbatim between the two tests so that RC
// and SPA are compared under the SAME resampling draws.
export function stationaryBlockIndices(n, blockLength, rnd) {
    if (!Number.isInteger(n) || n < 1) throw new Error('stationaryBlockIndices: n must be a positive integer');
    if (!(blockLength >= 1)) throw new Error('stationaryBlockIndices: blockLength must be >= 1');
    const idx = new Int32Array(n);
    const p = 1 / blockLength;
    let i = Math.floor(rnd() * n);
    for (let t = 0; t < n; t++) {
        if (t > 0) {
            if (rnd() < p) i = Math.floor(rnd() * n);
            else i = (i + 1) % n;
        }
        idx[t] = i;
    }
    return idx;
}

// Politis & White (2004) automatic block-length selection, with the
// Patton-Politis-White (2009) correction: the data-driven rule for the block
// length b of the stationary / circular block bootstrap. It reproduces the
// reference implementation `arch.bootstrap.optimal_block_length` (itself
// validated against Patton's MATLAB code) to floating-point precision — on the
// paper's own AR(1) benchmark (phi = 0.3, n = 10000, burn-in 100) it returns
// stationary = 13.63566513... and circular = 15.60894008...
//
//   1. autocovariances ghat(i) = (1/T) sum_t x'_t x'_{t+i} of the demeaned
//      series, plus the sample autocorrelations rho(i);
//   2. mhat = the first lag opening a run of `kn` consecutive autocorrelations
//      all inside the band +-2 sqrt(log10(T)/T), kn = max(5, floor(log10 T));
//      m = 2 max(mhat, 1), clamped to m_max = ceil(sqrt(T)) + kn;
//   3. flat-top kernel h(u) = min(1, 2(1 - |u|)); g = 2 sum_k h(k/m) k ghat(k)
//      and sigma^2 = ghat(0) + 2 sum_k h(k/m) ghat(k);
//   4. b = (2 g^2 / (c sigma^4) * T)^(1/3), c = 2 (stationary) or 4/3
//      (circular), clamped to b_max = ceil(min(3 sqrt(T), T/3)).
//
// In the i.i.d. limit g -> 0 and b -> 0 (floored to 1 by `autoBlockLength`);
// persistent data keeps g positive so b grows with the autocorrelation length —
// exactly the adaptation the fixed T^(1/3) rule cannot make. Returns the raw,
// unrounded lengths together with the selection diagnostics.
export function politisWhiteBlockLength(series) {
    if (!series || (!Array.isArray(series) && !ArrayBuffer.isView(series))) {
        throw new Error('politisWhiteBlockLength: series must be an array of numbers');
    }
    const T = series.length;
    if (!Number.isInteger(T) || T < 10) {
        throw new Error('politisWhiteBlockLength: need at least 10 observations');
    }
    let mu = 0;
    for (let t = 0; t < T; t++) {
        const v = Number(series[t]);
        if (!Number.isFinite(v)) throw new Error('politisWhiteBlockLength: series contains a non-finite value');
        mu += v;
    }
    mu /= T;
    const eps = new Float64Array(T);
    for (let t = 0; t < T; t++) eps[t] = Number(series[t]) - mu;

    const kn = Math.max(5, Math.trunc(Math.log10(T)));
    const mMax = Math.min(Math.ceil(Math.sqrt(T)) + kn, T - 1);
    const bMax = Math.max(1, Math.ceil(Math.min(3 * Math.sqrt(T), T / 3)));
    const criterion = 2 * Math.sqrt(Math.log10(T) / T);

    const acv = new Float64Array(mMax + 1);
    const absAc = new Float64Array(mMax + 1);
    let optM = null;
    for (let i = 0; i <= mMax; i++) {
        let v1 = 0;
        for (let t = i + 1; t < T; t++) v1 += eps[t] * eps[t];
        let v2 = 0;
        for (let t = 0; t < T - i - 1; t++) v2 += eps[t] * eps[t];
        let cross = 0;
        for (let t = 0; t < T - i; t++) cross += eps[t + i] * eps[t];
        acv[i] = cross / T;
        const den = Math.sqrt(v1 * v2);
        absAc[i] = den > 0 ? Math.abs(cross) / den : 0;
        if (i >= kn && optM === null) {
            let quiet = true;
            for (let j = i - kn; j < i; j++) if (!(absAc[j] < criterion)) { quiet = false; break; }
            if (quiet) optM = i - kn;
        }
    }
    let m = optM !== null ? 2 * Math.max(optM, 1) : mMax;
    m = Math.min(m, mMax);
    let g = 0;
    let sigma2 = acv[0];
    for (let k = 1; k <= m; k++) {
        const lam = k / m <= 0.5 ? 1 : 2 * (1 - k / m);
        g += 2 * lam * k * acv[k];
        sigma2 += 2 * lam * acv[k];
    }
    const length = (c) => (sigma2 > 0 && g > 0
        ? Math.pow((2 * g * g) / (c * sigma2 * sigma2), 1 / 3) * Math.pow(T, 1 / 3)
        : 0);
    return {
        stationary: Math.min(length(2), bMax),
        circular: Math.min(length(4 / 3), bMax),
        m, optM, kn, mMax, bMax, criterion, g, sigma2,
    };
}

// Resolve `blockLength: "auto"` for a bootstrap: run the Politis-White selector
// on every candidate series and reduce the per-candidate lengths to the single
// number the shared-index block bootstrap needs. A single series is returned
// as-is; for a K x T matrix the default reduction is the MEAN of the raw
// selectors, i.e. the pooled estimate of one timeline-wide block length. `max`
// is available but is deliberately NOT the default: the selector is
// right-skewed in small samples, so the maximum over K candidates is biased
// upward (measured on 10 i.i.d. columns, T=120: mean 1.5, median 1.4,
// max 4.1) and inflates the bootstrap's noise instead of taming it. The result
// is floored at 1 — a block length below 1 is i.i.d. sampling by definition.
export function autoBlockLength(seriesOrMatrix, { type = 'stationary', reduce = 'mean' } = {}) {
    if (type !== 'stationary' && type !== 'circular') {
        throw new Error('autoBlockLength: type must be "stationary" or "circular"');
    }
    if (!['mean', 'median', 'min', 'max'].includes(reduce)) {
        throw new Error('autoBlockLength: reduce must be mean, median, min or max');
    }
    if (!seriesOrMatrix || (!Array.isArray(seriesOrMatrix) && !ArrayBuffer.isView(seriesOrMatrix)) || seriesOrMatrix.length === 0) {
        throw new Error('autoBlockLength: expected a series or a non-empty matrix of series');
    }
    const first = seriesOrMatrix[0];
    const rows = (Array.isArray(first) || ArrayBuffer.isView(first))
        ? Array.from(seriesOrMatrix)
        : [seriesOrMatrix];
    const perSeries = rows.map((row) => politisWhiteBlockLength(row)[type]);
    let raw;
    if (perSeries.length === 1) raw = perSeries[0];
    else if (reduce === 'mean') raw = perSeries.reduce((a, b) => a + b, 0) / perSeries.length;
    else if (reduce === 'max') raw = perSeries.reduce((a, b) => Math.max(a, b), -Infinity);
    else if (reduce === 'min') raw = perSeries.reduce((a, b) => Math.min(a, b), Infinity);
    else raw = [...perSeries].sort((a, b) => a - b)[Math.floor(perSeries.length / 2)];
    return { blockLength: Math.max(1, raw), raw, perSeries, type, reduce, n: perSeries.length };
}

// Shared bootstrap core: resample the timeline B times and record, for every
// strategy, the bootstrap mean of its relative performance. Both RC (un-
// studentized) and SPA (studentized, recentred) are simple functions of this
// matrix, so they are guaranteed to share the exact same draws.
export function bootstrapRelativeMeans(rel, { nBoot = 1000, blockLength = null, seed = 1, T, K } = {}) {
    const Tt = T ?? rel[0].length;
    const Kk = K ?? rel.length;
    if (!Number.isInteger(nBoot) || nBoot < 1) throw new Error('reality_check: nBoot must be a positive integer');
    let bl;
    let blockLengthAuto = null;
    if (blockLength === 'auto') {
        blockLengthAuto = autoBlockLength(Array.from({ length: Kk }, (_, k) => rel[k]), { type: 'stationary', reduce: 'mean' });
        bl = blockLengthAuto.blockLength;
    } else {
        bl = blockLength != null ? blockLength : Math.max(1, Math.floor(Math.pow(Tt, 1 / 3)));
    }
    if (!(bl >= 1)) throw new Error('reality_check: blockLength must be >= 1');
    const rnd = mulberry32(seed);
    const fbar = new Float64Array(Kk);
    for (let k = 0; k < Kk; k++) fbar[k] = mean(rel[k]);
    const fbarBoot = new Array(nBoot);
    for (let b = 0; b < nBoot; b++) {
        const idx = stationaryBlockIndices(Tt, bl, rnd);
        const row = new Float64Array(Kk);
        for (let k = 0; k < Kk; k++) {
            const series = rel[k];
            let s = 0;
            for (let t = 0; t < Tt; t++) s += series[idx[t]];
            row[k] = s / Tt;
        }
        fbarBoot[b] = row;
    }
    return { fbar, fbarBoot, blockLength: bl, blockLengthAuto, nBoot, T: Tt, K: Kk };
}

// Protect against a numerically-zero standard error: a deterministically
// positive strategy has an infinite t-statistic (a genuine, unambiguous edge),
// while a deterministically non-positive one contributes nothing.
function safeRatio(num, den) {
    if (den > 0) return num / den;
    return num > 0 ? Infinity : 0;
}

export function whiteRealityCheck({ returnsMatrix, benchmark, nBoot, blockLength, seed } = {}) {
    ({ benchmark = 0, nBoot, blockLength, seed } = { ...DEFAULT_RC_CONFIG, benchmark, nBoot, blockLength, seed });
    const { rel, T, K } = relativePerformance(returnsMatrix, benchmark);
    const { fbar, fbarBoot, blockLength: bl } = bootstrapRelativeMeans(rel, { nBoot, blockLength, seed, T, K });

    const root = Math.sqrt(T);
    let best = 0;
    for (let k = 1; k < K; k++) if (fbar[k] > fbar[best]) best = k;
    const stat = root * fbar[best];

    const bootStats = new Float64Array(nBoot);
    let exceed = 0;
    for (let b = 0; b < nBoot; b++) {
        const row = fbarBoot[b];
        let mx = -Infinity;
        for (let k = 0; k < K; k++) {
            const d = row[k] - fbar[k];
            if (d > mx) mx = d;
        }
        const vb = root * mx;
        bootStats[b] = vb;
        if (vb > stat) exceed++;
    }
    return {
        statistic: stat,
        pValue: exceed / nBoot,
        nBoot,
        blockLength: bl,
        bestIndex: best,
        bestMean: fbar[best],
        means: Array.from(fbar),
        bootStats,
    };
}

export function hansenSpa({ returnsMatrix, benchmark, nBoot, blockLength, seed } = {}) {
    ({ benchmark = 0, nBoot, blockLength, seed } = { ...DEFAULT_RC_CONFIG, benchmark, nBoot, blockLength, seed });
    const { rel, T, K } = relativePerformance(returnsMatrix, benchmark);
    const { fbar, fbarBoot, blockLength: bl } = bootstrapRelativeMeans(rel, { nBoot, blockLength, seed, T, K });

    const omega = bootstrapStdErrors(fbar, fbarBoot, nBoot, K);
    // "Upper" recentring: every candidate keeps its own mean (Hansen 2005's
    // least-favourable, most conservative member of the family).
    const core = spaCore(fbar, fbarBoot, omega, fbar, nBoot, K);
    return {
        statistic: core.statistic,
        pValue: core.pValue,
        nBoot,
        blockLength: bl,
        bestIndex: core.bestIndex,
        bestT: core.bestT,
        standardErrors: Array.from(omega),
        means: Array.from(fbar),
        bootStats: core.bootStats,
    };
}

// The bootstrap standard error of each strategy's mean, estimated from the same
// stationary draws (rather than an i.i.d. sample standard deviation) so it is
// robust to serial dependence — this is what makes the SPA statistic
// HAC-consistent.
function bootstrapStdErrors(fbar, fbarBoot, nBoot, K) {
    const omega = new Float64Array(K);
    for (let k = 0; k < K; k++) {
        let s = 0;
        for (let b = 0; b < nBoot; b++) {
            const d = fbarBoot[b][k] - fbar[k];
            s += d * d;
        }
        omega[k] = Math.sqrt(s / nBoot);
    }
    return omega;
}

// Studentize every bootstrap draw: t*_{b,k} = (fbar*_{b,k} - mu_k) / omega_k.
// `mu_k` is the recentring point (fbar_k for the upper bound, the consistent
// recentring for SPA_c / StepM). Returned column-major by draw for cache luck.
function studentizedBoot(fbarBoot, recentring, omega, nBoot, K) {
    const out = new Float64Array(nBoot * K);
    for (let b = 0; b < nBoot; b++) {
        const row = fbarBoot[b];
        const off = b * K;
        for (let k = 0; k < K; k++) out[off + k] = safeRatio(row[k] - recentring[k], omega[k]);
    }
    return out;
}

// Shared SPA core: T^SPA = max(0, max_k fbar_k / omega_k), p-value = share of
// bootstrapped max(0, max_k (fbar*_k - mu_k)/omega_k) that exceed it. The
// max-with-0 plus the recentring is what removes the influence of poor
// strategies while keeping the test's size.
function spaCore(fbar, fbarBoot, omega, recentring, nBoot, K) {
    let stat = 0;
    let best = 0;
    let bestT = -Infinity;
    for (let k = 0; k < K; k++) {
        const t = safeRatio(fbar[k], omega[k]);
        if (t > bestT) { bestT = t; best = k; }
        if (t > stat) stat = t;
    }
    const tBoot = studentizedBoot(fbarBoot, recentring, omega, nBoot, K);
    const bootStats = new Float64Array(nBoot);
    let exceed = 0;
    for (let b = 0; b < nBoot; b++) {
        const off = b * K;
        let mx = 0;
        for (let k = 0; k < K; k++) {
            const v = tBoot[off + k];
            if (v > mx) mx = v;
        }
        bootStats[b] = mx;
        if (mx > stat) exceed++;
    }
    return { statistic: stat, pValue: exceed / nBoot, bestIndex: best, bestT, bootStats, tBoot };
}

// Hansen (2005) consistent recentring. A candidate whose sample mean relative to
// the benchmark is more than A_k = omega_k * sqrt(2 * log(log(T))) below zero is
// "too poor to be asymptotically relevant" and is recentred to zero; every other
// candidate keeps its own mean. The log-log bound is what makes the test
// *consistent*: it vanishes as T grows (so a genuinely bad candidate is
// eventually recentred out, restoring power) but shrinks more slowly than the
// sampling error (so a real local alternative keeps its edge). Matches the
// reference implementation in `arch.bootstrap.multiple_comparison.SPA`
// (`threshold = -sqrt((variances/t) * 2 * log(log(t)))`).
export function consistentRecentring(fbar, omega, T) {
    if (!Number.isInteger(T) || T < 3) {
        throw new Error('reality_check: T must be an integer >= 3 for the log-log bound');
    }
    if (!fbar || !omega || fbar.length !== omega.length) {
        throw new Error('reality_check: fbar and omega must be equal-length arrays');
    }
    const bound = Math.sqrt(2 * Math.log(Math.log(T)));
    const K = fbar.length;
    const recentring = new Float64Array(K);
    for (let k = 0; k < K; k++) {
        const A = omega[k] * bound;
        recentring[k] = fbar[k] >= -A ? fbar[k] : 0;
    }
    return { recentring, bound };
}

// Hansen's *consistent* SPA: identical to `hansenSpa` except the recentring is
// the consistent one above. When every candidate is close to the benchmark the
// two coincide exactly (all candidates are "valid"); when many candidates are
// far below it, the consistent recentring removes their noise from the null
// maximum, so `pValue <= hansenSpa(...).pValue` — the intended gain in power.
export function hansenSpaConsistent({ returnsMatrix, benchmark, nBoot, blockLength, seed } = {}) {
    ({ benchmark = 0, nBoot, blockLength, seed } = { ...DEFAULT_RC_CONFIG, benchmark, nBoot, blockLength, seed });
    const { rel, T, K } = relativePerformance(returnsMatrix, benchmark);
    const { fbar, fbarBoot, blockLength: bl } = bootstrapRelativeMeans(rel, { nBoot, blockLength, seed, T, K });
    const omega = bootstrapStdErrors(fbar, fbarBoot, nBoot, K);
    const { recentring, bound } = consistentRecentring(fbar, omega, T);
    const core = spaCore(fbar, fbarBoot, omega, recentring, nBoot, K);
    return {
        statistic: core.statistic,
        pValue: core.pValue,
        nBoot,
        blockLength: bl,
        bestIndex: core.bestIndex,
        bestT: core.bestT,
        standardErrors: Array.from(omega),
        means: Array.from(fbar),
        recentring: Array.from(recentring),
        logLogBound: bound,
        bootStats: core.bootStats,
    };
}

// Romano & Wolf (2005) step-down max-t on the SAME stationary-bootstrap draws as
// the SPA family above, with Hansen's consistent recentring. The single-step SPA
// answers "does the family contain an edge?"; the step-down answers WHICH
// candidates carry it while keeping the family-wise error rate at alpha.
// Candidates are processed in descending observed t and the reference maximum is
// recomputed over the still-active (not-yet-rejected) candidates only, so a
// candidate is compared against the best of its peers rather than against the
// whole family. By the StepM property the step p-values are monotone down that
// order, so the first candidate that fails stops the procedure: once it is not
// significant, no smaller statistic can be. The first step is therefore EXACTLY
// the single-step consistent SPA (same draws, same max-with-0, same recentring),
// which is why the two always agree on whether the family rejects anything — the
// step-down only ever adds the identity of the rejected candidates.
export function romanoWolfStepM({
    returnsMatrix, benchmark, nBoot, blockLength, seed, alpha = 0.05,
} = {}) {
    ({ benchmark = 0, nBoot, blockLength, seed } = { ...DEFAULT_RC_CONFIG, benchmark, nBoot, blockLength, seed });
    if (!(typeof alpha === 'number' && alpha > 0 && alpha < 1)) {
        throw new Error('reality_check: alpha must be in (0,1)');
    }
    const { rel, T, K } = relativePerformance(returnsMatrix, benchmark);
    const { fbar, fbarBoot, blockLength: bl } = bootstrapRelativeMeans(rel, { nBoot, blockLength, seed, T, K });
    const omega = bootstrapStdErrors(fbar, fbarBoot, nBoot, K);
    const { recentring, bound } = consistentRecentring(fbar, omega, T);

    const tStats = new Float64Array(K);
    for (let k = 0; k < K; k++) tStats[k] = safeRatio(fbar[k], omega[k]);
    const order = Array.from({ length: K }, (_, k) => k).sort((a, c) => tStats[c] - tStats[a]);
    const tBoot = studentizedBoot(fbarBoot, recentring, omega, nBoot, K);

    const stepPValues = new Float64Array(K).fill(1);
    const rejected = new Array(K).fill(false);
    const active = new Array(K).fill(true);
    let nRejected = 0;
    for (let j = 0; j < K; j++) {
        const idx = order[j];
        const threshold = tStats[idx];
        if (!(threshold > 0)) break;
        let exceed = 0;
        for (let b = 0; b < nBoot; b++) {
            const off = b * K;
            let mx = 0;
            for (let k = 0; k < K; k++) {
                if (!active[k]) continue;
                const v = tBoot[off + k];
                if (v > mx) mx = v;
            }
            if (mx > threshold) exceed++;
        }
        const p = exceed / nBoot;
        stepPValues[idx] = p;
        if (p <= alpha) {
            rejected[idx] = true;
            active[idx] = false;
            nRejected++;
        } else {
            break;
        }
    }

    const bootStats = new Float64Array(nBoot);
    for (let b = 0; b < nBoot; b++) {
        const off = b * K;
        let mx = 0;
        for (let k = 0; k < K; k++) {
            const v = tBoot[off + k];
            if (v > mx) mx = v;
        }
        bootStats[b] = mx;
    }

    return {
        alpha,
        order,
        tStats: Array.from(tStats),
        stepPValues: Array.from(stepPValues),
        rejected,
        rejectedIndices: rejected.reduce((acc, r, k) => { if (r) acc.push(k); return acc; }, []),
        nRejected,
        bestIndex: order[0],
        bestT: tStats[order[0]],
        means: Array.from(fbar),
        standardErrors: Array.from(omega),
        recentring: Array.from(recentring),
        logLogBound: bound,
        nBoot,
        blockLength: bl,
        bootStats,
        T,
        K,
    };
}

// --- Variance-consistent subsampling (Politis & Romano 1994; Politis, Romano &
// Wolf 1999, ch. 3-4) -------------------------------------------------------
//
// The tests above estimate the statistic's sampling law from the block bootstrap,
// which needs an explicit block length and, under strong persistence, low-biases
// the variance of the MEAN (section W measures that limitation). Subsampling
// instead reads the law off the statistic computed on every overlapping window of
// length b < T: the window mean is a mean of a b-length sample, so its sampling
// spread directly measures the T-length mean's spread once the deterministic
// b/T covariance deflation (the "shrink" factor sqrt(1 - b/T)) is divided back
// out. No long-run-variance estimate is needed, so the routine does not inherit
// the block bootstrap's low-biased variance under persistence.
//
// The studentized statistic is made approximately pivotal by using the SAME
// Newey-West bandwidth m at the window scale and at the full scale (see
// `neweyWestSE`): the estimator's finite-sample bias is a function of m and the
// persistence, not of the sample length, so it cancels in the window-vs-full
// comparison. The observed statistic is max(0, max_k fbar_k/se_k) and the
// reference distribution is the empirical CDF of the window maxima; every
// overlapping window is used, so the result is DETERMINISTIC — no seed.
//
// Segments (`groups`): when the series is a concatenation of blocks produced by
// different models (walk-forward folds), pass their lengths so every window and
// the long-run variance are computed WITHIN a block. See resolveGroups below.

export const DEFAULT_SUB_CONFIG = Object.freeze({
    benchmark: 0,
    windowLength: null, // null => max(3, round(T/3))
    bandwidth: null,    // null => max(1, round(windowLength/6))
    consistent: false,  // Hansen's consistent recentring in the reference draws
    groups: null,       // null => one segment [0, T); else segment lengths summing to T
    alpha: 0.05,
});

// Newey-West (Bartlett) HAC standard error of the mean of series[from .. from+len).
// `bandwidth` is the Bartlett truncation lag: 0 => the i.i.d. sample standard
// error sqrt(mean((x-mu)^2)/len); m > 0 adds the tapered autocovariance terms
// 2 (1 - j/(m+1)) gamma_j, so it is exactly the usual Bartlett estimator. A
// constant window has zero autocovariances and returns exactly 0 (the SPA ratio
// then treats a deterministic candidate as an infinite t, as it should).
export function neweyWestSE(series, from, length, bandwidth) {
    if (!series || (!Array.isArray(series) && !ArrayBuffer.isView(series))) {
        throw new Error('reality_check: neweyWestSE expects a numeric array');
    }
    const n = series.length;
    const start = from == null ? 0 : from;
    const len = length == null ? n - start : length;
    const m = bandwidth == null ? Math.max(1, Math.round(Math.pow(len, 1 / 3))) : bandwidth;
    if (!Number.isInteger(start) || !Number.isInteger(len) || start < 0 || len < 2 || start + len > n) {
        throw new Error('reality_check: neweyWestSE needs an integer window of length >= 2 inside the series');
    }
    if (!Number.isInteger(m) || m < 0 || m >= len) {
        throw new Error('reality_check: neweyWestSE bandwidth must be an integer in [0, length-1]');
    }
    let mu = 0;
    for (let t = start; t < start + len; t++) {
        const v = Number(series[t]);
        if (!Number.isFinite(v)) throw new Error('reality_check: neweyWestSE series contains a non-finite value');
        mu += v;
    }
    mu /= len;
    const gamma = (j) => {
        let s = 0;
        for (let t = start; t + j < start + len; t++) s += (series[t] - mu) * (series[t + j] - mu);
        return s / len;
    };
    let v = gamma(0);
    for (let j = 1; j <= m; j++) v += 2 * (1 - j / (m + 1)) * gamma(j);
    if (!(v > 0)) v = 0; // a constant window (or rounding noise) has zero variance
    return Math.sqrt(v / len);
}

function meanSlice(series, from, len) {
    let s = 0;
    for (let t = from; t < from + len; t++) s += series[t];
    return s / len;
}

// Normalise the optional `groups` argument into an ordered list of contiguous
// segments tiling [0, T). `groups` is null (one segment = the whole sample) or an
// array of positive integer segment lengths summing to T.
//
// Why segments exist: a walk-forward OOS return stream is a concatenation of
// fold test windows, each of which restarts the lagged position (so the first
// bar of every fold carries no exposure and returns an exact 0) and, more
// fundamentally, was produced by a DIFFERENT refit model. A subsampling window
// spanning a fold boundary therefore mixes two return processes and two mean
// levels, which breaks the approximate-stationarity premise the window CDF
// relies on. The long-run-variance literature makes the same point for
// mean-shift series (arXiv 2603.17226): a single window HAC estimate is biased
// when the level moves, so the estimate must be built per segment. Restricting
// every window to one segment is the time-domain analogue.
function resolveGroups(T, groups) {
    if (groups == null) return [{ from: 0, len: T }];
    if (!Array.isArray(groups) || !groups.length) {
        throw new Error('reality_check: groups must be null or a non-empty array of segment lengths');
    }
    const out = [];
    let from = 0;
    let sum = 0;
    for (const g of groups) {
        if (!Number.isInteger(g) || g < 2) {
            throw new Error('reality_check: each group length must be an integer >= 2');
        }
        out.push({ from, len: g });
        from += g;
        sum += g;
    }
    if (sum !== T) throw new Error('reality_check: group lengths must sum to T');
    return out;
}

// Resolve the shared (windowLength, bandwidth) pair for a length-T sample. With
// segments the default window is half the SHORTEST segment, so every segment
// contributes at least one window; the ungated T/3 default would usually exceed
// a fold length and leave the reference distribution empty.
function resolveSubWindows(T, windowLength, bandwidth, groupList) {
    const grouped = groupList.length > 1 || groupList[0].len !== T;
    const minLen = Math.min(...groupList.map((g) => g.len));
    const b = windowLength == null
        ? (grouped ? Math.max(2, Math.floor(minLen / 2)) : Math.max(3, Math.round(T / 3)))
        : windowLength;
    if (!Number.isInteger(b) || b < 2 || b >= T) {
        throw new Error('reality_check: windowLength must be an integer in [2, T-1]');
    }
    if (grouped && b > minLen) {
        throw new Error('reality_check: windowLength must not exceed the shortest group length');
    }
    const m = bandwidth == null ? Math.max(1, Math.round(b / 6)) : bandwidth;
    if (!Number.isInteger(m) || m < 0 || m >= b) {
        throw new Error('reality_check: bandwidth must be an integer in [0, windowLength-1]');
    }
    return { b, m };
}

// Segment-aware Newey-West standard error of the pooled mean. The pooled mean is
// a length-weighted average of the segment means, so its variance is the sum of
// the segment-mean variances scaled by (len/T)^2, with NO cross-segment
// covariance (segments are separated in calendar time and by the refit). A
// single segment reduces EXACTLY to neweyWestSE over the whole sample, so the
// whole-sample path is untouched.
function groupedFullSE(series, groupList, m, T) {
    if (groupList.length === 1 && groupList[0].from === 0 && groupList[0].len === T) {
        return neweyWestSE(series, 0, T, m);
    }
    let acc = 0;
    for (const g of groupList) {
        const se = neweyWestSE(series, g.from, g.len, m);
        acc += (g.len * se) ** 2;
    }
    return Math.sqrt(acc) / T;
}

// Every subsampling window start, restricted to windows that lie inside ONE
// segment. Single-segment mode returns 0..T-b exactly as before.
function groupWindowStarts(groupList, b, T) {
    if (groupList.length === 1 && groupList[0].from === 0 && groupList[0].len === T) {
        const starts = new Array(T - b + 1);
        for (let s = 0; s < starts.length; s++) starts[s] = s;
        return starts;
    }
    const starts = [];
    for (const g of groupList) {
        const last = g.from + g.len - b;
        for (let s = g.from; s <= last; s++) starts.push(s);
    }
    return starts;
}

// Variance-consistent SPA. `consistent: true` swaps the reference recentring for
// Hansen's consistent one (a candidate more than se_k*sqrt(2 log log T) below the
// benchmark is recentred to zero), matching the SPA_c/StepM family above.
export function subsamplingSpa({ returnsMatrix, benchmark, windowLength, bandwidth, consistent, groups } = {}) {
    ({ benchmark = 0, windowLength = null, bandwidth = null, consistent = false, groups = null } = { ...DEFAULT_SUB_CONFIG, benchmark, windowLength, bandwidth, consistent, groups });
    const { rel, T, K } = relativePerformance(returnsMatrix, benchmark);
    if (T < 6) throw new Error('reality_check: subsampling needs at least 6 bars');
    const groupList = resolveGroups(T, groups);
    const { b, m } = resolveSubWindows(T, windowLength, bandwidth, groupList);

    const fbar = new Float64Array(K);
    const seFull = new Float64Array(K);
    for (let k = 0; k < K; k++) {
        fbar[k] = mean(rel[k]);
        seFull[k] = groupedFullSE(rel[k], groupList, m, T);
    }
    const bound = Math.sqrt(2 * Math.log(Math.log(T)));
    const recentring = new Float64Array(K);
    for (let k = 0; k < K; k++) {
        recentring[k] = consistent && !(fbar[k] >= -seFull[k] * bound) ? 0 : fbar[k];
    }

    let stat = 0;
    let best = 0;
    let bestT = -Infinity;
    for (let k = 0; k < K; k++) {
        const t = safeRatio(fbar[k], seFull[k]);
        if (t > bestT) { bestT = t; best = k; }
        if (t > stat) stat = t;
    }

    const shrink = Math.sqrt(1 - b / T);
    const windows = groupWindowStarts(groupList, b, T);
    const nWindows = windows.length;
    const tWindows = new Float64Array(nWindows * K);
    const windowStats = new Float64Array(nWindows);
    let exceed = 0;
    for (let si = 0; si < nWindows; si++) {
        const s = windows[si];
        const off = si * K;
        let mx = 0;
        for (let k = 0; k < K; k++) {
            const t = safeRatio((meanSlice(rel[k], s, b) - recentring[k]) / shrink, neweyWestSE(rel[k], s, b, m));
            tWindows[off + k] = t;
            if (t > mx) mx = t;
        }
        windowStats[si] = mx;
        if (mx > stat) exceed++;
    }

    return {
        statistic: stat,
        pValue: exceed / nWindows,
        bestIndex: best,
        bestT,
        means: Array.from(fbar),
        standardErrors: Array.from(seFull),
        recentring: Array.from(recentring),
        logLogBound: bound,
        windowLength: b,
        bandwidth: m,
        nWindows,
        shrink,
        windowStats,
        tWindows,
        groups: groupList.map((g) => g.len),
        T,
        K,
    };
}

// The shared deterministic subsampling reference used by every family-wise
// procedure below (the SPA reference, the max-t step-down, the single-step
// k-FWER and the FDP step-down). Extracted verbatim from the step-down so the
// arithmetic and order of operations are identical across procedures: the
// single-step k-FWER p-value at k=1 is then EXACTLY the step-down's first
// p-value, and the golden fingerprints are unchanged. Always uses Hansen's
// consistent recentring (a candidate more than se_k*sqrt(2 log log T) below the
// benchmark is recentred to zero) — the whole family is tested jointly, so poor
// candidates must not inflate the reference maximum.
function subsamplingReference({ returnsMatrix, benchmark, windowLength, bandwidth, groups } = {}) {
    const { rel, T, K } = relativePerformance(returnsMatrix, benchmark);
    if (T < 6) throw new Error('reality_check: subsampling needs at least 6 bars');
    const groupList = resolveGroups(T, groups);
    const { b, m } = resolveSubWindows(T, windowLength, bandwidth, groupList);

    const fbar = new Float64Array(K);
    const seFull = new Float64Array(K);
    for (let k = 0; k < K; k++) {
        fbar[k] = mean(rel[k]);
        seFull[k] = groupedFullSE(rel[k], groupList, m, T);
    }
    const bound = Math.sqrt(2 * Math.log(Math.log(T)));
    const recentring = new Float64Array(K);
    for (let k = 0; k < K; k++) {
        recentring[k] = fbar[k] >= -seFull[k] * bound ? fbar[k] : 0;
    }

    const shrink = Math.sqrt(1 - b / T);
    const windows = groupWindowStarts(groupList, b, T);
    const nWindows = windows.length;
    const tWindows = new Float64Array(nWindows * K);
    for (let si = 0; si < nWindows; si++) {
        const s = windows[si];
        const off = si * K;
        for (let k = 0; k < K; k++) {
            tWindows[off + k] = safeRatio((meanSlice(rel[k], s, b) - recentring[k]) / shrink, neweyWestSE(rel[k], s, b, m));
        }
    }

    const tStats = new Float64Array(K);
    for (let k = 0; k < K; k++) tStats[k] = safeRatio(fbar[k], seFull[k]);
    const order = Array.from({ length: K }, (_, k) => k).sort((a, c) => tStats[c] - tStats[a]);

    return { rel, T, K, groupList, b, m, fbar, seFull, recentring, bound, tWindows, nWindows, tStats, order };
}

// Romano & Wolf (2005) step-down max-t on the variance-consistent subsampling
// reference above: identical step logic to `romanoWolfStepM`, but the reference
// maximum is taken over the window studentized statistics instead of the block
// bootstrap's, so the whole procedure inherits the subsampling calibration under
// strong persistence. Controls the family-wise error rate (P(any false
// rejection) <= alpha); for the generalised k-FWER / FDP variants see
// `subsamplingKfwer` and `subsamplingFdp` at the end of this file.
export function subsamplingStepM({ returnsMatrix, benchmark, windowLength, bandwidth, groups, alpha = 0.05 } = {}) {
    ({ benchmark = 0, windowLength = null, bandwidth = null, groups = null, alpha = 0.05 } = { ...DEFAULT_SUB_CONFIG, benchmark, windowLength, bandwidth, groups, alpha });
    if (!(typeof alpha === 'number' && alpha > 0 && alpha < 1)) {
        throw new Error('reality_check: alpha must be in (0,1)');
    }
    const { T, K, groupList, b, m, fbar, seFull, recentring, bound, tWindows, nWindows, tStats, order } =
        subsamplingReference({ returnsMatrix, benchmark, windowLength, bandwidth, groups });

    const stepPValues = new Float64Array(K).fill(1);
    const rejected = new Array(K).fill(false);
    const active = new Array(K).fill(true);
    let nRejected = 0;
    for (let j = 0; j < K; j++) {
        const idx = order[j];
        const threshold = tStats[idx];
        if (!(threshold > 0)) break;
        let exceed = 0;
        for (let s = 0; s < nWindows; s++) {
            const off = s * K;
            let mx = -Infinity;
            for (let k = 0; k < K; k++) {
                if (!active[k]) continue;
                const v = tWindows[off + k];
                if (v > mx) mx = v;
            }
            if (mx > threshold) exceed++;
        }
        const p = exceed / nWindows;
        stepPValues[idx] = p;
        if (p <= alpha) {
            rejected[idx] = true;
            active[idx] = false;
            nRejected++;
        } else {
            break;
        }
    }

    return {
        alpha,
        order,
        tStats: Array.from(tStats),
        stepPValues: Array.from(stepPValues),
        rejected,
        rejectedIndices: rejected.reduce((acc, r, k) => { if (r) acc.push(k); return acc; }, []),
        nRejected,
        bestIndex: order[0],
        bestT: tStats[order[0]],
        means: Array.from(fbar),
        standardErrors: Array.from(seFull),
        recentring: Array.from(recentring),
        logLogBound: bound,
        windowLength: b,
        bandwidth: m,
        nWindows,
        tWindows: Array.from(tWindows),
        groups: groupList.map((g) => g.len),
        T,
        K,
    };
}

// --- Generalised error rates beyond the single max-t step-down ---------------
//
// The max-t step-down above controls the FAMILY-wise error rate (FWER): the
// probability of ANY false rejection. That is the right guarantee when a single
// false discovery is unacceptable, but needlessly strict when the analyst can
// tolerate a small number of false names among the survivors. The two procedures
// below generalise the guarantee in the two standard directions.
//
// `subsamplingKfwer` — the SINGLE-STEP k-FWER (Romano & Wolf 2007, "Control of
// generalized error rates in multiple testing", Annals of Statistics
// 35(4):1378-1408). Candidate i is rejected iff its k-th largest window
// statistic tail probability is <= alpha, where the reference distribution is
// built over the FULL family (no survivor shrinking, so no order-statistic
// inflation). At k=1 this reduces EXACTLY to the first step of
// `subsamplingStepM`. Guarantee: P(k or more false rejections) <= alpha.
//
// `subsamplingFdp` — Romano & Wolf's FDP step-down HEURISTIC (Delattre &
// Roquain 2014, arXiv 1311.4030, section 1.3/1.5; the "bounding device" B(t,k,u)
// is nonincreasing in k). Stepping down the candidates in t-statistic order, at
// step l it applies the k-FWER reference with the GROWING k_l =
// floor(fdpTarget*l)+1. If R candidates clear every step up to l and k_l is that
// last step's k, then FDP <= (k_l - 1)/R with probability 1 - alpha, and the
// procedure reports that bound. Delattre & Roquain prove the heuristic is NOT
// rigorously FDP-controlling in finite samples (it ignores the fluctuation of
// the data-chosen k), so this is an EXPERIMENTAL diagnostic; its measured
// calibration under the global null and under a mixed alternative is disclosed
// in the test suite.
//
// Rejected design (recorded so it is not retried): the natural-looking
// generalisation "at each step compare the surviving candidate's statistic to
// the (1-alpha) quantile of the k-th largest SURVIVOR window statistic" is
// INVALID. The k-th largest of a small survivor set is not an extreme order
// statistic, so a single draw clears it far too often — measured 2-FWER 0.085 at
// T=80 and 0.145 at T=200 against a nominal 0.05. The reference must stay the
// full family, with k growing only with the step index l (never shrinking the
// family). This is why `subsamplingStepM` remains max-t (k=1) only.

// Per-window descending-sorted window statistics: entry [s*K + kk - 1] is the
// kk-th largest of window s's K studentized statistics (kk=1 => the window max).
// One sort per window gives O(nWindows * K log K) and serves every k the FDP
// step-down needs as its k grows with the step index.
function subWindowKthLargest(tWindows, nWindows, K) {
    const sorted = new Float64Array(nWindows * K);
    const row = new Float64Array(K);
    for (let s = 0; s < nWindows; s++) {
        const off = s * K;
        for (let k = 0; k < K; k++) row[k] = tWindows[off + k];
        row.sort();
        for (let k = 0; k < K; k++) sorted[off + k] = row[K - 1 - k];
    }
    return sorted;
}

// Single-step k-FWER on the full-family subsampling reference. Rejects every
// candidate whose own statistic is exceeded by the window k-th-largest reference
// statistic in at most alpha of windows. `k` must be an integer >= 1 and is
// clamped to K (a k-FWER with k > K is vacuous); the clamp is reported. Needs no
// active-set shrinking, so it is deterministic and (unlike the FDP step-down) has
// an exact finite-sample k-FWER bound from the empirical window law.
export function subsamplingKfwer({ returnsMatrix, benchmark, windowLength, bandwidth, groups, alpha = 0.05, k = 2 } = {}) {
    ({ benchmark = 0, windowLength = null, bandwidth = null, groups = null, alpha = 0.05 } = { ...DEFAULT_SUB_CONFIG, benchmark, windowLength, bandwidth, groups, alpha });
    if (!(typeof alpha === 'number' && alpha > 0 && alpha < 1)) {
        throw new Error('reality_check: alpha must be in (0,1)');
    }
    if (!(Number.isInteger(k) && k >= 1)) {
        throw new Error('reality_check: k must be an integer >= 1');
    }
    const { T, K, groupList, b, m, tWindows, nWindows, tStats, order } =
        subsamplingReference({ returnsMatrix, benchmark, windowLength, bandwidth, groups });
    const kk = Math.min(k, K);
    const sorted = subWindowKthLargest(tWindows, nWindows, K);

    const pValues = new Float64Array(K).fill(1);
    const rejected = new Array(K).fill(false);
    let nRejected = 0;
    for (let i = 0; i < K; i++) {
        const threshold = tStats[i];
        if (!(threshold > 0)) continue;
        let exceed = 0;
        for (let s = 0; s < nWindows; s++) {
            if (sorted[s * K + kk - 1] > threshold) exceed++;
        }
        const p = exceed / nWindows;
        pValues[i] = p;
        if (p <= alpha) { rejected[i] = true; nRejected++; }
    }

    return {
        alpha,
        k: kk,
        requestedK: k,
        kClamped: kk !== k,
        nWindows,
        windowLength: b,
        bandwidth: m,
        tStats: Array.from(tStats),
        pValues: Array.from(pValues),
        rejected,
        rejectedIndices: rejected.reduce((acc, r, k2) => { if (r) acc.push(k2); return acc; }, []),
        nRejected,
        order,
        bestIndex: order[0],
        bestT: tStats[order[0]],
        groups: groupList.map((g) => g.len),
        T,
        K,
    };
}

// Romano & Wolf's FDP step-down heuristic — see the block comment above for the
// exact construction, the (k_l - 1)/R bound it reports, and why it is
// EXPERIMENTAL rather than proven-controlling in finite samples.
export function subsamplingFdp({ returnsMatrix, benchmark, windowLength, bandwidth, groups, alpha = 0.05, fdpTarget = 0.1 } = {}) {
    if (!(typeof fdpTarget === 'number' && fdpTarget > 0 && fdpTarget < 1)) {
        throw new Error('reality_check: fdpTarget must be in (0,1)');
    }
    const { T, K, groupList, b, m, tWindows, nWindows, tStats, order } =
        subsamplingReference({ returnsMatrix, benchmark, windowLength, bandwidth, groups });
    const sorted = subWindowKthLargest(tWindows, nWindows, K);
    const kthP = (i, kk) => {
        const threshold = tStats[i];
        if (!(threshold > 0)) return 1;
        let exceed = 0;
        for (let s = 0; s < nWindows; s++) if (sorted[s * K + kk - 1] > threshold) exceed++;
        return exceed / nWindows;
    };

    // Single-step reference grid at every fixed k, with the (k-1)/R FDP bound.
    const perK = [];
    for (let kk = 1; kk <= K; kk++) {
        let nRejectedK = 0;
        for (let i = 0; i < K; i++) if (kthP(i, kk) <= alpha) nRejectedK++;
        perK.push({ k: kk, nRejected: nRejectedK, fdpBound: nRejectedK > 0 ? (kk - 1) / nRejectedK : Infinity });
    }

    // Step-down with the growing k_l = floor(fdpTarget * l) + 1.
    const stepPValues = new Float64Array(K).fill(1);
    const rejected = new Array(K).fill(false);
    let nRejected = 0;
    let kHat = 0;
    for (let l = 1; l <= K; l++) {
        const idx = order[l - 1];
        const kL = Math.min(Math.floor(fdpTarget * l) + 1, K);
        const p = kthP(idx, kL);
        stepPValues[idx] = p;
        if (p <= alpha) {
            rejected[idx] = true;
            nRejected++;
            kHat = kL;
        } else {
            break;
        }
    }

    return {
        alpha,
        fdpTarget,
        kHat,
        nRejected,
        estimatedFdp: nRejected > 0 ? (kHat - 1) / nRejected : null,
        rejected,
        rejectedIndices: rejected.reduce((acc, r, k2) => { if (r) acc.push(k2); return acc; }, []),
        stepPValues: Array.from(stepPValues),
        perK,
        order,
        tStats: Array.from(tStats),
        windowLength: b,
        bandwidth: m,
        nWindows,
        groups: groupList.map((g) => g.len),
        T,
        K,
    };
}
