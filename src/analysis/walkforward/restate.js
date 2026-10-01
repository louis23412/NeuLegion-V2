// Walk-forward restatements — split from `analysis/walkforward.js` in round 74
// (byte-exact move): cost/policy/cadence/exposure re-scoring of a finished
// report without the model.
//
// Round-105 foundations split: the implementation lives in src/analysis/walkforward/restate/
// (three parts, bodies byte-identical; the private `withExtraPanelStreams`
// helper gains `export` in costs.js for inter-part use and is not re-exported
// here; the unused `confidenceToPosition` import is dropped); this file carries
// the exact registered contract so every importer keeps working.
export { restateReportAtCost } from './restate/costs.js';
export { restateReportAtPolicy, verifyPolicyRoundTrip } from './restate/policies.js';
export { exposureDeadZone, restateReportAtCadence, exposureMatchedPair, costLadder } from './restate/exposure.js';
