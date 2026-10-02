// Variance-consistent subsampling inference (round-94 split, part 2 of 2).
// Moved byte-exact from analysis/reality_check.js; re-exported by its shim.
// The shared inputs (relativePerformance/safeRatio in ./bootstrap/inputs.js,
// mean in ../performance.js) are imported by the part files that use them
// (windows.js, procedures.js), not here.
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

// Round-108 foundations split: the implementation lives in src/analysis/reality_check/subsampling/
// (windows.js + procedures.js, bodies byte-identical; five helpers + subsamplingReference +
// subWindowKthLargest gain export for inter-part use); this file carries the exact registered
// contract so every importer keeps working.
export { DEFAULT_SUB_CONFIG, neweyWestSE } from './subsampling/windows.js';
export { subsamplingSpa, subsamplingStepM, subsamplingKfwer, subsamplingFdp } from './subsampling/procedures.js';
