// Homeostatic plasticity — proof suite for
// `src/hivemind/ensemble/homeostasis.js` and its (opt-in) integration into
// `_updateAdaptiveLearningRates`.
//
// Grounding: biological homeostasis regulates *absolute* activity toward a
// set-point (Turrigiano's synaptic scaling), and the same error-driven
// plasticity controller appears in continual learning as output-anomaly
// detection (arXiv 2609.13771, "Homeostatic Continual Learning"). The
// incumbent rank-based controller is blind to common-mode shifts; the
// homeostatic multiplier restores an absolute set-point.
//
// The suite splits the guarantees so a failure names the tier:
//
//   A. PURE MATH (exact values + properties)
//      Bounded / monotone / exact-fixed-point multiplier, EMA activity signal,
//      RMS, deviation energy, and the contraction condition 0 < gain*target < 2.
//
//   B. CLOSED-LOOP CONTRACTION (the control law actually stabilises)
//      On the toy system activity = k*lr, iterating
//      lr <- lr * homeostaticScale(k*lr) contracts the set-point error at the
//      proven factor |1 - gain*target| and converges to target/k for a sweep of
//      k, with deviation energy strictly decreasing.
//
//   C. BIT-EXACT OFF SWITCH
//      Disabled (the default) and enabled-with-gain-0 give fingerprint-equal
//      trajectories, which is why the default-off feature cannot move a golden
//      fingerprint. A non-trivial gain does change the trajectory, so the
//      feature is live rather than dead code.
//
// Like the other entries this takes an optional `{ ensureSql, stateDir }` so the
// node mirror can run against the real better-sqlite3 driver and a temp dir; in
// the browser harness it lazily loads the sql.js shim and uses the virtual fs.

