// src/analysis/dependence/clusters.js (round-101 split of src/analysis/dependence.js).
// Fold-window clusters + the delete-one-cluster jackknife family.
import { studentTPValue } from './student.js';
// Group a per-stream panel into fold-window clusters: cluster f holds, for every
// stream, the returns of that stream's fold f. This is the cluster unit the rest
// of the harness already respects (a fold is one refit; a calendar window is one
// market event, so the same window in 8 symbols is one observation of the
// candidate's behaviour, not 8).
//
// `streamReturns` is one flat array of pooled returns per stream; `foldLength`
// is the fold length (the same for every fold and every stream — the walk-forward
// produces a rectangular fold grid). Streams must be equal length and exactly
// divisible by `foldLength`; anything else throws rather than silently
// mis-grouping.
export function foldWindowClusters(streamReturns, foldLength) {
    if (!Array.isArray(streamReturns) || streamReturns.length < 1) {
        throw new Error('dependence: streamReturns must be a non-empty array of streams');
    }
    if (!Number.isInteger(foldLength) || foldLength < 1) {
        throw new Error('dependence: foldLength must be a positive integer');
    }
    const nBars = streamReturns[0].length;
    for (const s of streamReturns) {
        if (!Array.isArray(s) || s.length !== nBars) {
            throw new Error('dependence: every stream must be an equal-length array (a rectangular fold grid)');
        }
    }
    if (nBars % foldLength !== 0) {
        throw new Error('dependence: stream length must be an exact multiple of foldLength');
    }
    const nFolds = nBars / foldLength;
    const clusters = [];
    for (let f = 0; f < nFolds; f++) {
        const from = f * foldLength;
        const to = from + foldLength;
        const cluster = [];
        for (const s of streamReturns) for (let t = from; t < to; t++) cluster.push(s[t]);
        clusters.push(cluster);
    }
    return clusters;
}

// Concatenate clusters (the order does not matter for an order-invariant
// statistic such as the Sharpe ratio; it does matter for anything reading the
// equity path, so callers that need the original order should not use the
// jackknife's leave-one-out estimates for that).
export function concatClusters(clusters, dropIndex = -1) {
    const out = [];
    for (let c = 0; c < clusters.length; c++) {
        if (c === dropIndex) continue;
        for (const x of clusters[c]) out.push(x);
    }
    return out;
}

// The delete-one-cluster jackknife of a statistic over clustered observations.
//
//   estimate   = statistic(every cluster concatenated)
//   theta_{-c} = statistic(every cluster but c)
//   SE^2       = ((C-1)/C) * sum_c (theta_{-c} - mean_c theta_{-c})^2
//
// NaN (with `reason`) when the estimate is not finite or fewer than two clusters
// are supplied — a jackknife needs something to delete.
export function clusterJackknife({ clusters, statistic }) {
    if (!Array.isArray(clusters) || clusters.length < 2) {
        return { estimate: NaN, se: NaN, nClusters: Array.isArray(clusters) ? clusters.length : 0, reason: 'need at least 2 clusters' };
    }
    if (typeof statistic !== 'function') throw new Error('dependence: statistic must be a function of one array');
    const estimate = statistic(concatClusters(clusters));
    if (!Number.isFinite(estimate)) return { estimate, se: NaN, nClusters: clusters.length, reason: 'estimate is not finite' };
    const C = clusters.length;
    const theta = new Array(C);
    for (let c = 0; c < C; c++) theta[c] = statistic(concatClusters(clusters, c));
    const fine = theta.filter((t) => Number.isFinite(t));
    if (fine.length !== C) return { estimate, se: NaN, nClusters: C, reason: 'a leave-one-cluster-out statistic is not finite' };
    const mean = fine.reduce((a, b) => a + b, 0) / C;
    let acc = 0;
    for (const t of fine) acc += (t - mean) * (t - mean);
    return { estimate, se: Math.sqrt(((C - 1) / C) * acc), nClusters: C, leaveOneOut: theta };
}

