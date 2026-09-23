// Sanity / bug-regression suite for the hand-rolled core. Executed in a Worker
// via test/browser/harness.js (see README). Complements core.test.js: where that
// checks the end-to-end controller contract, this exercises the internal
// invariants that the LSH leak, the projNorms rescale bug and the NaN guards
// used to violate. Run it after ANY change to src/hivemind/.
//
// Every check is deterministic: Math.random is replaced with a seeded PRNG
// before construction, before each train and before each predict, so failures
// are reproducible.

import { __ensureSql } from '../shims/better-sqlite3.js';
import HiveMind from '../../../src/hivemind/hiveMind.js';
import { isValidNumber, isFiniteNumber, truncateToDecimals, isValidTimestamp } from '../../../src/hivemind/utils.js';

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Deterministic per-step input vectors. A mix of smooth/sinusoidal structure,
// sign flips and rare spikes so protos actually form and get pruned (which is
// what exercises the LSH insert/remove/update paths).
function makeInputs(inputSize, steps, seed = 7) {
    const rnd = mulberry32(seed);
    const rows = [];
    for (let s = 0; s < steps; s++) {
        const row = new Array(inputSize);
        for (let i = 0; i < inputSize; i++) {
            const base = Math.sin((s + i * 3) * 0.17) * 0.5 + 0.5;
            const noise = (rnd() - 0.5) * 0.4;
            const spike = (s % 37 === 0 && i % 5 === 0) ? (rnd() - 0.5) * 6 : 0;
            row[i] = base + noise + spike;
        }
        rows.push(row);
    }
    return rows;
}

function trainTrajectory(dir, es, is, rows, seed, { doPredict = false } = {}) {
    const preds = [];
    const R = Math.random;
    try {
        Math.random = mulberry32(seed);
        const hm = new HiveMind(dir, es, is, 'S', true);
        for (let s = 0; s < rows.length; s++) {
            Math.random = mulberry32(seed + 1000 + s);
            hm.train(rows[s], s % 2);
            if (doPredict) {
                Math.random = mulberry32(seed + 90000 + s);
                preds.push(hm.predict(rows[s]));
            }
        }
        return { hm, preds };
    } finally {
        Math.random = R;
    }
}

