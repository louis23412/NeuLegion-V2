// Variant roster for the A/B driver (round-23 N1, round-27 SIGUP, round-30 taxonomy).
//
// Round-99 foundations split: the implementation lives in src/analyze/roster/
// (three parts); this file carries the exact registered contract so every importer
// keeps working.
export { FEATURE_LEN, SAMPLE_WEIGHT_WINDOW_BARS, VARIANTS, OPT_IN_VARIANTS, SIGNAL_VARIANTS, REVERSAL_VARIANTS, SIGUP_VARIANTS, ALL_VARIANTS, BENCHMARK_VARIANTS, LABEL_VARIANTS, RESOLVABLE_VARIANTS } from './roster/tables.js';
export { rosterSnapshot, emptyListFlagError, rosterRegistration, notApplicableReason, inertReasonFor, forecastKindOf, listVariants, formatVariantList } from './roster/registration.js';
export { POSITION_POLICY, CONTROLLER_POSITION_POLICY, IDENTITY_POSITION_POLICY, CONTROLLER_MODEL, resolveVariant, applyVariant } from './roster/policy.js';