// Compare two panels on the same clusters: D = statistic(A) - statistic(B), with
// the same delete-one-cluster jackknife applied to the DIFFERENCE (so the
// candidate and the baseline see exactly the same observations in every
// replicate — this is a paired test, in the same sense that `foldWinFraction`
// pairs folds, but with the clustering honoured).
//
// The reference distribution is Student-t with C-1 degrees of freedom, the
// standard choice for a cluster-robust t statistic with a moderate number of
// clusters (`clusterjackknife2602` reports the same remedy for over-rejection
// with few clusters); with C = 36 windows t(35) is ~3% wider than the normal in
// the tail, so the test is slightly conservative rather than anti-conservative.
export function pairedClusterTest({ clustersA, clustersB, statistic, alpha = 0.05 }) {
    const nA = Array.isArray(clustersA) ? clustersA.length : 0;
    const nB = Array.isArray(clustersB) ? clustersB.length : 0;
    if (nA !== nB || nA < 2) return { available: false, reason: 'panels must share the same >= 2 clusters', nClusters: nA };
    const diffs = new Array(nA);
    for (let c = 0; c < nA; c++) {
        const a = statistic(concatClusters(clustersA, c));
        const b = statistic(concatClusters(clustersB, c));
        diffs[c] = a - b;
    }
    if (!diffs.every((d) => Number.isFinite(d))) return { available: false, reason: 'a leave-one-cluster-out difference is not finite', nClusters: nA };
    const value = statistic(concatClusters(clustersA)) - statistic(concatClusters(clustersB));
    const C = nA;
    const mean = diffs.reduce((x, y) => x + y, 0) / C;
    let acc = 0;
    for (const d of diffs) acc += (d - mean) * (d - mean);
    const se = Math.sqrt(((C - 1) / C) * acc);
    const df = C - 1;
    const t = se > 0 ? value / se : (value === 0 ? 0 : (value > 0 ? Infinity : -Infinity));
    const pOneSided = studentTPValue(t, df, { twoSided: false });
    const pTwoSided = studentTPValue(t, df, { twoSided: true });
    return {
        available: true,
        alpha,
        value,
        se,
        t,
        df,
        nClusters: C,
        pOneSided,
        pTwoSided,
        // One-sided: "the candidate's Sharpe exceeds the baseline's".
        significant: Number.isFinite(pOneSided) && pOneSided <= alpha,
    };
}

// Cluster stability: does the pooled edge SURVIVE deleting any single fold-window
// cluster? This is the statistical form of "the edge is not carried by a handful
// of windows" (round 26, R26-7). For each cluster c it recomputes the candidate
// minus baseline statistic on the panel with c removed; `worstDelta` is the
// smallest leave-one-out difference and `fractionPositive` the share that stay
// positive. `stable` requires `fractionPositive >= minFraction` (default: every
// cluster) AND `worstDelta > minDelta` (default 0). A candidate whose full-sample
// edge is positive but which loses money once one window is removed is exactly the
// fragile case a raw win-fraction or sign test cannot see.
export function clusterStability({ clustersA, clustersB, statistic, minFraction = 1, minDelta = 0 }) {
    const nA = Array.isArray(clustersA) ? clustersA.length : 0;
    const nB = Array.isArray(clustersB) ? clustersB.length : 0;
    if (nA !== nB || nA < 2) return { available: false, reason: 'panels must share the same >= 2 clusters', nClusters: nA };
    const full = statistic(concatClusters(clustersA)) - statistic(concatClusters(clustersB));
    const leaveOneOut = [];
    for (let c = 0; c < nA; c++) {
        const delta = statistic(concatClusters(clustersA, c)) - statistic(concatClusters(clustersB, c));
        leaveOneOut.push({ cluster: c, delta });
    }
    if (!leaveOneOut.every((r) => Number.isFinite(r.delta))) {
        return { available: false, reason: 'a leave-one-cluster-out difference is not finite', nClusters: nA };
    }
    let worst = leaveOneOut[0];
    for (const r of leaveOneOut) if (r.delta < worst.delta) worst = r;
    const positive = leaveOneOut.filter((r) => r.delta > minDelta).length;
    const fractionPositive = positive / leaveOneOut.length;
    // The documented rule is the AND: enough positive windows AND no collapse
    // when the worst window is removed (L10-cl — the fraction alone admitted a
    // candidate whose edge vanishes without its best window). At the shipped
    // defaults (minFraction 1, minDelta 0) the second conjunct is implied by
    // the first (fraction 1 of n>=2 means every delta > 0, so worst > 0), so
    // default reports are byte-identical; only a loosened threshold changes.
    return {
        available: true,
        nClusters: nA,
        full,
        worstCluster: worst.cluster,
        worstDelta: worst.delta,
        fractionPositive,
        leaveOneOut,
        minFraction,
        minDelta,
        stable: fractionPositive >= minFraction - 1e-12 && worst.delta > minDelta,
    };
}

