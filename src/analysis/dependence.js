// NeuLegion analysis component: dependence-aware inference for the pooled
// cross-stream evaluation (round 25).
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
// `poolReports` concatenates one walk-forward per symbol (stream) into a single
// pooled out-of-sample return stream and scores it with the large-sample Sharpe
// standard error of Lo (2002) — which assumes the bars are independent draws.
// On the attempt-3 power run (`20260920T144633-seed1`) that assumption is false
// in a way the report could not see:
//
//   - **cross-stream.** The 8 streams are crypto majors, and their per-fold
//     Sharpe series correlate 0.41-0.52 (measured from the run's journal:
//     `RUN-ANALYSIS.md` §5.6(d)). Eight correlated copies of one bet are not
//     eight independent observations.
//   - **the fold structure.** The 4,320 pooled bars are 288 fold windows x 8
//     streams; `reality_check#resolveGroups` already treats a fold boundary as a
//     segment boundary (a different refit model, a different mean level — the
//     mean-shift long-run-variance result, arXiv 2603.17226), so the fold window
//     is the sample's natural independent unit here too.
//
// The i.i.d. SE understates the true SE by ~2x on that run, and
// `power.underpowered` read `false` while the honest MDE95 was ≈ ±1 Sharpe.
//
// ---------------------------------------------------------------------------
// What it provides
// ---------------------------------------------------------------------------
// A *cluster* view of the pooled sample. Observations are grouped into clusters
// (one cluster = one fold window across all streams); clusters are taken to be
// the independent units, and the standard error of any smooth statistic is
// estimated with the **delete-one-cluster jackknife**
//
//     SE^2 = ((C-1)/C) * sum_c ( theta_{-c} - mean_c(theta_{-c}) )^2
//
// (Efron 1979 for the jackknife; Cameron & Miller 2015 §IV for the clustered
// case and the "clusters are the independent units" rule; `clusterjackknife2602`
// for a 2026 application where it repairs over-rejection with few/unequal
// clusters). It is deliberately deterministic — no RNG, no bootstrapped block
// length, nothing to seed — which keeps a long run's report reproducible, and it
// captures serial dependence, cross-stream dependence and non-normality at once
// because the statistic is simply re-evaluated on the panel with one cluster
// deleted.
//
// The module is pure: it takes clusters plus a `statistic(cluster arrays) =>
// number` and imports nothing (so it is directly unit-testable, and cannot reach
// the locked hot path).
//
// ---------------------------------------------------------------------------
// What it is NOT
// ---------------------------------------------------------------------------
// An effective number of independent *tests* is reported as a diagnostic only
// (`equicorrelationEffectiveSize`, Kish 1965 design effect). Methods built on an
// effective number of independent tests do **not** control the family-wise error
// rate (arXiv 1612.04535, which tests exactly the genomics methods that grew out
// of Cheverud/Nyholt), so the family-wise gate keeps the searched K — correlated
// tests are still tests that were run (Harvey, Liu & Zhu 2016) — and K is what
// the deflated Sharpe keeps.

// Pearson product-moment correlation between two equal-length series. Returns
// NaN for a pair with fewer than three points or a zero-variance member (there is
// no correlation to speak of, and silently returning 0 would bias the average
// correlation down).
export function pearsonCorrelation(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length < 3) return NaN;
    const n = a.length;
    let ma = 0; let mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let sab = 0; let sa = 0; let sb = 0;
    for (let i = 0; i < n; i++) {
        const da = a[i] - ma; const db = b[i] - mb;
        sab += da * db; sa += da * da; sb += db * db;
    }
    if (!(sa > 0) || !(sb > 0)) return NaN;
    return sab / Math.sqrt(sa * sb);
}

// Mean pairwise correlation across a list of series (e.g. one per-fold Sharpe
// series per stream). Pairs that cannot be correlated are skipped; NaN when no
// pair survives or when the series are too few to form one.
export function meanPairwiseCorrelation(seriesList) {
    if (!Array.isArray(seriesList) || seriesList.length < 2) return NaN;
    const rs = [];
    for (let i = 0; i < seriesList.length; i++) {
        for (let j = i + 1; j < seriesList.length; j++) {
            const r = pearsonCorrelation(seriesList[i], seriesList[j]);
            if (Number.isFinite(r)) rs.push(r);
        }
    }
    if (!rs.length) return NaN;
    return rs.reduce((x, y) => x + y, 0) / rs.length;
}

