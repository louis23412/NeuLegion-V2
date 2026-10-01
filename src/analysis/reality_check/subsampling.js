// Variance-consistent subsampling inference (round-94 split, part 2 of 2).
// Moved byte-exact from analysis/reality_check.js; re-exported by its shim.
// Shares relativePerformance/safeRatio from ./bootstrap.js (registered there,
// not duplicated) and mean from ../performance.js.
import { mean } from '../performance.js';
import { relativePerformance, safeRatio } from './bootstrap/inputs.js';
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
