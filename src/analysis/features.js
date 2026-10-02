// The causal signal family for the walk-forward A/B (ROADMAP round 23, N1).
//
// Every feature here is a PURE, POINT-IN-TIME function of the series it is
// handed: `fn(series, t, params)` reads only indices <= t, and nothing in this
// module ever precomputes a whole-series array. A feature therefore cannot
// accidentally see the future, and `auditNoLookahead` run over the audited candle
// view (`analysis/world.js`) *proves* it: perturbing every bar after t must leave
// the position at t unchanged.
//
// A candidate turns a feature into a tradable position through one deterministic,
// parameter-free pipeline:
//
//   raw = fn(series, t, params)                       (point in time)
//   z   = (raw - mean(raw, last zWindow bars)) / std  (causal, sample stddev)
//   pos = clamp(z / saturation, -1, +1)               (0 while the window is not
//                                                      full, or std is 0)
//
// No fitted parameters, no state, no look-ahead: the same bar always yields the
// same position. That is what makes the family comparable under one family-wise
// gate (subsampling SPA / Romano-Wolf step-down) and one DSR floor, and it is why
// the A/B can treat "which feature family carries an edge" as a multiple-testing
// problem rather than a search over tunables.
//
// Round-23 context: `analyze.js` used to run its candidate family over the six
// *mechanism flags* only, so `K` was 7 and P3-1's stated "genuinely larger real
// feature family (fractionally-differenced momentum, volatility regime,
// volume/turnover)" was never actually built. This module is that family.
//
// Grounding: Lopez de Prado, AFML ch. 5 (fractional differentiation preserves
// memory while restoring stationarity), ch. 17 (feature families) and
// `docs/research/financial-validation.md`. The fractional-differencing weights are
// the proven `fractionalDiffWeights` from `labels.js`, not a re-derivation
// (base.js imports it directly).
//
// Round-102 foundations split: the implementation lives in src/analysis/features/
// (four parts); this file carries the exact registered contract so every importer
// keeps working.
export { DEFAULT_POSITION, clampPosition, causalZScore, positionAt, signalForCandidate } from './features/position.js';
export { momentum, fracDiffAt, fracMomentum, volRegime, momentumAgreement, rangeLocation, volumeImbalance, autocorr1, acceleration, SIGNAL_CANDIDATES } from './features/base.js';
export { reversal, reversalWindow, reversalVol, crossSectionalReversal, REVERSAL_CANDIDATES } from './features/reversal.js';
export { panelMean, demeanedFn, xsMomentum, volScaledMomentum, blendedMomentum, networkMomentum, regimeGatedMomentum, SIGUP_CANDIDATES } from './features/upgrades.js';
