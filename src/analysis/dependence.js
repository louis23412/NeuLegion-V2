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
//
// Round-101 foundations split: the implementation lives in src/analysis/dependence/
// (three parts); this file carries the exact registered contract so every importer
// keeps working.
export { pearsonCorrelation, meanPairwiseCorrelation, equicorrelationDesignEffect, equicorrelationEffectiveSize } from './dependence/correlation.js';
export { foldWindowClusters, concatClusters, clusterJackknife, pairedClusterTest, clusterStability, pairedClusterSignTest, signTest, signTestFloor } from './dependence/clusters.js';
export { regularizedIncompleteBeta, studentTCritical, studentTPValue, studentTCdf, firstPCWeights, factorNeutralResidual, factorNeutralSharpe } from './dependence/student.js';
