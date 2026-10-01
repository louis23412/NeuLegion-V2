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

// Round-107 foundations split: the implementation lives in src/analysis/reality_check/bootstrap/
// (inputs.js + resampling.js + tests.js, bodies byte-identical; mulberry32/bootstrapStdErrors/
// studentizedBoot/spaCore gain export for inter-part use); this file carries the exact registered
// contract so every importer keeps working.
export { DEFAULT_RC_CONFIG, benchmarkSeries, relativePerformance } from './bootstrap/inputs.js';
export { stationaryBlockIndices, politisWhiteBlockLength, autoBlockLength, bootstrapRelativeMeans } from './bootstrap/resampling.js';
export { whiteRealityCheck, hansenSpa, consistentRecentring, hansenSpaConsistent, romanoWolfStepM } from './bootstrap/tests.js';
