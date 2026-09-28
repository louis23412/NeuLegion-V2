// The V2.0 wrapper proof — `src/plugins/learners/legacy-hivemind.js`.
//
// V2.0's acceptance condition is that the contract layer is *additive*: the
// shipped engine's 11 golden fingerprints must reproduce with zero edits to any
// locked module (`docs/ARCHITECTURE-v2.md` §9). `golden.test.js` is the engine's
// own proof; this suite is the *adapter's* proof, i.e. that the single bridge
// between the V2 registry and the engine is a pass-through:
//
//   A. THE FACTORY SHAPE   the plugin is a stateful factory (create()) with no
//                          instance methods of its own, frozen defaults, and the
//                          engine's own argument validation (a missing state dir
//                          throws rather than constructing a broken model).
//   B. THE INSTANCE        create() returns an object satisfying the learner
//                          contract; fit/predict are the engine's own methods
//                          (a malformed vector still returns the engine's
//                          documented NaN, and `fit` still returns the monotone
//                          training-step count); diagnostics()/dumpState() pass
//                          through; two instances share no state.
//   C. NO MODULE-EVAL SIDE EFFECT   importing the adapter registers NOTHING (the
//                          composition root registers) — the audit's objection to
//                          `legion/database.js` is not re-created.
//   D. THE ENGINE IS UNMOVED   the same (dir, es, is, id, seed) trajectory read
//                          through the adapter twice is bit-identical, and
//                          registering the adapter does not change the engine's
//                          prototype surface.
//
// Like the other engine-touching entries it takes the standard
// `{ ensureSql, stateDir }` so the node mirror runs against the real
// better-sqlite3 driver and a temp directory.

import HiveMind from '../../../src/hivemind/hiveMind.js';
import { LEARNER_CONTRACT, validatePlugin, validateInstance } from '../../../src/core/contracts/index.js';
import { CAPABILITIES } from '../../../src/core/contracts/base.js';
import {
    registerPlugin,
    resolve,
    ids,
    resetRegistry,
    stackSnapshot,
    rosterSnapshot,
    registeredKinds,
} from '../../../src/core/registry.js';
import { legacyHivemindLearner, LEGACY_HIVEMIND_DEFAULTS } from '../../../src/plugins/learners/legacy-hivemind.js';

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function withSeed(seed, fn) {
    const original = Math.random;
    Math.random = mulberry32(seed);
    try { return fn(); } finally { Math.random = original; }
}

function makeRows(steps, size, seed = 5) {
    const rnd = mulberry32(seed);
    const rows = [];
    for (let s = 0; s < steps; s++) {
        const row = new Array(size);
        for (let i = 0; i < size; i++) row[i] = Math.sin((s + i * 3) * 0.17) * 0.5 + 0.5 + (rnd() - 0.5) * 0.4;
        rows.push(row);
    }
    return rows;
}

