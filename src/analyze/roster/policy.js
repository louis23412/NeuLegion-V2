// src/analyze/roster/policy.js (round-99 split of src/analyze/roster.js).
// Position policies, controller model, variant resolution.

import { RESOLVABLE_VARIANTS } from './tables.js';


export const POSITION_POLICY = Object.freeze({ deadZone: 0.05, scale: 1 });
// Back-compat name: before R26-3 this was the controller-only policy.
export const CONTROLLER_POSITION_POLICY = POSITION_POLICY;

// The identity policy (no dead zone, unit scale). Used as `makeSignalForVariant`'s
// default so a direct call is byte-identical to the pre-R26-3 behaviour; the A/B
// passes the unified `POSITION_POLICY` explicitly.
export const IDENTITY_POSITION_POLICY = Object.freeze({ deadZone: 0, scale: 1 });

// The controller cache/ensemble used by the A/B model (the same shape the
// multi-symbol suite replays: cache 120, ensemble 4, tier 1, forced-minimum
// dimensions so the evaluation stays CPU-bounded). `warmup` is the minimum amount
// of streamed history a fold must have before its predictions are trusted: the
// controller only trains when trades close, so a fold with a tiny `testStart`
// would otherwise "predict" from a controller that has seen almost nothing. A
// fold below the threshold abstains (position 0), which is a non-leaky decision
// (it only reads the past).
export const CONTROLLER_MODEL = Object.freeze({ cacheSize: 120, ensembleSize: 4, tier: 1, warmup: 40 });

let variantIndex = null;
// Look up a variant by id (throws on an unknown id so a typo cannot silently run
// the baseline). Searches the resolvable universe, which includes the opt-in
// label variants.
export const resolveVariant = (id) => {
    if (!variantIndex) variantIndex = new Map(RESOLVABLE_VARIANTS.map((v) => [v.id, v]));
    if (!variantIndex.has(id)) {
        throw new Error(`analyze: unknown variant "${id}" (known: ${[...variantIndex.keys()].join(', ')})`);
    }
    return variantIndex.get(id);
};

// Apply a variant's flags to a model instance. Returns true when something was
// applied, false for the baseline / a controller-scoped variant (so the caller
// can record a "skipped" note instead of pretending it ran).
export const applyVariant = (target, variant) => {
    if (!variant || typeof variant.configure !== 'function') return false;
    variant.configure(target);
    return true;
};

