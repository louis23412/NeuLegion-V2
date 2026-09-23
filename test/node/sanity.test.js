// Sanity / bug-regression suite for the hand-rolled core, run against the REAL
// better-sqlite3 driver (test/browser/entries/sanity.test.js is the same suite
// over the sql.js shim, executed in a Worker). Run with `npm test`.
//
// Where core.test.js checks the end-to-end controller contract, this exercises
// the internal invariants that the LSH dead-proto leak, the projNorms rescale
// bug and the NaN guards used to violate. Run it after ANY change to
// src/hivemind/.
//
// Every check is deterministic: Math.random is replaced with a seeded PRNG
// before construction, before each train and before each predict, so failures
// are reproducible. Each block gets its own temp state dir so persistence
// tests cannot cross-contaminate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import HiveMind from '../../src/hivemind/hiveMind.js';
import { isValidNumber, isFiniteNumber, truncateToDecimals, isValidTimestamp } from '../../src/hivemind/utils.js';
import { mulberry32, withSeed, tempStateDir, makeInputs } from './helpers.js';

// Deterministic training run: seeded RNG before construction, before every
// train and (optionally) before every predict.
function trainTrajectory(dir, es, is, rows, seed, { doPredict = false } = {}) {
    const preds = [];
    const original = Math.random;
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
        Math.random = original;
    }
}

// ---- A. predicate parity + edge cases ---------------------------------------
test('sanity A: predicates and edge cases', () => {
    // Exact twin predicates must agree on every edge input.
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
    const mismatches = [];
    for (const [label, v] of edge) {
        if (isValidNumber(v) !== isFiniteNumber(v)) mismatches.push(label);
    }
    assert.deepEqual(mismatches, [], `isFiniteNumber !== isValidNumber on: ${mismatches.join(',')}`);

    assert.equal(isValidNumber(0), true);
    assert.equal(isValidNumber('3'), true);
    assert.equal(isValidNumber('3.5'), true);
    assert.equal(isValidNumber('-2'), true);
    assert.equal(isValidNumber('3e2'), true);
    assert.equal(isValidNumber(''), false);
    assert.equal(isValidNumber(' '), false);
    assert.equal(isValidNumber(' 3'), false);
    assert.equal(isValidNumber('3 '), false);
    assert.equal(isValidNumber('1_000'), false);
    assert.equal(isValidNumber('0x10'), false);
    assert.equal(isValidNumber(NaN), false);
    assert.equal(isValidNumber(Infinity), false);
    assert.equal(isValidNumber(null), false);
    assert.equal(isValidNumber(undefined), false);
    assert.equal(isValidNumber(true), false);
    assert.equal(isValidNumber({}), false);

    assert.equal(truncateToDecimals(1.239, 2), 1.23, `got ${truncateToDecimals(1.239, 2)}`);
    assert.equal(truncateToDecimals(-1.239, 2), -1.23, `got ${truncateToDecimals(-1.239, 2)}`);
    assert.equal(truncateToDecimals(Infinity, 2), Infinity);
    assert.equal(truncateToDecimals(-2.9, 0), -2, `got ${truncateToDecimals(-2.9, 0)}`);

    assert.equal(isValidTimestamp(0), true);
    assert.equal(isValidTimestamp(NaN), false);
    assert.equal(isValidTimestamp(''), false);
    assert.equal(isValidTimestamp('  '), false);
    assert.equal(isValidTimestamp('2024-01-01T00:00:00Z'), true);
    assert.equal(isValidTimestamp({}), false);
});

// ---- B. trained weights/gradients stay finite + probabilities bounded -------
test('sanity B: finite weights, bounded predictions over a long run', () => {
    const rows = makeInputs(16, 140, 11);
    const { hm, preds } = trainTrajectory(tempStateDir('sanity-B'), 4, 16, rows, 11, { doPredict: true });
    const d = hm.diagnostics();

    const badPreds = preds.map((p, i) => [i, p]).filter(([, p]) => typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1);
    assert.deepEqual(badPreds.slice(0, 5), [], `bad predictions: ${JSON.stringify(badPreds.slice(0, 5))}`);
    assert.ok(new Set(preds.map((p) => p.toFixed(9))).size > 1, `predictions stuck: ${preds[0]}`);
    assert.equal(d.weights.nonFinite, 0, `nonFinite=${d.weights.nonFinite}`);
    assert.equal(d.gradients.nonFinite, 0, `nonFinite=${d.gradients.nonFinite}`);
    assert.ok(d.weights.count > 1000, `count=${d.weights.count}`);
    assert.ok(d.weights.max < 1e6 && d.weights.min > -1e6, `min=${d.weights.min} max=${d.weights.max}`);
    assert.equal(d.trainingStepCount, 140, `steps=${d.trainingStepCount}`);
    assert.ok(d.totals.semantic > 0, `semantic=${d.totals.semantic}`);
});

