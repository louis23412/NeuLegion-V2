// `Evaluator` — one honest measurement.
//
// Absorbs `analysis/*` (`docs/ARCHITECTURE-v2.md` §4.2). These carry over
// wholesale and unchanged: the gate is the project's single best-validated asset
// (§2.3) and the plan explicitly denies re-deriving it. The contract exists so an
// evaluator can be *named* in a report and pinned by a reference-vector test
// (audit A14's second lock class), not so it can be rewritten.

import { defineContract, validatePlugin } from './base.js';

export const EVALUATOR_CONTRACT = defineContract({
    kind: 'evaluator',
    purpose: 'score a returns series / book into honest metrics',
    requires: ['score'],
    optional: ['format', 'fingerprint'],
});

export const isEvaluatorPlugin = (impl) => validatePlugin(EVALUATOR_CONTRACT, impl).ok;