export async function run() {
    await __ensureSql();
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    // ---- A. predicate parity + edge cases -----------------------------------
    try {
        const edge = [
            ['zero', 0], ['negzero', -0], ['int', 3], ['negint', -3], ['float', 1.5],
            ['tiny', 1e-9], ['huge', 1e12], ['nan', NaN], ['inf', Infinity], ['-inf', -Infinity],
            ['null', null], ['undefined', undefined], ['true', true], ['false', false],
            ['obj', {}], ['arr', []], ['arrnum', [3]], ['fn', () => 1],
            ['empty', ''], ['space', ' '], ['numstr', '3'], ['spacenum', ' 3'],
            ['floatstr', '3.5'], ['negstr', '-2'], ['exp', '3e2'], ['expneg', '1e-3'],
            ['underscore', '1_000'], ['hex', '0x10'], ['word', 'abc'], ['pad', '3 '],
            ['plus', '+3'], ['trail', '3.'], ['dotlead', '.5'],
        ];
        let parity = true; let mismatches = [];
        for (const [label, v] of edge) {
            const a = isValidNumber(v);
            const b = isFiniteNumber(v);
            if (a !== b) { parity = false; mismatches.push(`${label}:${a}/${b}`); }
        }
        check('isFiniteNumber === isValidNumber on all edge inputs', parity, mismatches.join(','));

        const expectations = [
            ['0 is valid', isValidNumber(0) === true],
            ['"3" is valid', isValidNumber('3') === true],
            ['"3.5" is valid', isValidNumber('3.5') === true],
            ['"-2" is valid', isValidNumber('-2') === true],
            ['"3e2" is valid', isValidNumber('3e2') === true],
            ['"" invalid', isValidNumber('') === false],
            ['" " invalid', isValidNumber(' ') === false],
            ['" 3" invalid', isValidNumber(' 3') === false],
            ['"3 " invalid', isValidNumber('3 ') === false],
            ['"1_000" invalid', isValidNumber('1_000') === false],
            ['"0x10" invalid', isValidNumber('0x10') === false],
            ['NaN invalid', isValidNumber(NaN) === false],
            ['Infinity invalid', isValidNumber(Infinity) === false],
            ['null invalid', isValidNumber(null) === false],
            ['undefined invalid', isValidNumber(undefined) === false],
            ['true invalid', isValidNumber(true) === false],
            ['{} invalid', isValidNumber({}) === false],
        ];
        for (const [name, pass] of expectations) check(name, pass);

        check('truncateToDecimals truncates toward zero (+)', truncateToDecimals(1.239, 2) === 1.23, `${truncateToDecimals(1.239, 2)}`);
        check('truncateToDecimals truncates toward zero (-)', truncateToDecimals(-1.239, 2) === -1.23, `${truncateToDecimals(-1.239, 2)}`);
        check('truncateToDecimals preserves non-finite', truncateToDecimals(Infinity, 2) === Infinity);
        check('truncateToDecimals 0 decimals', truncateToDecimals(-2.9, 0) === -2, `${truncateToDecimals(-2.9, 0)}`);

        check('isValidTimestamp accepts finite number', isValidTimestamp(0) === true);
        check('isValidTimestamp rejects NaN', isValidTimestamp(NaN) === false);
        check('isValidTimestamp rejects empty/blank string', isValidTimestamp('') === false && isValidTimestamp('  ') === false);
        check('isValidTimestamp accepts ISO string', isValidTimestamp('2024-01-01T00:00:00Z') === true);
        check('isValidTimestamp rejects object', isValidTimestamp({}) === false);
    } catch (e) {
        check('predicate block completed', false, e.stack);
    }

    // ---- B. trained weights/gradients stay finite + probabilities bounded ----
    try {
        const rows = makeInputs(16, 140, 11);
        const { hm, preds } = trainTrajectory('state/sanity-B', 4, 16, rows, 11, { doPredict: true });
        const d = hm.diagnostics();

        const badPreds = preds.map((p, i) => [i, p]).filter(([, p]) => typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1);
        check('all predictions finite in [0,1]', badPreds.length === 0, JSON.stringify(badPreds.slice(0, 5)));
        check('predictions vary (not stuck at one value)', new Set(preds.map((p) => p.toFixed(9))).size > 1, `unique=${new Set(preds.map((p) => p.toFixed(9))).size}`);
        check('weights all finite after 140 trains', d.weights.nonFinite === 0, `nonFinite=${d.weights.nonFinite}`);
        check('gradients all finite after 140 trains', d.gradients.nonFinite === 0, `nonFinite=${d.gradients.nonFinite}`);
        check('weight tensor populated', d.weights.count > 1000, `count=${d.weights.count}`);
        check('weight magnitudes bounded', d.weights.max < 1e6 && d.weights.min > -1e6, `min=${d.weights.min} max=${d.weights.max}`);
        check('training step count is exact', d.trainingStepCount === 140, `steps=${d.trainingStepCount}`);
        check('semantic protos were created', d.totals.semantic > 0, `semantic=${d.totals.semantic}`);
    } catch (e) {
        check('finite-training block completed', false, e.stack);
    }

    // ---- C. LSH index consistency (regression: dead-proto leak) -------------
    // Heavy churn so protos are inserted, updated and pruned many times.
    try {
        const rows = makeInputs(12, 420, 23);
        const { hm } = trainTrajectory('state/sanity-C', 3, 12, rows, 23);
        const d = hm.diagnostics();

        check('LSH index consistent after churn', d.lshConsistent === true, JSON.stringify({ problems: d.problems, dead: d.deadInBuckets, missing: d.missingFromBuckets }));
        check('no dead protos left in LSH buckets', d.deadInBuckets === 0, `dead=${d.deadInBuckets}`);
        check('no live protos missing from LSH buckets', d.missingFromBuckets === 0, `missing=${d.missingFromBuckets}`);

        const expectedRefs = d.numLshSets * d.lshNumTables;
        const badMultiplicity = d.members.filter((m) => m.bucketEntries !== expectedRefs * m.semantic);
        check('each proto occupies exactly numLshSets*lshNumTables buckets', badMultiplicity.length === 0,
            JSON.stringify(badMultiplicity.slice(0, 3).map((m) => ({ idx: m.idx, sem: m.semantic, entries: m.bucketEntries, expected: expectedRefs * m.semantic }))));

        const negative = d.members.filter((m) => m.semantic < 0 || m.attention < 0 || m.adaptive < 0);
        check('memory bank counts non-negative', negative.length === 0, JSON.stringify(negative));

        check('protos created across members', d.totals.semantic > 0, `semantic=${d.totals.semantic}`);
    } catch (e) {
        check('LSH consistency block completed', false, e.stack);
    }

    // ---- D. extreme inputs do not poison the model --------------------------
    try {
        const is = 12;
        const segs = [
            new Array(is).fill(1e6),
            new Array(is).fill(-1e6),
            new Array(is).fill(0),
            new Array(is).fill(1e-12),
            Array.from({ length: is }, (_, i) => (i % 2 ? -1e5 : 1e5)),
        ];
        const R = Math.random;
        Math.random = mulberry32(5);
        const hm = new HiveMind('state/sanity-D', 2, is, 'S', true);
        let ok = true; let detail = '';
        for (let s = 0; s < 30; s++) {
            const row = segs[s % segs.length];
            Math.random = mulberry32(50 + s);
            hm.train(row, s % 2);
            Math.random = mulberry32(500 + s);
            const p = hm.predict(row);
            if (!Number.isFinite(p) || p < 0 || p > 1) { ok = false; detail = `s=${s} p=${p}`; break; }
        }
        Math.random = R;
        const d = hm.diagnostics();
        check('extreme inputs keep predictions bounded', ok, detail);
        check('extreme inputs leave weights finite', d.weights.nonFinite === 0, `nonFinite=${d.weights.nonFinite}`);
    } catch (e) {
        check('extreme input block completed', false, e.stack);
    }

    // ---- E. determinism under identical seeding ----------------------------
    try {
        const rows = makeInputs(12, 60, 31);
        const a = trainTrajectory('state/sanity-E1', 3, 12, rows, 31);
        const b = trainTrajectory('state/sanity-E2', 3, 12, rows, 31);
        const da = a.hm.diagnostics(); const db = b.hm.diagnostics();
        check('weights bit-identical for same seed', da.weights.count === db.weights.count && da.weights.sum === db.weights.sum && da.weights.sumSq === db.weights.sumSq,
            `A=${da.weights.sum.toExponential(6)} B=${db.weights.sum.toExponential(6)}`);
        check('semantic count deterministic', da.totals.semantic === db.totals.semantic, `A=${da.totals.semantic} B=${db.totals.semantic}`);
    } catch (e) {
        check('determinism block completed', false, e.stack);
    }

    // ---- F. persistence round-trip -----------------------------------------
    // NOTE: weights/gradients are persisted as Float32Array blobs (#saveState),
    // so a reloaded instance is float32-rounded relative to the in-memory
    // float64 model. Two instances loaded from the SAME snapshot must be
    // bit-identical to each other; the reloaded copy must merely stay close to
    // the in-memory one (the residual drift is the storage precision loss).
    try {
        const rows = makeInputs(12, 50, 41);
        const { hm } = trainTrajectory('state/sanity-F', 3, 12, rows, 41, { doPredict: true });
        hm.dumpState();

        const snapshot = hm.diagnostics();
        const reloadA = new HiveMind('state/sanity-F', 3, 12, 'S', true);
        const reloadB = new HiveMind('state/sanity-F', 3, 12, 'S', true);

        const R = Math.random;
        const probes = makeInputs(12, 8, 77);
        const predOriginal = []; const predA = []; const predB = [];
        for (const p of probes) { Math.random = mulberry32(7); predOriginal.push(hm.predict(p)); }
        for (const p of probes) { Math.random = mulberry32(7); predA.push(reloadA.predict(p)); }
        for (const p of probes) { Math.random = mulberry32(7); predB.push(reloadB.predict(p)); }
        Math.random = R;

        const dA = reloadA.diagnostics(); const dB = reloadB.diagnostics();
        const abMax = Math.max(...predA.map((v, i) => Math.abs(v - predB[i])));
        check('two reloads of one snapshot are bit-identical', abMax === 0, `maxDiff=${abMax}`);
        check('reload A fingerprint === reload B fingerprint', dA.weights.sum === dB.weights.sum && dA.weights.sumSq === dB.weights.sumSq);
        check('reloaded LSH consistent', dA.lshConsistent === true && dB.lshConsistent === true, JSON.stringify([dA.problems, dB.problems]));

        const drift = Math.max(...predOriginal.map((v, i) => Math.abs(v - predA[i])));
        check('reloaded predictions track in-memory model (float32 storage)', drift < 5e-3, `maxDrift=${drift}`);
        const relFingerprint = Math.abs(snapshot.weights.sum - dA.weights.sum) / Math.max(1e-9, Math.abs(snapshot.weights.sum));
        check('reloaded weight fingerprint close to in-memory (float32)', relFingerprint < 1e-4, `rel=${relFingerprint}`);
    } catch (e) {
        check('persistence block completed', false, e.stack);
    }

    // ---- G. public API input validation ------------------------------------
    try {
        const hm = new HiveMind('state/sanity-G', 2, 8, 'S', true);
        Math.random = mulberry32(3);
        const startSteps = hm._trainingStepCount;
        // R27-4 (BUGS.md #46): a degraded input must not be read as a legal extreme.
        // `predict` on an invalid vector returns NaN (not 0, which the position
        // policy would read as a maximal short); the controller turns a non-finite
        // prediction into its -1 abstention.
        check('R27-4: predict rejects a wrong-length input with NaN (never a legal-looking 0)',
            Number.isNaN(hm.predict([1, 2, 3])));
        check('R27-4: predict rejects a non-numeric input with NaN',
            Number.isNaN(hm.predict(new Array(8).fill('x'))));
        check('R27-4: predict rejects a non-array input with NaN',
            Number.isNaN(hm.predict('nope')));
        // `train` returns the CURRENT step count (never a bare `undefined`, which
        // would be bound into the NOT NULL `global_stats` value) and counts the drop.
        check('R27-4: train rejects a wrong-length row without corrupting the step counter',
            hm.train([1, 2], 1) === startSteps && hm._trainingStepCount === startSteps);
        check('R27-4: train rejects a NaN target without corrupting the step counter',
            hm.train(new Array(8).fill(0.5), NaN) === startSteps && hm._trainingStepCount === startSteps);
        check('R27-4: every rejected training row is counted (the drop is visible, not silent)',
            hm._rejectedTrainRows === 2, `rejected=${hm._rejectedTrainRows}`);
        const step = hm.train(new Array(8).fill(0.5), 1);
        check('train accepts valid input', typeof step === 'number' && step === startSteps + 1, `step=${step}`);
    } catch (e) {
        check('API validation block completed', false, e.stack);
    }

    // ---- H. broadcastMemory / translateMemory shape -------------------------
    try {
        const rows = makeInputs(10, 80, 55);
        const { hm } = trainTrajectory('state/sanity-H', 3, 10, rows, 55);
        const bc = hm.broadcastMemory(rows.at(-1), 0.15);
        const hiddenSize = hm.diagnostics().hiddenSize;
        const shapeOk = bc && Array.isArray(bc.memories) && bc.memories.every((m) => Array.isArray(m.mean) && m.mean.length === hiddenSize && m.mean.every(Number.isFinite));
        check('broadcastMemory memories well-formed', shapeOk, `n=${bc?.memories?.length}`);
        check('broadcastMemory returns at least one memory', bc.memories.length > 0, `n=${bc.memories.length}`);
        const tr = hm.translateMemory(bc.memories, rows.at(-1), 0.15);
        check('translateMemory injects a sane ratio', tr && Number.isFinite(tr.injectedRatio) && tr.injectedRatio >= 0 && tr.injectedRatio <= 100, JSON.stringify(tr));
    } catch (e) {
        check('broadcast block completed', false, e.stack);
    }

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
