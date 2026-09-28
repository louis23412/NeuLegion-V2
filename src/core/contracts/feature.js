// `Feature` — a causal transform of a view into a series or a panel.
//
// Absorbs `indicatorProcessor` + `controller/features` + `analysis/features`
// (`docs/ARCHITECTURE-v2.md` §4.2). The `analysis/features.js` family is already
// plugin-shaped (pure, causal, id-selected, no engine import) and is the model
// for the contract: `compute(view)` reads only indices <= t.

import { defineContract, validatePlugin } from './base.js';

export const FEATURE_CONTRACT = defineContract({
    kind: 'feature',
    purpose: 'compute a causal series or cross-sectional panel from a view',
    requires: ['compute'],
    optional: ['fingerprint'],
});

export const isFeaturePlugin = (impl) => validatePlugin(FEATURE_CONTRACT, impl).ok;
