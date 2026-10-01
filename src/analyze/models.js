// Model factories for the A/B driver (round-23 N0, round-26 R26-2).
//
// Round-98 foundations split: the implementation lives in src/analyze/models/
// (five parts); this file carries the exact registered contract so every importer
// keeps working.
export { featureVector } from './models/features.js';
export { makeHiveMindModelFactory, makeBenchmarkModelFactory } from './models/factories.js';
export { emptyModelAccumulator, mergeModelStats, summarizeModelStats } from './models/stats.js';
export { makeControllerModelFactory } from './models/controllers.js';
export { withSeed, makeSignalForVariant } from './models/signals.js';
