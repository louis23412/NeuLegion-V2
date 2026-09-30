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

import { mean } from '../performance.js';

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
export function safeRatio(num, den) {
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