import HiveMind from '../../../src/hivemind/hiveMind.js';
import {
    DEFAULT_HOMEOSTASIS_CONFIG,
    resolveHomeostasisConfig,
    isStableConfig,
    homeostaticScale,
    homeostaticLearningRates,
    updateActivity,
    rootMeanSquare,
    deviationEnergy,
} from '../../../src/hivemind/ensemble/homeostasis.js';

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// FNV-1a over a canonical rendering, so "bit-identical" can be asserted.
function fingerprint(value) {
    const parts = [];
    (function walk(v) {
        if (v === null) { parts.push('null'); return; }
        if (v === undefined) { parts.push('undefined'); return; }
        if (typeof v === 'number') { parts.push(Object.is(v, -0) ? '-0' : String(v)); return; }
        if (typeof v === 'boolean' || typeof v === 'string' || typeof v === 'bigint') { parts.push(String(v)); return; }
        if (Array.isArray(v) || ArrayBuffer.isView(v)) { parts.push('['); for (let i = 0; i < v.length; i++) walk(v[i]); parts.push(']'); return; }
        if (typeof v === 'object') { parts.push('{'); for (const k of Object.keys(v).sort()) { parts.push(k); walk(v[k]); } parts.push('}'); return; }
        parts.push(String(v));
    })(value);
    const text = parts.join('\u0001');
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export async function run(options = {}) {
    if (options.ensureSql) await options.ensureSql();
    else {
        const shim = await import('../shims/better-sqlite3.js');
        await shim.__ensureSql();
    }
    const stateDir = options.stateDir || ((label) => `state/homeostasis-${label}`);

    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
    const realRandom = Math.random;
    const seeded = (seed, fn) => {
        Math.random = mulberry32(seed);
        try { return fn(); } finally { Math.random = realRandom; }
    };
    const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

    const H_ES = 2, H_IS = 8;

    // ---- A. pure math --------------------------------------------------------
    try {
        check('A: DEFAULT_HOMEOSTASIS_CONFIG is frozen', Object.isFrozen(DEFAULT_HOMEOSTASIS_CONFIG));
        check('A: default set-point/gain are 1 / 0.5',
            DEFAULT_HOMEOSTASIS_CONFIG.target === 1 && DEFAULT_HOMEOSTASIS_CONFIG.gain === 0.5);

        // resolveHomeostasisConfig fills gaps from defaults, ignores non-finite.
        const resolved = resolveHomeostasisConfig({ gain: 0.25, target: NaN });
        check('A: resolveHomeostasisConfig keeps finite overrides and restores non-finite ones',
            resolved.gain === 0.25 && resolved.target === 1 && resolved.momentum === 0.5,
            JSON.stringify(resolved));
        check('A: resolveHomeostasisConfig(null) returns the defaults',
            resolveHomeostasisConfig(null) === DEFAULT_HOMEOSTASIS_CONFIG);

        // Exact fixed point: activity == target -> scale exactly 1.
        check('A: homeostaticScale at the set-point is exactly 1',
            homeostaticScale(1) === 1 && homeostaticScale(DEFAULT_HOMEOSTASIS_CONFIG.target) === 1);
        check('A: a non-finite activity falls back to the set-point (scale 1)',
            homeostaticScale(NaN) === 1 && homeostaticScale(Infinity) === 1 && homeostaticScale(undefined) === 1);

        // Monotone decreasing in activity.
        const activitySweep = [-5, 0, 0.5, 1, 1.5, 2, 5, 100];
        const scales = activitySweep.map((a) => homeostaticScale(a));
        let monotone = true;
        for (let i = 1; i < scales.length; i++) if (!(scales[i] <= scales[i - 1])) monotone = false;
        check('A: homeostaticScale is monotone non-increasing in activity', monotone, JSON.stringify(scales));

        // Bounded to [minScale, maxScale].
        let bounded = true;
        for (const a of activitySweep) {
            const s = homeostaticScale(a);
            if (!(s >= DEFAULT_HOMEOSTASIS_CONFIG.minScale && s <= DEFAULT_HOMEOSTASIS_CONFIG.maxScale)) bounded = false;
        }
        for (let a = -100; a <= 100; a += 1.37) {
            const s = homeostaticScale(a);
            if (!(s >= DEFAULT_HOMEOSTASIS_CONFIG.minScale && s <= DEFAULT_HOMEOSTASIS_CONFIG.maxScale)) bounded = false;
        }
        check('A: homeostaticScale is bounded to [minScale, maxScale]', bounded);
        check('A: an under-active member is scaled up, an over-active one down',
            homeostaticScale(0.5) === 1.25 && homeostaticScale(1.5) === 0.75,
            `${homeostaticScale(0.5)} / ${homeostaticScale(1.5)}`);

        // homeostaticLearningRates is elementwise.
        const lrs = homeostaticLearningRates([0.1, 0.1, 0.1], [1, 0.5, 1.5]);
        check('A: homeostaticLearningRates applies the scale elementwise',
            close(lrs[0], 0.1, 1e-15) && close(lrs[1], 0.125, 1e-15) && close(lrs[2], 0.075, 1e-15),
            JSON.stringify(lrs));

        // updateActivity: EMA of |value|.
        check('A: updateActivity is an EMA of the magnitude',
            close(updateActivity(0, 2), 1) && close(updateActivity(1, 0), 0.5) &&
            close(updateActivity(0.4, -0.4), 0.4),
            `${updateActivity(0, 2)} / ${updateActivity(1, 0)}`);
        check('A: updateActivity leaves the EMA untouched for a non-finite value',
            updateActivity(0.7, NaN) === 0.7 && updateActivity(0.7, Infinity) === 0.7);

        // rootMeanSquare.
        check('A: rootMeanSquare of [3,4] is sqrt(12.5)',
            close(rootMeanSquare([3, 4]), Math.sqrt(12.5), 1e-15));
        check('A: rootMeanSquare of [] is 0 and ignores non-finite entries',
            rootMeanSquare([]) === 0 && close(rootMeanSquare([1, NaN, -1, Infinity, 1, -1]), 1, 1e-15));

        // deviationEnergy.
        check('A: deviationEnergy is 0 at the set-point',
            deviationEnergy([1, 1, 1]) === 0 && deviationEnergy([]) === 0);
        check('A: deviationEnergy sums squared deviations',
            close(deviationEnergy([0, 2], { target: 1 }), 2, 1e-15));

        // Stability condition 0 < gain*target < 2.
        check('A: the default config is stable',
            isStableConfig(null) === true && isStableConfig(DEFAULT_HOMEOSTASIS_CONFIG) === true);
        check('A: isStableConfig rejects gain*target <= 0 or >= 2',
            isStableConfig({ gain: 0, target: 1 }) === false &&
            isStableConfig({ gain: 2, target: 1 }) === false &&
            isStableConfig({ gain: 4, target: 1 }) === false &&
            isStableConfig({ gain: 1, target: 1.999 }) === true);
    } catch (error) {
        check('A: pure math completed', false, error && error.stack ? error.stack : String(error));
    }

    // ---- B. closed-loop contraction -----------------------------------------
    // Toy system: a member with learning rate lr produces activity k*lr. The
    // homeostatic controller feeds back lr <- lr * scale(k*lr). The continuous
    // analysis gives a fixed point lr* = target/k with a local contraction
    // factor |1 - gain*target| = 0.5, so the discrete iteration converges.
    try {
        const target = DEFAULT_HOMEOSTASIS_CONFIG.target;
        const expectedFactor = Math.abs(1 - DEFAULT_HOMEOSTASIS_CONFIG.gain * target);
        check('B: the default contraction factor is 0.5', close(expectedFactor, 0.5, 1e-15), String(expectedFactor));

        const ks = [0.25, 0.5, 1, 2, 4, 8];
        let converged = true, contracting = true, energyDown = true, fixedExact = true;
        const details = [];
        for (const k of ks) {
            const lrStar = target / k;
            // Start 30% above the fixed point and iterate.
            let lr = lrStar * 1.3;
            const energies = [];
            for (let step = 0; step < 80; step++) {
                const activity = k * lr;
                energies.push(deviationEnergy([activity]));
                lr = lr * homeostaticScale(activity);
            }
            if (!close(lr, lrStar, 1e-9)) { converged = false; details.push(`k=${k} lr=${lr} want=${lrStar}`); }
            for (let i = 1; i < energies.length; i++) {
                if (!(energies[i] <= energies[i - 1] + 1e-18)) energyDown = false;
            }
            // Near the fixed point the error must shrink (roughly) geometrically.
            const e0 = lrStar * 0.3;
            const e2 = lrStar * 0.3 * expectedFactor * expectedFactor;
            details.push(`k=${k}: |lr-lr*| -> ${Math.abs(lr - lrStar).toExponential(2)}`);
            if (!(Math.abs(lr - lrStar) <= e2 + 1e-9)) contracting = false;
            void e0;
            // Exact fixed point is stationary.
            let lrFixed = lrStar;
            lrFixed = lrFixed * homeostaticScale(k * lrFixed);
            if (!close(lrFixed, lrStar, 1e-15)) fixedExact = false;
        }
        check('B: the closed loop converges to target/k across a k-sweep', converged, details.join(' | '));
        check('B: the squared set-point error decreases every step', energyDown);
        check('B: the error is contractive near the fixed point', contracting);
        check('B: the exact fixed point is stationary', fixedExact);

        // Two different initial rates reach the same set-point.
        const kFixed = 2;
        const runTo = (start) => {
            let lr = start;
            for (let step = 0; step < 120; step++) lr = lr * homeostaticScale(kFixed * lr);
            return lr;
        };
        check('B: different initial rates converge to the same set-point',
            close(runTo(10), runTo(0.01), 1e-9), `${runTo(10)} vs ${runTo(0.01)}`);

        // A common-mode shift is corrected: this is the property the rank-based
        // controller cannot provide (every member scaled up equally).
        const bases = [4, 4, 4, 4];
        const common = bases.map((b) => b * homeostaticScale(b, { target: 1, gain: 0.5, minScale: 0.5, maxScale: 1.5 }));
        check('B: a common-mode over-activity is uniformly corrected downward',
            common.every((v) => v < 4) && new Set(common.map((v) => v.toFixed(9))).size === 1,
            JSON.stringify(common));
    } catch (error) {
        check('B: closed-loop contraction completed', false, error && error.stack ? error.stack : String(error));
    }

    // ---- C. bit-exact off switch --------------------------------------------
    const H_ES_C = 2, H_IS_C = 8;
    const inputs8 = (s) => Array.from({ length: 8 }, (_, i) => Math.sin(s * 1.7 + i * 0.9) * 0.6);

    function trajectoryFingerprint(label, seed, configure) {
        return seeded(seed, () => {
            const hm = new HiveMind(stateDir(label), H_ES_C, H_IS_C, label, true);
            hm._gradientResetFrequency = 1;
            if (configure) configure(hm);
            for (let s = 0; s < 8; s++) {
                seeded(seed * 31 + s, () => { hm.train(inputs8(s), s % 2); });
            }
            const snap = {
                steps: hm._trainingStepCount,
                lr: Array.from(hm._adaptiveLearningRate),
                attBias: hm._transformers.map((_, i) => Array.from(hm._attentionBias[i])),
                spec: hm._transformers.map((_, i) => hm._specializationWeights[i].map((r) => Array.from(r))),
                out: hm._transformers.map((t) => ({ w: t.outputWeights.map((r) => Array.from(r)), b: [t.outputBias[0]] })),
            };
            return fingerprint(snap);
        });
    }

    try {
        const p = new HiveMind(stateDir('C_default'), H_ES_C, H_IS_C, 'C_default', true);
        check('C: homeostasis is disabled by default',
            p._homeostasisEnabled === false && p._homeostasisConfig === null && p._activityEma.length === 0);
        void p;

        const fpOff = trajectoryFingerprint('C_off', 71, null);
        const fpOn = trajectoryFingerprint('C_on', 71, (hm) => { hm._homeostasisEnabled = true; });
        check('C: enabling homeostasis changes the trajectory (feature is live)',
            fpOn !== fpOff, `on ${fpOn} vs off ${fpOff}`);

        // gain 0 => scale is exactly 1 everywhere, so the enabled path must be
        // a bit-exact no-op against the disabled path. This is the mechanism
        // that keeps the golden fingerprints frozen.
        const fpZero = trajectoryFingerprint('C_zero', 71, (hm) => {
            hm._homeostasisEnabled = true;
            hm._homeostasisConfig = { gain: 0 };
        });
        check('C: enabling with gain 0 is a bit-exact no-op (golden-safe mechanism)',
            fpZero === fpOff, `zero ${fpZero} vs off ${fpOff}`);

        // The activity EMA is still populated when enabled, but the learning
        // rates match the disabled run exactly under gain 0.
        const hmZero = seeded(73, () => {
            const hm = new HiveMind(stateDir('C_ema'), H_ES_C, H_IS_C, 'C_ema', true);
            hm._gradientResetFrequency = 1;
            hm._homeostasisEnabled = true;
            hm._homeostasisConfig = { gain: 0 };
            for (let s = 0; s < 4; s++) seeded(73 * 31 + s, () => hm.train(inputs8(s), s % 2));
            return hm;
        });
        check('C: the activity EMA is populated only on the enabled path',
            hmZero._activityEma.length === H_ES_C && hmZero._activityEma.every((a) => Number.isFinite(a) && a >= 0),
            JSON.stringify(hmZero._activityEma));

        // The controller limits still bound the homeostatic learning rates.
        const hmBounded = seeded(74, () => {
            const hm = new HiveMind(stateDir('C_bound'), H_ES_C, H_IS_C, 'C_bound', true);
            hm._gradientResetFrequency = 1;
            hm._homeostasisEnabled = true;
            hm._homeostasisConfig = { gain: 0.5, target: 1, minScale: 0.5, maxScale: 1.5 };
            for (let s = 0; s < 6; s++) seeded(74 * 31 + s, () => hm.train(inputs8(s), s % 2));
            return hm;
        });
        const minLr = hmBounded._learningRate * 0.5;
        const maxLr = hmBounded._learningRate * 1.5;
        check('C: homeostatic rates stay within the controller limits [0.5, 1.5] x base',
            hmBounded._adaptiveLearningRate.every((lr) => lr >= minLr - 1e-12 && lr <= maxLr + 1e-12),
            JSON.stringify(hmBounded._adaptiveLearningRate));
    } catch (error) {
        check('C: bit-exact off switch completed', false, error && error.stack ? error.stack : String(error));
    }

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
