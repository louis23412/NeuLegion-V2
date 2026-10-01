// Forecast scoring (round 26, R26-14) — split from `analysis/forecast.js` in
// round 71 (byte-exact move; the `forecast.js` re-export shim keeps every
// import path working). Proper scores (Brier/Murphy/log), the block-bootstrapped
// Diebold-Mariano test, the Model Confidence Set, the kind-grouped family
// comparison and the human-summary renderer.
//
// Round-104 foundations split: the implementation lives in src/analysis/forecast/scoring/
// (three parts, bodies byte-identical; the private `isArr`/`finite` guards gain
// `export` in scores.js for inter-part use and are not re-exported here); this
// file carries the exact registered contract so every importer keeps working.
export { forecastPairs, brierBinIndex, brierScore, logScore, brierDecomposition, brierLosses } from './scoring/scores.js';
export { bootstrapMeans, dieboldMariano, modelConfidenceSet } from './scoring/resampling.js';
export { forecastComparison, formatForecast } from './scoring/comparison.js';
