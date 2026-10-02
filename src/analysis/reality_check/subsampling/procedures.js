// src/analysis/reality_check/subsampling/procedures.js (round-108 split of src/analysis/reality_check/subsampling.js).
// The family-wise procedures on the shared deterministic reference: SPA, step-down, k-FWER, FDP.
// Moved byte-exact (subsamplingReference/subWindowKthLargest gain export for inter-part use,
// not re-exported by the shim); re-exported by the subsampling.js shim.
import { mean } from '../../performance.js';
import { relativePerformance, safeRatio } from '../bootstrap/inputs.js';
import { DEFAULT_SUB_CONFIG, neweyWestSE, meanSlice, resolveGroups, resolveSubWindows, groupedFullSE, groupWindowStarts } from './windows.js';
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

export function subsamplingReference({ returnsMatrix, benchmark, windowLength, bandwidth, groups } = {}) {
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
export function subWindowKthLargest(tWindows, nWindows, K) {
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
