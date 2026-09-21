// Time-series cross-validation with purging and embargoing.
//
// Standard K-fold CV leaks on financial data: a label observed at time t uses
// information up to t + horizon, so a test fold's information bleeds into the
// training folds that sit next to it. Purged K-fold removes the training samples
// whose label windows overlap the test set, and an additional embargo removes a
// band *after* the test set to kill serial-correlation bleed.
//
// Reference: Lopez de Prado, "Advances in Financial Machine Learning", ch. 7.
//
// Pure: no I/O, no RNG. Inputs are indices, so the module is agnostic to the
// caller's feature/label representation.

// Normalise a label representation to a list of [startIndex, endIndex] ranges.
// Accepts:
//   - a positive integer `labelSpan`: every observation i spans [i, i+span-1]
//   - an array of [start, end] pairs
//   - an array of { start, end } objects
//   - an array of numbers (treated as each label's end index)
export function normalizeLabelSpans(labels, n, labelSpan) {
    if (Number.isInteger(labelSpan) && labelSpan > 0) {
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = [i, Math.min(n - 1, i + labelSpan - 1)];
        return out;
    }
    if (Array.isArray(labels)) {
        return labels.map((l, i) => {
            if (Array.isArray(l)) return [l[0], l[1]];
            if (l && typeof l === 'object') return [l.start, l.end];
            return [i, l];
        });
    }
    // Default: point labels.
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = [i, i];
    return out;
}

function overlaps(a, b) {
    return a[0] <= b[1] && b[0] <= a[1];
}

// Purged K-fold split.
//   n          — number of observations
//   k          — number of folds
//   embargo    — number of indices AFTER each test block to purge from training
//   labels     — optional per-observation [start,end] ranges
//   labelSpan  — used when `labels` is absent (positive integer)
// Returns [{ train: number[], test: number[], testStart, testEnd }].
export function purgedKFoldSplit({ n, k, embargo = 0, labels = null, labelSpan = 1 } = {}) {
    if (!Number.isInteger(n) || n <= 0) throw new Error('purgedKFoldSplit: n must be a positive integer');
    if (!Number.isInteger(k) || k <= 0) throw new Error('purgedKFoldSplit: k must be a positive integer');
    if (k > n) throw new Error('purgedKFoldSplit: k must be <= n');
    const spans = normalizeLabelSpans(labels, n, labelSpan);

    const foldSize = Math.floor(n / k);
    const remainder = n % k;
    const folds = [];
    let cursor = 0;
    for (let f = 0; f < k; f++) {
        const size = foldSize + (f < remainder ? 1 : 0);
        const test = [];
        for (let i = 0; i < size; i++) test.push(cursor + i);
        cursor += size;
        folds.push(test);
    }

    return folds.map((test) => {
        const testStart = test[0];
        const testEnd = test[test.length - 1];
        // Purge zone: test window expanded to cover any training label that
        // overlaps the test labels, plus the embargo band after the test set.
        let purgeStart = testStart;
        let purgeEnd = testEnd;
        for (const t of test) {
            purgeStart = Math.min(purgeStart, spans[t][0]);
            purgeEnd = Math.max(purgeEnd, spans[t][1]);
        }
        const embargoEnd = Math.min(n - 1, purgeEnd + embargo);
        const testSet = new Set(test);
        const train = [];
        for (let i = 0; i < n; i++) {
            if (testSet.has(i)) continue;
            // Drop anything whose label window overlaps the purge zone.
            if (overlaps(spans[i], [purgeStart, embargoEnd])) continue;
            train.push(i);
        }
        return { train, test, testStart, testEnd, purgeStart, purgeEnd, embargoEnd };
    });
}

// Walk-forward (anchored/expanding) split. Produces chronological folds where
// training always precedes testing — the realistic deployment order.
//
// `step` must be a positive finite number. A zero (or negative, or NaN) step
// used to make `trainEnd` never advance, so the loop never terminated — a hang,
// not an error (BUGS.md #12).
export function walkForwardSplit({ n, trainSize, testSize, step = null, expanding = false } = {}) {
    if (!(n > 0) || !(trainSize > 0) || !(testSize > 0)) {
        throw new Error('walkForwardSplit: n, trainSize, testSize must be positive');
    }
    if (step != null && (!Number.isFinite(step) || step <= 0)) {
        throw new Error('walkForwardSplit: step must be a positive finite number');
    }
    const stride = step != null ? step : testSize;
    const folds = [];
    let trainEnd = trainSize;
    while (trainEnd + testSize <= n) {
        const trainStart = expanding ? 0 : trainEnd - trainSize;
        const train = [];
        for (let i = trainStart; i < trainEnd; i++) train.push(i);
        const test = [];
        for (let i = trainEnd; i < trainEnd + testSize; i++) test.push(i);
        folds.push({ train, test, testStart: trainEnd, testEnd: trainEnd + testSize - 1 });
        trainEnd += stride;
    }
    return folds;
}

