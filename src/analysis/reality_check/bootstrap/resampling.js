// src/analysis/reality_check/bootstrap/resampling.js (round-107 split of src/analysis/reality_check/bootstrap.js).
// The stationary-bootstrap engine: rng stream, index draws, block-length selection, shared draws, standard errors.
// Moved byte-exact (mulberry32/bootstrapStdErrors/studentizedBoot gain export for inter-part use,
// not re-exported by the shim); re-exported by the bootstrap.js shim.
import { mean } from '../../performance.js';
import { safeRatio } from './inputs.js';
export function mulberry32(seed) {
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

export function bootstrapStdErrors(fbar, fbarBoot, nBoot, K) {
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

export function studentizedBoot(fbarBoot, recentring, omega, nBoot, K) {
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
