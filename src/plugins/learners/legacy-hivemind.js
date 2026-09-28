// `legacy-hivemind` — the ONE bridge between the V2 contract layer and the
// shipped engine.
//
// The architecture audit's conclusion (`docs/ARCHITECTURE-v2.md` §5) is that the
// model core is the part the evidence says is inert AND the part whose
// whole-engine lock blocks modularity, so V2 rebuilds it as plugins — but it
// keeps the legacy math available as exactly one plugin, so its 11 golden
// fingerprints are never lost. This file is that plugin. It is the only file
// under `src/plugins/` allowed to import the legacy engine, and nothing under
// `src/core/` may import it (the import law is enforced by `contracts.test.js`).
//
// Two consequences worth stating explicitly:
//   * `create()` is a plain constructor call — this adapter must not (and does
//     not) reimplement, wrap or re-order any arithmetic, so the goldens stay the
//     engine's own (`golden.test.js` 23/0 is the V2.0 acceptance condition).
//   * the engine's own lock is untouched: `docs/COMPONENTS.md` rule 4 ("don't
//     touch the hot math") still governs `src/hivemind/**`, which is why this is
//     an additive read-only consumer.
//
// `input` is the *materialised* feature vector the engine scores (the
// controller's `inputSize`-vector); V2.3's learner plugins take the panel view and
// the runtime materialises it, so this adapter is the legacy special case of the
// same contract.

import HiveMind from '../../hivemind/hiveMind.js';
import { CAPABILITIES } from '../../core/contracts/base.js';
import { isLearnerPlugin } from '../../core/contracts/learner.js';

// The shipped defaults for a bare model slot (the golden suite constructs a
// bare `HiveMind` at es = 3 — `docs/research/round29-ensemble-size.md`).
export const LEGACY_HIVEMIND_DEFAULTS = Object.freeze({
    ensembleSize: 3,
    inputSize: 1,
    hiveId: 'legacy-hivemind',
    forceMin: true,
});

export const legacyHivemindLearner = {
    id: 'legacy-hivemind',
    capability: CAPABILITIES.MODEL,
    legacy: true,
    defaults: LEGACY_HIVEMIND_DEFAULTS,

    create(options = {}) {
        const config = { ...LEGACY_HIVEMIND_DEFAULTS, ...options };
        if (typeof config.directoryPath !== 'string' || !config.directoryPath) {
            throw new Error('legacy-hivemind needs a directoryPath (the engine persists its state to SQLite)');
        }
        const model = new HiveMind(
            config.directoryPath,
            config.ensembleSize,
            config.inputSize,
            config.hiveId,
            config.forceMin,
        );
        return {
            model,
            // The engine's online learner: one row at a time. `fit` keeps the
            // engine's own return value (the monotone training-step count) so a
            // caller can assert progress exactly as the controller does.
            fit: (input, target, sampleWeight = 1) => model.train(input, target, sampleWeight),
            predict: (input) => model.predict(input),
            diagnostics: () => (typeof model.diagnostics === 'function' ? model.diagnostics() : null),
            dumpState: () => model.dumpState(),
        };
    },
};

export const isLegacyHivemind = (impl) => isLearnerPlugin(impl) && impl.id === legacyHivemindLearner.id;
