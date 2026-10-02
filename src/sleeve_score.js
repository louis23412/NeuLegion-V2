// Sleeve-scoring composition — re-export shim (round-81 foundations split).
// The implementation lives in src/sleeve/ (six parts); this file carries the
// exact registered contract so every importer keeps working. Pure, no I/O.
export { SLEEVE_IDS, resolveSleeve } from './sleeve/registry.js';
export { buildCarrySleeveView, parseMarksJson, parseSleeveInputs, parseOiJson } from './sleeve/view.js';
export { scoreSleeve, parseSleeveRisk } from './sleeve/scoring.js';
export { SLEEVE_DSR_BLOCKS, SLEEVE_DSR_TRIALS, sleeveDsr, sleeveYearly, yearlyReport, sleeveFirstLast, firstLastReport, dsrReport } from './sleeve/evidence.js';
export { runSleeveReport, formatSleeveReport } from './sleeve/report.js';
export { SIZED_SLEEVE_DEFAULTS, trailingBookVol, parseSleeveSizing, adaptiveTargets, drawdownGovernor, scoreSleeveSized } from './sleeve/sizing.js';