// The breadth (win-consistency) test: on each cluster, did the candidate's
// statistic beat the baseline's? Ties are dropped (they carry no sign
// information), and the result is an exact sign test — no distributional
// assumption, no approximation beyond the binomial (Demsar 2006, §"the sign
// test", recommends exactly this as the robust choice when comparing models over
// paired samples).
//
// This is the error-controlled replacement for a raw "win fraction >= 0.5"
// threshold: a fraction of 0.49 and a fraction of 0.51 are the same evidence, and
// a threshold with no reference distribution cannot say that.
export function pairedClusterSignTest({ clustersA, clustersB, statistic }) {
    const nA = Array.isArray(clustersA) ? clustersA.length : 0;
    const nB = Array.isArray(clustersB) ? clustersB.length : 0;
    if (nA !== nB || nA < 1) return { available: false, reason: 'panels must share the same >= 1 clusters', nClusters: nA };
    const signs = [];
    for (let c = 0; c < nA; c++) {
        // PER-WINDOW: compare THIS cluster's statistic to the baseline's. The
        // delete-one-cluster form (`concatClusters(a, c)`) belongs to
        // `pairedClusterTest` and `clusterStability`; using it here made the sign
        // test a leave-one-out stability test instead of the error-controlled
        // win-fraction it replaces (and duplicated `clusterStability`'s job).
        const a = statistic(clustersA[c]);
        const b = statistic(clustersB[c]);
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        if (a > b) signs.push(1); else if (a < b) signs.push(-1); else signs.push(0);
    }
    const wins = signs.filter((s) => s > 0).length;
    const losses = signs.filter((s) => s < 0).length;
    const ties = signs.filter((s) => s === 0).length;
    const n = wins + losses;
    if (n < 1) return { available: false, reason: 'no informative (tied-free) clusters', wins, losses, ties, nClusters: nA };
    const test = signTest({ wins, n });
    return {
        available: true,
        wins, losses, ties,
        n,
        nClusters: nA,
        fraction: wins / n,
        pValue: test.pValue,
        significant: Number.isFinite(test.pValue) && test.pValue <= 0.05,
    };
}

// Exact one-sided (default) binomial sign test at p = 0.5. `pValue` is
// P(X >= wins) under the null, computed by summation rather than an incomplete
// beta so the answer is exact in double precision for the cluster counts this
// harness sees (tens to a few hundred).
export function signTest({ wins, n, alpha = 0.05 }) {
    if (!Number.isInteger(wins) || !Number.isInteger(n) || n < 1 || wins < 0 || wins > n) {
        return { wins, n, pValue: NaN, alpha };
    }
    const pmf0 = Math.pow(0.5, n);
    // Fail closed past the exact walk's range (L10-cm): at n >= ~1075, 2^-n
    // underflows the double range, so pmf0 is exactly 0 and the loop below
    // would report pValue 0 (certainly significant) for ANY win count — the
    // unsafe direction. In-range behavior is untouched.
    if (!(pmf0 > 0)) {
        return { wins, n, pValue: NaN, alpha, reason: 'n exceeds the exact-walk range (2^-n underflows); use an asymptotic or log-space test' };
    }
    let pmf = pmf0;
    let tail = 0;
    for (let k = 0; k <= n; k++) {
        if (k >= wins) tail += pmf;
        pmf = (pmf * (n - k)) / (k + 1);
    }
    const pValue = Math.min(1, tail);
    return { wins, n, pValue, alpha, significant: pValue <= alpha };
}

// The smallest p-value a sign test on `n` informative clusters can produce, i.e.
// "every cluster won" — the resolution floor of the test. Reported so a verdict
// can distinguish "failed the test" from "could not have passed it": with 36
// clusters the floor is 2^-36, but with 4 clusters it is 1/16 = 0.0625, which no
// alpha of 0.05 can ever reach.
export function signTestFloor(n) {
    if (!Number.isInteger(n) || n < 1) return NaN;
    return Math.pow(0.5, n);
}
