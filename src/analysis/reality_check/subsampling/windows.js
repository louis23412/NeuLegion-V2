// src/analysis/reality_check/subsampling/windows.js (round-108 split of src/analysis/reality_check/subsampling.js).
// Window machinery: config, Newey-West SE, segment resolution, window starts, pooled SE.
// Moved byte-exact (meanSlice/resolveGroups/resolveSubWindows/groupedFullSE/groupWindowStarts gain export
// for inter-part use, not re-exported by the shim); re-exported by the subsampling.js shim.
// The `mean` import is dropped (only a comment mentions it here; the procedures keep it).
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

export function meanSlice(series, from, len) {
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

export function resolveGroups(T, groups) {
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

export function resolveSubWindows(T, windowLength, bandwidth, groupList) {
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

export function groupedFullSE(series, groupList, m, T) {
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

export function groupWindowStarts(groupList, b, T) {
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
