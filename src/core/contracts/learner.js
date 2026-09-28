// `Learner` — the model slot.
//
// Absorbs `HiveMind` / `HiveMindController` + `analysis/benchmark.js`
// (`docs/ARCHITECTURE-v2.md` §4.2). The importance of this contract is not the
// model it describes but the *lock* it changes: today a memory/ensemble swap is a
// whole-engine re-freeze (§3.3); under V2 a learner ships its own fingerprint and
// a non-default learner moves nothing. The shipped engine enters through the
// single adapter `plugins/learners/legacy-hivemind.js`, whose 11 golden
// fingerprints are the engine's proof (V2.0 acceptance).
//
// `fit` / `predict` take the view and the labels — never engine internals.

import { defineContract, validatePlugin } from './base.js';

export const LEARNER_CONTRACT = defineContract({
    kind: 'learner',
    purpose: 'fit a view+labels and predict a confidence on [-1, 1]',
    stateful: true,
    requires: ['fit', 'predict'],
    optional: ['reset', 'diagnostics', 'fingerprint', 'dumpState'],
});

export const isLearnerPlugin = (impl) => validatePlugin(LEARNER_CONTRACT, impl).ok;