// Verify a split has no train/test leakage. Returns [] when clean.
export function assertNoLeakage(fold, { n, labels = null, labelSpan = 1 } = {}) {
    const spans = normalizeLabelSpans(labels, n, labelSpan);
    const testSpans = fold.test.map((t) => spans[t]);
    const problems = [];
    for (const i of fold.train) {
        for (const ts of testSpans) {
            if (overlaps(spans[i], ts)) { problems.push(i); break; }
        }
    }
    return problems;
}

// Enumerate all combinations of `r` indices drawn from 0..k-1, lexicographically.
// (Small k only — the caller is combinatorial CV, whose whole point is C(k, m).)
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

// Binomial coefficient C(n, r) without enumerating, so a caller can be rejected
// before it tries to materialise millions of folds (BUGS.md #13).
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

// Upper bound on the number of folds a combinatorial split may materialise.
const MAX_COMBINATORIAL_FOLDS = 100000;

// Combinatorial purged cross-validation (Lopez de Prado, AFML ch. 12).
//
// Partition the n observations into `k` contiguous groups, then take *every*
// choice of `testGroups = m` groups as a test set — C(k, m) folds. Each fold's
// test set is therefore a union of whole groups, and each observation is tested
// exactly C(k-1, m-1) times across the folds. That multiplicity is the point: the
// C(k-1, m-1) folds through any one group's test slot form a *backtest path*, so
// the fold metrics are a distribution over paths rather than one number — the
// statistically honest way to judge a strategy when a single split is one sample
// of a non-stationary process.
//
// Training rows whose label window overlaps the (hull of the) test blocks are
// purged, and `embargo` further drops a band after the hull — same discipline as
// purgedKFoldSplit. Works with `purgedCVBacktest` / `walkForwardEvaluate`
// (the latter with `requireCausal: false`, since CPCV trains on both sides).
export function combinatorialPurgedSplit({ n, k, testGroups = 1, embargo = 0, labels = null, labelSpan = 1 } = {}) {
    if (!Number.isInteger(n) || n <= 0) throw new Error('combinatorialPurgedSplit: n must be a positive integer');
    if (!Number.isInteger(k) || k < 2) throw new Error('combinatorialPurgedSplit: k must be an integer >= 2');
    if (k > n) throw new Error('combinatorialPurgedSplit: k must be <= n');
    if (!Number.isInteger(testGroups) || testGroups < 1 || testGroups >= k) {
        throw new Error('combinatorialPurgedSplit: testGroups must be an integer in [1, k-1]');
    }
    const foldCount = binomialCount(k, testGroups);
    if (foldCount > MAX_COMBINATORIAL_FOLDS) {
        throw new Error(`combinatorialPurgedSplit: C(${k},${testGroups}) = ${foldCount} folds exceeds the cap of ${MAX_COMBINATORIAL_FOLDS}; reduce k`);
    }
    const spans = normalizeLabelSpans(labels, n, labelSpan);

    const groupSize = Math.floor(n / k);
    const remainder = n % k;
    const groups = [];
    let cursor = 0;
    for (let g = 0; g < k; g++) {
        const len = groupSize + (g < remainder ? 1 : 0);
        const idx = [];
        for (let i = 0; i < len; i++) idx.push(cursor + i);
        cursor += len;
        groups.push(idx);
    }

    return combinations(k, testGroups).map((combo) => {
        const testSet = new Set();
        for (const g of combo) for (const i of groups[g]) testSet.add(i);
        const test = [...testSet].sort((a, b) => a - b);
        const testStart = test[0];
        const testEnd = test[test.length - 1];
        let purgeStart = testStart;
        let purgeEnd = testEnd;
        for (const t of test) {
            purgeStart = Math.min(purgeStart, spans[t][0]);
            purgeEnd = Math.max(purgeEnd, spans[t][1]);
        }
        const embargoEnd = Math.min(n - 1, purgeEnd + embargo);
        const train = [];
        for (let i = 0; i < n; i++) {
            if (testSet.has(i)) continue;
            if (overlaps(spans[i], [purgeStart, embargoEnd])) continue;
            train.push(i);
        }
        return { train, test, testStart, testEnd, purgeStart, purgeEnd, embargoEnd, groups: combo };
    });
}
