// `cap-band` — the ported risk policy: the lab's cap / no-trade-band chain plus
// the shipped fixed +/-1 position clamp.
//
// Two pieces, both already measured and both in `primitives/weights.js`:
//   * `applyToWeights` — `cleanBook`: a strict per-symbol cap (a tail winsorisation
//     AND a concentration/capacity tool, F-27/F-52/F-54) followed by a per-symbol
//     no-trade band (the cost remedy, F-52/F-53/F-58), in that order (stacking the
//     band on the raw book recovers almost none of the cap's benefit).
//   * `position` — the shipped `clampPosition` semantics (a fixed +/-1 clamp with
//     an optional dead zone) and the dead zone's documented hazard: the controller's
//     |confidence| never exceeds 0.27 while a signal saturates at 1, so a shared
//     0.05 dead zone leaves the two families at a 0.508 vs 0.892 in-market share
//     (`docs/DESIGN.md` §6.1 Addendum 2, `BUGS.md` #61). Cross-family statements
//     are quoted at matched exposure; this policy is where that is enforced.
//
// The per-sleeve specs are data, so a caller cannot forget a piece of a book
// (the reason `port.js` exports `SLEEVE_SPECS`).

import { CAPABILITIES } from '../../core/contracts/base.js';
import { isRiskPlugin } from '../../core/contracts/risk.js';
import { cleanBook } from '../../core/primitives/index.js';

export const CAP_BAND_SPECS = Object.freeze({
    'carry-dispersion': Object.freeze({ cap: 0.125, bandEps: null }),
    'toptrader-fade': Object.freeze({ cap: 0.125, bandEps: null }),
    'oi-change': Object.freeze({ cap: null, bandEps: 0.03 }),
});

export const DEFAULT_POSITION_SPEC = Object.freeze({ deadZone: 0, maxAbs: 1 });

export const capBandRisk = {
    id: 'cap-band',
    capability: CAPABILITIES.RISK,
    specs: CAP_BAND_SPECS,

    // The shipped position policy: a dead zone (no trade below it) then a hard
    // +/-1 clamp. Non-finite input abstains at 0 (the engine's documented
    // sentinel — a probability of 0 would map to a maximal short, BUGS.md #46).
    position(value, { deadZone = DEFAULT_POSITION_SPEC.deadZone, maxAbs = DEFAULT_POSITION_SPEC.maxAbs } = {}) {
        const v = Number(value);
        if (!Number.isFinite(v) || Math.abs(v) <= deadZone) return 0;
        return v < -maxAbs ? -maxAbs : v > maxAbs ? maxAbs : v;
    },

    applyToWeights(weightRows, spec) {
        if (!spec) throw new Error('cap-band: applyToWeights needs a {cap, bandEps} spec');
        return cleanBook(weightRows, { cap: spec.cap, bandEps: spec.bandEps });
    },

    applyForSleeve(weightRows, sleeveId) {
        const spec = CAP_BAND_SPECS[sleeveId];
        if (!spec) throw new Error(`cap-band: no registered spec for sleeve "${sleeveId}"`);
        return cleanBook(weightRows, { cap: spec.cap, bandEps: spec.bandEps });
    },
};

export const isCapBandRisk = (impl) => isRiskPlugin(impl) && impl.id === capBandRisk.id;