// ---- C. LSH index consistency (regression: dead-proto leak) -----------------
test('sanity C: LSH index consistent under churn', () => {
    const rows = makeInputs(12, 420, 23);
    const { hm } = trainTrajectory(tempStateDir('sanity-C'), 3, 12, rows, 23);
    const d = hm.diagnostics();

    assert.equal(d.lshConsistent, true, JSON.stringify({ problems: d.problems, dead: d.deadInBuckets, missing: d.missingFromBuckets }));
    assert.equal(d.deadInBuckets, 0, `dead=${d.deadInBuckets}`);
    assert.equal(d.missingFromBuckets, 0, `missing=${d.missingFromBuckets}`);

    // A live proto must occupy exactly numLshSets*lshNumTables buckets.
    const expectedRefs = d.numLshSets * d.lshNumTables;
    const badMultiplicity = d.members.filter((m) => m.bucketEntries !== expectedRefs * m.semantic);
    assert.deepEqual(badMultiplicity.slice(0, 3).map((m) => ({ idx: m.idx, sem: m.semantic, entries: m.bucketEntries, expected: expectedRefs * m.semantic })), []);

    const negative = d.members.filter((m) => m.semantic < 0 || m.attention < 0 || m.adaptive < 0);
    assert.deepEqual(negative, []);
    assert.ok(d.totals.semantic > 0, `semantic=${d.totals.semantic}`);
});

// ---- D. extreme inputs do not poison the model ------------------------------
test('sanity D: extreme inputs keep the model bounded', () => {
    const is = 12;
    const segs = [
        new Array(is).fill(1e6),
        new Array(is).fill(-1e6),
        new Array(is).fill(0),
        new Array(is).fill(1e-12),
        Array.from({ length: is }, (_, i) => (i % 2 ? -1e5 : 1e5)),
    ];
    const hm = withSeed(5, () => new HiveMind(tempStateDir('sanity-D'), 2, is, 'S', true));
    for (let s = 0; s < 30; s++) {
        const row = segs[s % segs.length];
        withSeed(50 + s, () => hm.train(row, s % 2));
        const p = withSeed(500 + s, () => hm.predict(row));
        assert.ok(Number.isFinite(p) && p >= 0 && p <= 1, `s=${s} p=${p}`);
    }
    assert.equal(hm.diagnostics().weights.nonFinite, 0);
});

// ---- E. determinism under identical seeding ---------------------------------
test('sanity E: same seed gives bit-identical weights', () => {
    const rows = makeInputs(12, 60, 31);
    const a = trainTrajectory(tempStateDir('sanity-E1'), 3, 12, rows, 31);
    const b = trainTrajectory(tempStateDir('sanity-E2'), 3, 12, rows, 31);
    const da = a.hm.diagnostics();
    const db = b.hm.diagnostics();

    assert.equal(da.weights.count, db.weights.count);
    assert.equal(da.weights.sum, db.weights.sum, `A=${da.weights.sum} B=${db.weights.sum}`);
    assert.equal(da.weights.sumSq, db.weights.sumSq, `A=${da.weights.sumSq} B=${db.weights.sumSq}`);
    assert.equal(da.totals.semantic, db.totals.semantic, `A=${da.totals.semantic} B=${db.totals.semantic}`);
});

