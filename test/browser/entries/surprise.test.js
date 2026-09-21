// Surprise-gated memory writes — proof suite for `src/hivemind/memory/surprise.js`
// and its integration into `_updateSemanticProtos`.
//
// Grounding: Behrouz et al., "Titans: Learning to Memorize at Test Time"
// (arXiv 2501.00663). The memory bank is written by the *surprise* of an
// observation (prediction error against the current memory), not by every
// observation equally.
//
// The suite splits the guarantees so a failure names the tier:
//
//   A. PURE MATH (exact vectors + properties)
//      `surpriseFromSimilarity` and `surpriseGate` obey exact reference values,
//      are bounded in [floor, 1], monotone in the surprise, and collapse to the
//      identity when floor = 1 (the mathematical off switch).
//
//   B. THE GATE IS A BIT-EXACT NO-OP AT gate == 1
//      Two identically-seeded HiveMinds driven through the same
//      `_updateSemanticProtos` call produce bit-identical bank state when one
//      runs with the gate disabled and the other with `{floor: 1}` (gate == 1).
//      That is why the default-off feature cannot move a golden fingerprint.
//
//   C. SURPRISE SCALES THE WRITE (high-surprise written more strongly)
//      With the gate on, a novel candidate is written at nearly full strength
//      while a predictable one is attenuated toward the floor, and the measured
//      ratio matches `surpriseGate(1 - measuredSimilarity)` exactly.
//
// Like the other entries this takes an optional `{ ensureSql, stateDir }` so the
// node mirror can run against the real better-sqlite3 driver and a temp dir; in
// the browser harness it lazily loads the sql.js shim and uses the virtual fs.

