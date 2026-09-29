// `vol-target` — the forecast-sizing risk policy: scale a return series to a
// vol target through a causal forecast, hard-capped, skipping dead bars.
//
// The arithmetic is vendored from `analysis/forecast.js#applyVolTargetScaling`
// (the import law forbids plugins from importing `analysis/`, so the port is
// proved by the §O differential, not by sharing code): scale = min(cap,
// target/vol), every bar with a non-finite return, a non-positive forecast
// vol or a non-positive target skipped, never assigned an infinite scale.
// F-16/F-106/F-112: sizing is a risk result — the caller re-estimates the
// target causally (a trailing mean in every lab proof); the cap is the policy
// (per-sleeve specs below), the target is a measurement the plugin takes as
// input, never banks.

import { CAPABILITIES } from '../../core/contracts/base.js';
import { RISK_CONTRACT, isRiskPlugin } from '../../core/contracts/risk.js';

export const VOL_TARGET_DEFAULTS = Object.freeze({ target: 0.01, cap: 4 });

export const VOL_TARGET_SPECS = Object.freeze({
    'carry-dispersion': Object.freeze({ cap: 4 }),
    'toptrader-fade': Object.freeze({ cap: 4 }),
    'oi-change': Object.freeze({ cap: 4 }),
});

export const volTargetRisk = {
    id: 'vol-target',
    capability: CAPABILITIES.RISK,
    defaults: VOL_TARGET_DEFAULTS,
    legacy: false,
    specs: VOL_TARGET_SPECS,

    // The shipped position clamp, same arithmetic as cap-band (proved
    // bit-identical by §O): a dead zone then a hard +/-1 clamp, non-finite
    // abstains at 0.
    position(value, { deadZone = 0, maxAbs = 1 } = {}) {
        const v = Number(value);
        if (!Number.isFinite(v) || Math.abs(v) <= deadZone) return 0;
        return v < -maxAbs ? -maxAbs : v > maxAbs ? maxAbs : v;
    },

    sizing(returns, vols, { target = VOL_TARGET_DEFAULTS.target, cap = VOL_TARGET_DEFAULTS.cap } = {}) {
        if (!Array.isArray(returns) || !Array.isArray(vols) || returns.length !== vols.length) return { available: false, reason: 'returns and vols must be aligned arrays (vol-target)' };
        if (!Array.isArray(target) && !(target > 0)) return { available: false, reason: 'target must be a positive vol (vol-target)' };
        if (Array.isArray(target) && target.length !== vols.length) return { available: false, reason: 'array target must align with vols (vol-target)' };
        if (!(cap > 0)) return { available: false, reason: 'cap must be a positive multiple (vol-target)' };
        const index = [];
        const scaled = [];
        const scales = [];
        let skipped = 0;
        for (let t = 0; t < returns.length; t++) {
            const r = returns[t];
            const v = vols[t];
            const tg = Array.isArray(target) ? target[t] : target;
            if (!Number.isFinite(r) || !Number.isFinite(v) || !(v > 0) || !(tg > 0)) { skipped++; continue; }
            const s = Math.min(cap, tg / v);
            index.push(t);
            scales.push(s);
            scaled.push(s * r);
        }
        if (!scaled.length) return { available: false, reason: 'no scorable bars (vol-target)' };
        return { available: true, n: returns.length, scored: scaled.length, skipped, index, scales, scaled };
    },

    sizingForSleeve(returns, vols, sleeveId, target) {
        const spec = VOL_TARGET_SPECS[sleeveId];
        if (!spec) throw new Error(`vol-target: no registered spec for sleeve "${sleeveId}"`);
        return volTargetRisk.sizing(returns, vols, { target, cap: spec.cap });
    },
};

export const isVolTarget = (impl) => isRiskPlugin(impl) && impl.id === volTargetRisk.id;
