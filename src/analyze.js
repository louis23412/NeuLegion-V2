// NeuLegion A/B analysis driver (ROADMAP P2-1).
//
// This is the *productionized* version of the ad-hoc A/B harness that lived in
// `test/browser/entries/walkforward.test.js` sections G/H/I. It turns "should
// feature X ship on?" into a mechanical, reproducible decision:
//
//   1. build a causal walk-forward split over a candle series;
//   2. for every VARIANT (the default-off baseline plus each feature), fit a
//      fresh online model per fold and evaluate the pooled out-of-sample return
//      stream with the locked analysis layer (`walkForwardEvaluate`);
//   3. decide each candidate with `promoteDecision` (DSR floor + fold-win +
//      positive-fold + a CLEAN lookahead audit), and cross-check with the
//      family-wise subsampling SPA / Romano-Wolf step-down (`walkForwardSearch`)
//      so the verdict cannot be bought with search luck;
//   4. write a run directory (`run.json` manifest, `report.json`, `run.log`).
//
// The core is PURE and model-agnostic: `evaluateAB` takes an injected
// `signalForVariant` function, so the A/B mathematics is testable without a DB
// (`test/browser/entries/analyze.test.js`). The `HiveMind`-backed model factory
// (`makeHiveMindModelFactory`) is created only by the CLI, via a dynamic import.
//
// Nothing here is on the training hot path; it only *drives* the locked modules.
//
// Round-83 foundations split: the implementation lives in src/analyze/ (four
// parts); this file carries the exact registered contract so every importer
// keeps working. The CLI side effects and node-only imports live in ./cli.js.
export {
  FEATURE_LEN, SAMPLE_WEIGHT_WINDOW_BARS, VARIANTS, OPT_IN_VARIANTS, SIGNAL_VARIANTS,
  REVERSAL_VARIANTS, SIGUP_VARIANTS, ALL_VARIANTS, BENCHMARK_VARIANTS, LABEL_VARIANTS,
  RESOLVABLE_VARIANTS, rosterSnapshot, emptyListFlagError, rosterRegistration,
  notApplicableReason, inertReasonFor, forecastKindOf, listVariants, formatVariantList,
  POSITION_POLICY, CONTROLLER_POSITION_POLICY, IDENTITY_POSITION_POLICY, CONTROLLER_MODEL,
  resolveVariant, applyVariant,
} from './analyze/roster.js';
export {
  featureVector, makeHiveMindModelFactory, makeBenchmarkModelFactory,
  makeControllerModelFactory, withSeed, makeSignalForVariant,
} from './analyze/models.js';
export {
  evaluateAB, evaluateABAsync, auditVerdict, formatFullHistory, formatAnalysis,
} from './analyze/evaluate.js';
export {
  readCloses, readCandles, probesPerFold, auditBlock, makeNodeFoldDispatcher,
  runSleeveAnalysis, runAnalysis, replicateAnalysis, ANALYZE_USAGE,
} from './analyze/cli.js';
import { analyzeMain } from './analyze/cli.js';
if (typeof process !== 'undefined' && process.argv && process.argv[1] && typeof process.versions?.node === 'string') {
  const { pathToFileURL } = await import('node:url');
  if (import.meta.url === pathToFileURL(process.argv[1]).href) analyzeMain();
}