import HiveMind from '../../../src/hivemind/hiveMind.js';
import {
    DEFAULT_SURPRISE_CONFIG,
    clamp01,
    surpriseFromSimilarity,
    surpriseGate,
    surpriseGateFromSimilarity,
    updateSurpriseMomentum,
    smoothedSurprise,
} from '../../../src/hivemind/memory/surprise.js';

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
    const stateDir = options.stateDir || ((label) => `state/surprise-${label}`);

    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
    const realRandom = Math.random;
    const seeded = (seed, fn) => {
        Math.random = mulberry32(seed);
        try { return fn(); } finally { Math.random = realRandom; }
    };
    const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

    // ---- A. pure math --------------------------------------------------------
    try {
        check('DEFAULT_SURPRISE_CONFIG is frozen', Object.isFrozen(DEFAULT_SURPRISE_CONFIG));
        check('surpriseFromSimilarity clamps and inverts',
            surpriseFromSimilarity(1) === 0 && surpriseFromSimilarity(0) === 1 &&
            surpriseFromSimilarity(-3) === 1 && surpriseFromSimilarity(4) === 0 &&
            close(surpriseFromSimilarity(0.3), 0.7),
            `f(1)=${surpriseFromSimilarity(1)} f(0)=${surpriseFromSimilarity(0)} f(0.3)=${surpriseFromSimilarity(0.3)}`);
        check('clamp01 handles NaN / infinities',
            clamp01(NaN) === 0 && clamp01(Infinity) === 1 && clamp01(-Infinity) === 0 && clamp01(0.5) === 0.5);

        const cfg = DEFAULT_SURPRISE_CONFIG;
        check('gate endpoints: gate(0)=floor, gate(1)=1',
            close(surpriseGate(0, cfg), cfg.floor) && close(surpriseGate(1, cfg), 1),
            `${surpriseGate(0, cfg)} .. ${surpriseGate(1, cfg)}`);
        check('gate exact reference value: 0.5 -> 0.55 (floor 0.1, sharpness 1)',
            close(surpriseGate(0.5, cfg), 0.55), String(surpriseGate(0.5, cfg)));
        check('gate from similarity: identical input -> floor, orthogonal -> 1',
            close(surpriseGateFromSimilarity(1, cfg), 0.1) && close(surpriseGateFromSimilarity(0, cfg), 1));

        let monotone = true;
        let bounded = true;
        let prev = -1;
        for (let i = 0; i <= 100; i++) {
            const s = i / 100;
            const g = surpriseGate(s, cfg);
            if (g < prev - 1e-12) monotone = false;
            if (g < cfg.floor - 1e-12 || g > 1 + 1e-12) bounded = false;
            prev = g;
        }
        check('gate is monotone non-decreasing in surprise', monotone);
        check('gate is bounded in [floor, 1]', bounded);

        check('floor = 0 makes the gate the identity on surprise',
            close(surpriseGate(0.25, { floor: 0 }), 0.25) && close(surpriseGate(0.9, { floor: 0 }), 0.9));
        check('floor = 1 makes the gate constant 1 for every surprise',
            [0, 0.3, 0.5, 1].every((s) => surpriseGate(s, { floor: 1 }) === 1));
        check('sharpness = 2 squares the floor-free gate',
            close(surpriseGate(0.25, { floor: 0, sharpness: 2 }), 0.0625),
            String(surpriseGate(0.25, { floor: 0, sharpness: 2 })));
        check('higher sharpness suppresses mild surprise more',
            surpriseGate(0.4, { floor: 0, sharpness: 3 }) < surpriseGate(0.4, { floor: 0, sharpness: 1 }));
        check('null config falls back to the defaults',
            close(surpriseGate(0.5, null), surpriseGate(0.5, cfg)) &&
            close(surpriseGate(0.5, undefined), surpriseGate(0.5, cfg)));

        check('momentum: decay=0 returns the raw surprise',
            close(updateSurpriseMomentum(0.9, 0.2, { momentumDecay: 0 }), 0.2));
        check('momentum: prev === surprise is a fixed point',
            close(updateSurpriseMomentum(0.42, 0.42, { momentumDecay: 0.9 }), 0.42));
        let m = 0;
        for (let i = 0; i < 400; i++) m = updateSurpriseMomentum(m, 0.8, { momentumDecay: 0.9 });
        check('momentum converges to a sustained surprise', close(m, 0.8, 1e-9), String(m));
        let spike = updateSurpriseMomentum(0, 1, { momentumDecay: 0.5 });
        const spikeAfterOne = updateSurpriseMomentum(spike, 1, { momentumDecay: 0.5 });
        let decayed = updateSurpriseMomentum(0, 1, { momentumDecay: 0.5 });
        for (let i = 0; i < 5; i++) decayed = updateSurpriseMomentum(decayed, 0, { momentumDecay: 0.5 });
        check('momentum: a fresh observation follows a spike before decaying',
            spikeAfterOne >= spike && spike > 0 && decayed < spike, `spike=${spike} after=${spikeAfterOne} decayed=${decayed}`);
        check('smoothedSurprise with weight 0 is exactly the raw surprise',
            smoothedSurprise(0.37, 0.9, { momentumWeight: 0 }) === 0.37);
        check('smoothedSurprise with weight 1 is exactly the momentum',
            smoothedSurprise(0.0, 0.6, { momentumWeight: 1 }) === 0.6);
    } catch (error) {
        check('A: pure math completed', false, error && error.stack ? error.stack : String(error));
    }

    // ---- shared setup for B/C ------------------------------------------------
    // Smallest possible model, one seeded semantic prototype, two crafted
    // candidates (a near one and a far one). Everything is deterministic: the
    // trial never touches Math.random outside `seeded`.
    const H_ES = 2, H_IS = 8;

    function buildTrial(label, seed, { gateEnabled, config, candidate }) {
        return seeded(seed, () => {
            const hm = new HiveMind(stateDir(label), H_ES, H_IS, label, true);
            const H = hm._hiddenSize;

            const baseMean = new Float32Array(H);
            for (let j = 0; j < H; j++) baseMean[j] = Math.sin(j * 0.7) * 1.2;
            const baseVar = new Float32Array(H).fill(5.0);

            const anchor = hm._createNewProto(baseMean, baseVar, 8, false);
            hm._finalizeSemanticProto(anchor, 0);
            hm._semanticProtos[0].push(anchor);

            const candMean = new Float32Array(H);
            for (let j = 0; j < H; j++) candMean[j] = baseMean[j] + candidate.offset(j, H, candidate.amp);
            const candidateVar = new Float32Array(H).fill(5.0);
            const cand = { mean: candMean, variance: candidateVar, size: 8, isCore: false };

            const measuredSim = hm._kernelSimilarity(cand, anchor);

            hm._surpriseGateEnabled = gateEnabled;
            hm._surpriseConfig = config;

            // Fix the RNG stream so the (rare) variance-inflation noise is
            // identical across trials regardless of the gate value.
            let bank;
            seeded(seed + 999, () => { hm._updateSemanticProtos(0, [cand]); bank = hm._semanticProtos[0]; });

            const added = bank[bank.length - 1];
            const snapshot = bank.map((p) => ({
                size: p.size, importance: p.importance, accessCount: p.accessCount,
                mean: Array.from(p.mean), variance: Array.from(p.variance),
            }));
            return { measuredSim, bankLength: bank.length, added, snapshot, fp: fingerprint(snapshot) };
        });
    }

    const NEAR = { offset: (j, H, amp) => amp * (mulberry32(1000 + j)() * 2 - 1), amp: 0.55, seed: 111 };
    const FAR = { offset: (j, H, amp) => amp * (mulberry32(2000 + j)() * 2 - 1), amp: 2.8, seed: 222 };

    const offNear = buildTrial('B_off_near', 41, { gateEnabled: false, config: null, candidate: NEAR });
    const offFar = buildTrial('B_off_far', 42, { gateEnabled: false, config: null, candidate: FAR });
    const floor1Near = buildTrial('B_f1_near', 41, { gateEnabled: true, config: { floor: 1 }, candidate: NEAR });
    const onNear = buildTrial('C_on_near', 41, { gateEnabled: true, config: DEFAULT_SURPRISE_CONFIG, candidate: NEAR });
    const onFar = buildTrial('C_on_far', 42, { gateEnabled: true, config: DEFAULT_SURPRISE_CONFIG, candidate: FAR });

    // ---- B. gate == 1 is a bit-exact no-op -----------------------------------
    try {
        check('B: the feature is off by default (goldens safe)',
            seeded(7, () => new HiveMind(stateDir('B_default'), H_ES, H_IS, 'B_default', true))._surpriseGateEnabled === false);
        check('B: both candidates form a new prototype (no merge confusion)',
            offNear.bankLength === 2 && offFar.bankLength === 2,
            `len ${offNear.bankLength} / ${offFar.bankLength}`);
        check('B: gate disabled vs gate floor=1 produce a bit-identical bank',
            offNear.fp === floor1Near.fp,
            `off ${offNear.fp} vs floor1 ${floor1Near.fp}`);
        const sameSize = offNear.snapshot.every((p, i) => p.size === floor1Near.snapshot[i].size);
        const sameImportance = offNear.snapshot.every((p, i) => p.importance === floor1Near.snapshot[i].importance);
        const sameMean = offNear.snapshot.every((p, i) => fingerprint(p.mean) === fingerprint(floor1Near.snapshot[i].mean));
        check('B: gate floor=1 leaves size, importance and mean bit-identical',
            sameSize && sameImportance && sameMean,
            `size=${sameSize} imp=${sameImportance} mean=${sameMean}`);
    } catch (error) {
        check('B: no-op at gate=1 completed', false, error && error.stack ? error.stack : String(error));
    }

    // ---- C. surprise scales the write ----------------------------------------
    try {
        const simNear = onNear.measuredSim;
        const simFar = onFar.measuredSim;
        const gateNear = surpriseGateFromSimilarity(simNear, DEFAULT_SURPRISE_CONFIG);
        const gateFar = surpriseGateFromSimilarity(simFar, DEFAULT_SURPRISE_CONFIG);

        check('C: the far candidate is measured as much less similar than the near one',
            simFar < simNear - 0.2, `simNear=${simNear.toFixed(4)} simFar=${simFar.toFixed(4)}`);
        check('C: the far candidate is therefore more surprising',
            surpriseFromSimilarity(simFar) > surpriseFromSimilarity(simNear),
            `${surpriseFromSimilarity(simFar).toFixed(4)} > ${surpriseFromSimilarity(simNear).toFixed(4)}`);

        check('C: ungated write size is the same for both candidates (only the gate differs)',
            offNear.added.size === offFar.added.size, `${offNear.added.size} vs ${offFar.added.size}`);

        check('C: gated size == ungated size * surpriseGate(1 - similarity), exactly',
            close(onNear.added.size, offNear.added.size * gateNear, 1e-9) &&
            close(onFar.added.size, offFar.added.size * gateFar, 1e-9),
            `near ${onNear.added.size} vs ${offNear.added.size * gateNear}; far ${onFar.added.size} vs ${offFar.added.size * gateFar}`);

        check('C: the novel candidate is written more strongly than the predictable one',
            onFar.added.size > onNear.added.size,
            `far ${onFar.added.size.toFixed(4)} > near ${onNear.added.size.toFixed(4)}`);
        check('C: the write-strength ratio is large (> 2x)',
            gateFar > gateNear * 2,
            `gateFar=${gateFar.toFixed(4)} gateNear=${gateNear.toFixed(4)} ratio=${(gateFar / gateNear).toFixed(2)}`);
        check('C: predictable writes are attenuated toward the floor',
            gateNear >= DEFAULT_SURPRISE_CONFIG.floor - 1e-12 && gateNear < 0.5 && gateFar > 0.6,
            `gateNear=${gateNear.toFixed(4)} gateFar=${gateFar.toFixed(4)}`);

        check('C: gated importance is <= ungated importance for the predictable write',
            onNear.added.importance <= offNear.added.importance + 1e-9,
            `${onNear.added.importance} <= ${offNear.added.importance}`);
        check('C: gated importance stays positive (floor keeps minimum plasticity)',
            onNear.added.importance > 0 && Number.isFinite(onNear.added.importance),
            String(onNear.added.importance));
    } catch (error) {
        check('C: write-strength scaling completed', false, error && error.stack ? error.stack : String(error));
    }

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
