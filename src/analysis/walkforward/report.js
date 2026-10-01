// Walk-forward pooling + the promotion gate — split from
// `analysis/walkforward.js` in round 74 (byte-exact move).
//
// Round-106 foundations split: the implementation lives in src/analysis/walkforward/report/
// (two parts, bodies byte-identical; the unused `backtestMetrics` import is
// dropped from pooling.js); this file carries the exact registered contract so
// every importer keeps working.
export { poolReports } from './report/pooling.js';
export { promoteDecision, pairedPromotionTest } from './report/gate.js';