// ---- F. persistence round-trip ----------------------------------------------
// Weights/gradients are persisted as Float32Array blobs (#saveState), so a
// reloaded instance is float32-rounded relative to the in-memory float64 model.
// Two instances loaded from the SAME snapshot must be bit-identical to each
// other; the reloaded copy must merely stay close to the in-memory one.
test('sanity F: persistence round-trip is stable', () => {
    const dir = tempStateDir('sanity-F');
    const rows = makeInputs(12, 50, 41);
    const { hm } = trainTrajectory(dir, 3, 12, rows, 41, { doPredict: true });
    hm.dumpState();

    const snapshot = hm.diagnostics();
    const reloadA = new HiveMind(dir, 3, 12, 'S', true);
    const reloadB = new HiveMind(dir, 3, 12, 'S', true);

    const probes = makeInputs(12, 8, 77);
    const predOriginal = probes.map((p) => withSeed(7, () => hm.predict(p)));
    const predA = probes.map((p) => withSeed(7, () => reloadA.predict(p)));
    const predB = probes.map((p) => withSeed(7, () => reloadB.predict(p)));

    const dA = reloadA.diagnostics();
    const dB = reloadB.diagnostics();
    const abMax = Math.max(...predA.map((v, i) => Math.abs(v - predB[i])));
    assert.equal(abMax, 0, `maxDiff=${abMax}`);
    assert.equal(dA.weights.sum, dB.weights.sum);
    assert.equal(dA.weights.sumSq, dB.weights.sumSq);
    assert.equal(dA.lshConsistent, true, JSON.stringify(dA.problems));
    assert.equal(dB.lshConsistent, true, JSON.stringify(dB.problems));

    const drift = Math.max(...predOriginal.map((v, i) => Math.abs(v - predA[i])));
    assert.ok(drift < 5e-3, `maxDrift=${drift}`);
    const relFingerprint = Math.abs(snapshot.weights.sum - dA.weights.sum) / Math.max(1e-9, Math.abs(snapshot.weights.sum));
    assert.ok(relFingerprint < 1e-4, `rel=${relFingerprint}`);
});

// ---- G. public API input validation -----------------------------------------
test('sanity G: public API rejects malformed input', () => {
    const hm = withSeed(3, () => new HiveMind(tempStateDir('sanity-G'), 2, 8, 'S', true));
    // R27-4 (BUGS.md #46): an invalid vector returns NaN (not the legal-looking 0,
    // which the position policy would read as a maximal short), and a rejected
    // training row returns the CURRENT step count (never a bare `undefined`) while
    // incrementing the rejection counter.
    const startSteps = hm._trainingStepCount;
    assert.ok(Number.isNaN(withSeed(3, () => hm.predict([1, 2, 3]))));
    assert.ok(Number.isNaN(withSeed(3, () => hm.predict(new Array(8).fill('x')))));
    assert.ok(Number.isNaN(withSeed(3, () => hm.predict('nope'))));
    assert.equal(withSeed(3, () => hm.train([1, 2], 1)), startSteps);
    assert.equal(withSeed(3, () => hm.train(new Array(8).fill(0.5), NaN)), startSteps);
    assert.equal(hm._trainingStepCount, startSteps);
    assert.equal(hm._rejectedTrainRows, 2, `rejected=${hm._rejectedTrainRows}`);
    const step = withSeed(3, () => hm.train(new Array(8).fill(0.5), 1));
    assert.ok(typeof step === 'number' && step === startSteps + 1, `step=${step}`);
});

// ---- H. broadcastMemory / translateMemory shape -----------------------------
test('sanity H: broadcast/translate memory shapes', () => {
    const rows = makeInputs(10, 80, 55);
    const { hm } = trainTrajectory(tempStateDir('sanity-H'), 3, 10, rows, 55);
    const bc = hm.broadcastMemory(rows.at(-1), 0.15);
    const hiddenSize = hm.diagnostics().hiddenSize;

    assert.ok(bc && Array.isArray(bc.memories), JSON.stringify(Object.keys(bc || {})));
    assert.ok(bc.memories.length > 0, `n=${bc.memories.length}`);
    const shapeOk = bc.memories.every((m) => Array.isArray(m.mean) && m.mean.length === hiddenSize && m.mean.every(Number.isFinite));
    assert.ok(shapeOk, `hiddenSize=${hiddenSize}`);

    const tr = hm.translateMemory(bc.memories, rows.at(-1), 0.15);
    assert.ok(tr && Number.isFinite(tr.injectedRatio) && tr.injectedRatio >= 0 && tr.injectedRatio <= 100, JSON.stringify(tr));
});

// ---- I. diagnostics() self-consistency --------------------------------------
test('sanity I: diagnostics() agrees with state files on disk', () => {
    const dir = tempStateDir('sanity-I');
    const rows = makeInputs(12, 30, 61);
    const { hm } = trainTrajectory(dir, 2, 12, rows, 61);
    hm.dumpState();
    const d = hm.diagnostics();

    assert.ok(fs.existsSync(dir), `state dir missing: ${dir}`);
    assert.equal(d.status, 'ok');
    assert.equal(d.inputSize, 12);
    assert.equal(d.ensembleSize, 2);
    assert.equal(d.members.length, 2);
    assert.equal(d.trainingStepCount, 30);
    assert.deepEqual(d.problems, []);
});
