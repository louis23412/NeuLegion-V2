// Decision-grade report (round 26, R26-8) — the composition half of the honest-evaluation battery.
//
// Round-97 foundations split: the implementation lives in src/analysis/decision/
// (five parts); this file carries the exact registered contract so every importer
// keeps working.
export { foldConcentration, confidencePersistence } from './decision/measures.js';
export { nextRunPlan } from './decision/plan.js';
export { decisionReport } from './decision/report.js';
export { formatDecision } from './decision/format.js';
export { defaultCatastrophic, promotionAcrossCadences } from './decision/cadence.js';
