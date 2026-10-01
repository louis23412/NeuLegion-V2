// A/B evaluation core (round-23 N0-N2, round-24 run integrity).
//
// Round-96 foundations split: the implementation lives in src/analyze/evaluate/
// (three parts); this file carries the exact registered contract so every
// importer keeps working.
export { evaluateAB } from './evaluate/core.js';
export { evaluateABAsync } from './evaluate/async.js';
export { auditVerdict, formatFullHistory, formatAnalysis } from './evaluate/format.js';
