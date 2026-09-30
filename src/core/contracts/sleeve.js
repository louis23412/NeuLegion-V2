// `Sleeve` — a capital-allocation rule on a cross-section (audit A11).
//
// The sleeves are the project's only measured positive results (the round-31
// pivot, `docs/PLAN-round31.md` §2) and before this contract they had no declared
// interface — they existed only as lab prototypes. A sleeve maps a view to a
// *weight series* over the panel; the risk layer (not the sleeve) owns
// deployment. `signal(view)` must be point-in-time: row t may read the view at
// indices <= t only, and row t is the weight held over (t, t+1].

import { defineContract, validatePlugin } from './base.js';

export const SLEEVE_CONTRACT = defineContract({
    kind: 'sleeve',
    purpose: 'map a panel view to a causal weight series and its sleeve returns',
    requires: ['signal'],
    optional: ['returns', 'fingerprint', 'earnTimes'],
});

export const isSleevePlugin = (impl) => validatePlugin(SLEEVE_CONTRACT, impl).ok;
