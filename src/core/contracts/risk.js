// `RiskPolicy` — deployment: sizing, position, turnover (audit A11).
//
// Nothing in the shipped repo does this (a fixed +/-1 `clampPosition` and a dead
// zone); the lab's `prototypes/port.js` is the validated part. `position` is the
// only required method because a policy that cannot produce a deployed position
// is not a risk policy; `applyToWeights` is where the cap/no-trade-band chain
// lives, and `sizing` is where the capacity schedules (F-42/F-57) go.

import { defineContract, validatePlugin } from './base.js';

export const RISK_CONTRACT = defineContract({
    kind: 'risk',
    purpose: 'turn a book and a signal into deployed weights / positions, with costs',
    requires: ['position'],
    optional: ['weights', 'sizing', 'applyToWeights', 'turnover', 'fingerprint'],
});

export const isRiskPlugin = (impl) => validatePlugin(RISK_CONTRACT, impl).ok;