export async function run(options = {}) {
    if (options.ensureSql) await options.ensureSql();
    else {
        const shim = await import('../shims/better-sqlite3.js');
        await shim.__ensureSql();
    }
    const stateDir = options.stateDir || ((label) => `state/legacy-hivemind-${label}`);

    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    resetRegistry();

    // ---- A. the factory shape ------------------------------------------------
    check('A: the adapter satisfies the learner contract as a factory',
        validatePlugin(LEARNER_CONTRACT, legacyHivemindLearner).ok === true);
    check('A: the adapter claims the model capability and no instance methods of its own',
        legacyHivemindLearner.capability === CAPABILITIES.MODEL &&
        typeof legacyHivemindLearner.fit === 'undefined' && typeof legacyHivemindLearner.predict === 'undefined');
    check('A: the defaults are frozen and match the golden suite\'s bare model (es=3, forceMin)',
        Object.isFrozen(LEGACY_HIVEMIND_DEFAULTS) && LEGACY_HIVEMIND_DEFAULTS.ensembleSize === 3 &&
        LEGACY_HIVEMIND_DEFAULTS.forceMin === true && LEGACY_HIVEMIND_DEFAULTS.inputSize === 1);
    check('A: a missing state directory throws the adapter\'s own guard',
        (() => { try { legacyHivemindLearner.create({}); return false; } catch (e) { return e.message.includes('directoryPath'); } })());

    // ---- C. no module-eval side effect ---------------------------------------
    check('C: importing the adapter registered nothing', registeredKinds().length === 0 && ids('learner').length === 0);

    // ---- B/D. a live instance through the adapter ----------------------------
    const rows = makeRows(6, 12);
    let instance = null;
    try {
        // A FRESH state dir initialises the ensemble from `Math.random()`, so the
        // construction is seeded exactly as the golden entry does it (build under a
        // fixed seed -> a bit-reproducible model).
        instance = withSeed(11, () => legacyHivemindLearner.create({ directoryPath: stateDir('adapter'), ensembleSize: 3, inputSize: 12, hiveId: 'ADAPT' }));
        check('B: create() returns an instance satisfying the learner contract',
            validateInstance(LEARNER_CONTRACT, instance).length === 0);
    } catch (e) {
        check('B: create() returns an instance satisfying the learner contract', false, String(e && e.message).slice(0, 200));
    }

    if (instance) {
        check('B: predict() is the engine\'s own (a finite probability)', (() => {
            const p = withSeed(101, () => instance.predict(rows[0]));
            return Number.isFinite(p) && p >= 0 && p <= 1;
        })());
        check('B: a malformed vector still returns the engine\'s NaN sentinel (the guard is not swallowed)',
            Number.isNaN(instance.predict([1, 2])) && Number.isNaN(instance.predict(null)));
        check('B: fit() returns the engine\'s monotone training-step count', (() => {
            const before = instance.fit(rows[0], 1);
            const after = instance.fit(rows[1], 0);
            return Number.isInteger(before) && Number.isInteger(after) && after === before + 1;
        })());
        check('B: diagnostics() passes the engine\'s read-only report through',
            (() => { const d = instance.diagnostics(); return d && typeof d === 'object' && 'members' in d; })());
        check('B: dumpState() passes the engine\'s persistence through',
            (() => { const dumped = instance.dumpState(); return dumped !== undefined; })());
        check('B: two instances share no state', (() => {
            const other = withSeed(12, () => legacyHivemindLearner.create({ directoryPath: stateDir('adapter2'), ensembleSize: 3, inputSize: 12, hiveId: 'ADAPT2' }));
            return other !== instance && other.model !== instance.model && typeof other.predict === 'function';
        })());
    } else {
        check('B: predict() is the engine\'s own (a finite probability)', false, 'no instance');
    }

    // ---- D. the engine is unmoved by the registry ----------------------------
    check('D: the engine prototype surface is the shipped one',
        typeof HiveMind.prototype.predict === 'function' && typeof HiveMind.prototype.train === 'function' &&
        typeof HiveMind.prototype.diagnostics === 'function' && typeof HiveMind.prototype.dumpState === 'function');

    check('D: the same seeded trajectory read through the adapter twice is bit-identical', (() => {
        const a = withSeed(11, () => legacyHivemindLearner.create({ directoryPath: stateDir('det-a'), ensembleSize: 3, inputSize: 12, hiveId: 'DET' }));
        const b = withSeed(11, () => legacyHivemindLearner.create({ directoryPath: stateDir('det-b'), ensembleSize: 3, inputSize: 12, hiveId: 'DET' }));
        const trajectory = (inst) => rows.map((row, i) => withSeed(7000 + i, () => inst.predict(row)));
        const ta = trajectory(a);
        const tb = trajectory(b);
        return ta.length === rows.length && ta.every((p, i) => p === tb[i]) && ta.every((p) => Number.isFinite(p));
    })());

    // ---- registering the adapter moves the roster, not the engine ------------
    const before = ids('learner').length;
    registerPlugin('learner', legacyHivemindLearner, { state: 'LIVE', defaultStack: true });
    check('D: registering the adapter adds it to the roster and the stack pin',
        before === 0 && ids('learner').length === 1 && resolve('learner', 'legacy-hivemind').defaultStack === true &&
        /^[0-9a-f]{8}$/.test(stackSnapshot()) && /^[0-9a-f]{8}$/.test(rosterSnapshot()));
    resetRegistry();

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