// The equicorrelation design effect: with K units of equal size and a common
// pairwise correlation rho, the variance of the mean is inflated by
// 1 + (K-1)*rho (Kish, *Survey Sampling*, 1965; the survey-sampling "deff").
// Negative average correlation *reduces* the variance, which is legitimate —
// hedging streams really do buy more than one independent observation — so the
// raw rho is used rather than clamped at zero.
export function equicorrelationDesignEffect(k, rho) {
    if (!Number.isFinite(k) || k < 1) return NaN;
    if (!Number.isFinite(rho)) return NaN;
    return 1 + (k - 1) * rho;
}

// K correlated streams are worth this many independent ones (Kish 1965).
export function equicorrelationEffectiveSize(k, rho) {
    const deff = equicorrelationDesignEffect(k, rho);
    if (!Number.isFinite(deff) || deff <= 0) return NaN;
    return k / deff;
}

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
        const a = statistic(concatClusters(clustersA, c));
        const b = statistic(concatClusters(clustersB, c));
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

// ---------------------------------------------------------------------------
// Student-t CDF (regularised incomplete beta, Numerical Recipes 6.4)
// ---------------------------------------------------------------------------
// Included because the cluster-robust p-values above are referenced to t(C-1),
// and the project has no t distribution anywhere else. Verified against exact
// table values in `analysis.test.js` (t = 2.0301 at df = 35 is two-sided 0.05).

function gammln(xx) {
    const cof = [
        76.18009172947146, -86.50532032941677, 24.01409824083091,
        -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
    ];
    let x = xx;
    let y = xx;
    let tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) {
        y += 1;
        ser += cof[j] / y;
    }
    return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a, b, x) {
    const FPMIN = 1e-300;
    const qab = a + b;
    const qap = a + 1;
    const qam = a - 1;
    let c = 1;
    let d = 1 - (qab * x) / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 200; m++) {
        const m2 = 2 * m;
        let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c;
        if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d;
        h *= d * c;
        aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c;
        if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < 3e-16) break;
    }
    return h;
}

// I_x(a,b): the regularised incomplete beta function.
export function regularizedIncompleteBeta(a, b, x) {
    if (!(a > 0) || !(b > 0) || !Number.isFinite(x)) return NaN;
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(
        gammln(a + b) - gammln(a) - gammln(b) + a * Math.log(x) + b * Math.log(1 - x),
    );
    if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
    return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

// P(T > t) for a Student-t with `df` degrees of freedom (one-sided), or the
// two-sided p-value when `twoSided`. t = 0 gives exactly 0.5 / 1.
//
// The infinite cases are handled BEFORE the finite guard: a cluster-robust t can
// be exactly +-Infinity when the delete-one-cluster differences are degenerate
// (zero jackknife SE with a non-zero difference), and p must be 0 there — the
// guard used to swallow them and return NaN, which silently turned a perfectly
// dominant candidate into "not significant".
export function studentTPValue(t, df, { twoSided = true } = {}) {
    if (!Number.isFinite(df) || df <= 0) return NaN;
    if (t === Infinity) return twoSided ? 0 : 0;
    if (t === -Infinity) return twoSided ? 0 : 1;
    if (!Number.isFinite(t)) return NaN;
    const x = df / (df + t * t);
    const oneSidedUpper = 0.5 * regularizedIncompleteBeta(df / 2, 0.5, x);
    if (twoSided) return Math.min(1, 2 * oneSidedUpper);
    return t >= 0 ? oneSidedUpper : 1 - oneSidedUpper;
}

// Alias kept only so the lock registry/test naming convention has a stable name.
// CAUTION: this returns a p-value (an upper-tail probability), NOT a cumulative
// distribution value — `studentTCdf(-Infinity)` is 1, not 0. Use `studentTPValue`
// and read the option; a true CDF would be `1 - studentTPValue(t, df, { twoSided: false })`.
export const studentTCdf = studentTPValue;
