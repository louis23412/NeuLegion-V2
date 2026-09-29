// Walk-forward evaluation harness — the protocol layer that turns a *model*
// (an online predictor that learns over time) into an honest, out-of-sample
// performance report, and turns "should we switch feature X on?" into a
// mechanical, reproducible decision.
//
// Why a dedicated layer on top of `backtest.js`:
//
//   1. `purgedCVBacktest` evaluates a *fixed* signal series; purging protects
//      the metric's independence but does not stop an online model from having
//      seen the future. A walk-forward protocol must (a) train strictly before
//      testing and (b) emit each test bar's position from information available
//      at that bar only.
//   2. "No lookahead" is usually asserted by inspection. Here it is *tested*:
//      `auditNoLookahead` perturbs every return after a test bar and fails if
//      that bar's signal moves. A signal that standardises by a full-series
//      mean, peeks at t+1, or fits on the whole sample is caught automatically.
//   3. Feature promotion ("surprise gate on/off", "uniqueness weights on/off",
//      "homeostasis on/off", "multi-probe on/off") needs a single decision rule
//      that cannot be gamed by one lucky fold: `promoteDecision` requires the
//      candidate to beat the baseline on *pooled* DSR, *mean fold* Sharpe,
//      *positive-fold fraction* and *per-fold win fraction*, with a clean audit.
//
// Pure: no I/O, no RNG. The caller supplies the model through `signalForFold`.
// `signalForFold(trainIdx, testIdx, view)` MUST read the data from `view` rather
// than closing over the raw array — the audit perturbs the view to prove
// causality. A returns-driven model reads `view.returns` (the default view); a
// candle-driven model supplies `viewFor` so the audit perturbs the candle series
// it actually reads (see `analysis/world.js` and docs/BUGS.md #22).
//
// References: Lopez de Prado, AFML ch. 7-8 (purged CV, backtest statistics);
// Pardo, *The Evaluation and Optimization of Trading Strategies* (2008) —
// walk-forward analysis as the deployment-honest alternative to a single split;
// Bailey & Lopez de Prado (2014) — deflated Sharpe; decision-time leakage
// (arXiv 2605.23959) and "What survives honest evaluation?" (arXiv 2608.27734) —
// the latter shows a deliberately leaky oracle posting Sharpe 35 *surviving*
// DSR and PBO, i.e. statistical correction is not a substitute for a structural
// look-ahead guardrail, which is why `auditNoLookahead` exists and the promotion
// gate requires a clean audit.
//
// Round 8 addition: `familywiseSearch` / `walkForwardSearch` put the
// variance-consistent subsampling SPA + Romano-Wolf step-down (Politis & Romano
// 1994; Romano & Wolf 2005) on the honest-evaluation path, and `promoteDecision`
// can require it as an extra hurdle. Grounding for the segment-aware resampling
// (fold lengths passed as `groups`): arXiv 2603.17226 (mean-shift long-run
// variance) and arXiv 2608.23808 (separating search luck from a persistent edge).
//
// Round 9 addition: the same family-wise object can carry the GENERALISED error
// rates of Romano & Wolf (2007, k-FWER, arXiv 0710.2258) and the Romano-Wolf /
// Delattre-Roquain FDP step-down heuristic (arXiv 1311.4030): `kfwer` (opt-in
// integer k) attaches a single-step k-FWER rejection set, and `fdpTarget`
// attaches the FDP-bounded set plus a `promoteDecision` `maxFdp` hurdle. Both are
// default-off, so every default result is byte-identical to Round 8.

//
// analysis/walkforward.js was split byte-exact into analysis/walkforward/ in
// round 74: returns.js, folds.js, audit.js, power.js (incl. powerSummary for
// inter-part use only), report.js, restate.js and search.js. This file
// re-exports the exact contract the lock registry pins, so every existing
// import path keeps working; new code should import the part directly.
export {
    barReturns, logReturns, confidenceToPosition, confidenceFromProb,
    positionSeriesFromConfidence, probToPosition, isCausalFold,
} from './walkforward/returns.js';
export {
    aggregateFolds, blockStability, scoreSignalFullHistory, poolSignalFullHistory,
    buildFullHistoryBlock, foldWinFraction,
} from './walkforward/folds.js';
export { auditNoLookahead, walkForwardEvaluate, walkForwardEvaluateAsync } from './walkforward/audit.js';
export {
    sharpeStandardError, minimumDetectableSharpe, UNDERPOWERED_MDE, barsToDetect,
    dependenceSummary, clustersOf,
} from './walkforward/power.js';
export { poolReports, promoteDecision, pairedPromotionTest } from './walkforward/report.js';
export {
    restateReportAtCost, restateReportAtPolicy, verifyPolicyRoundTrip, exposureDeadZone,
    restateReportAtCadence, exposureMatchedPair, costLadder,
} from './walkforward/restate.js';
export {
    DEPENDENCE_GATE_READER, familyCorrelation, familywiseSearch, walkForwardSearch,
    formatReport,
} from './walkforward/search.js';
