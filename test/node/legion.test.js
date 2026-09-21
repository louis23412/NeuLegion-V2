// Node mirror of test/browser/entries/legion.test.js.
//
// Exercises the src/legion/* modules split out of the original monolithic
// mainController.js. The modules are imported dynamically, after pointing
// CONFIG.stateFolder at a temp directory, so the two SQLite databases (opened at
// module evaluation time, exactly as the original monolith did) are created in
// a throwaway location instead of the repo. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tempStateDir } from './helpers.js';

let legionPromise = null;

async function loadLegion() {
    if (legionPromise) return legionPromise;
    legionPromise = (async () => {
    const { CONFIG } = await import('../../src/legion/config.js');
    CONFIG.stateFolder = tempStateDir('legion');
    const { state } = await import('../../src/legion/state.js');
    const { PriorityQueue } = await import('../../src/legion/priorityQueue.js');
    const { legionAccuracy } = await import('../../src/legion/accuracy.js');
    const structure = await import('../../src/legion/structure.js');
    const ser = await import('../../src/legion/serialization.js');
    const { initLegion } = await import('../../src/legion/init.js');
    const { saveLegionState } = await import('../../src/legion/persistence.js');
    const { getCleanLegionState } = await import('../../src/legion/broadcast.js');
    const { getCurrentMarketContext } = await import('../../src/legion/signals.js');
    const runner = await import('../../src/legion/runner.js');
    const batch = await import('../../src/legion/batch.js');
    const workers = await import('../../src/legion/workers.js');
    const net = await import('../../src/legion/net.js');
    return { CONFIG, state, PriorityQueue, legionAccuracy, structure, ser, initLegion, saveLegionState, getCleanLegionState, getCurrentMarketContext, runner, batch, workers, net };
    })();
    return legionPromise;
}

test('legion exports every entry point', async () => {
    const L = await loadLegion();
    for (const fn of [
        L.runner.processCandles, L.batch.processBatch, L.workers.runWorker, L.workers.runConsolidationWorker,
        L.initLegion, L.saveLegionState, L.getCleanLegionState, L.getCurrentMarketContext,
        L.structure.getTierAndType, L.structure.buildFreshStructure, L.structure.getControllerParams,
        L.ser.vectorToBlob, L.ser.blobToVector, L.ser.canonicalJSON, L.ser.computeContentHash,
        L.ser.computeGaussianDistance, L.net.getLocalIP,
    ]) assert.equal(typeof fn, 'function');
    assert.equal(typeof L.PriorityQueue, 'function');
});

test('PriorityQueue is a correct min-heap', async () => {
    const { PriorityQueue } = await loadLegion();
    const pq = new PriorityQueue();
    const vals = [];
    for (let i = 0; i < 300; i++) { const d = ((i * 2654435761) % 10007) / 10007 * 1000; vals.push(d); pq.push({ accumDist: d, i }); }
    assert.equal(pq.size, 300);
    const out = [];
    while (pq.size > 0) out.push(pq.pop().accumDist);
    for (let i = 1; i < out.length; i++) assert.ok(out[i - 1] <= out[i], `not sorted at ${i}`);
    assert.equal(pq.pop(), null);
});

test('serialization helpers round-trip and hash stably', async () => {
    const { ser } = await loadLegion();
    const vec = [0.5, -1.25, 3, 1e-9, -0];
    const round = ser.blobToVector(ser.vectorToBlob(vec));
    vec.forEach((v, i) => assert.ok(Object.is(v, round[i]), `${v} !== ${round[i]}`));
    assert.equal(ser.vectorToBlob([]).length, 0);
    assert.equal(ser.canonicalJSON({ b: 1, a: [2, { d: 3, c: 4 }] }), ser.canonicalJSON({ a: [2, { c: 4, d: 3 }], b: 1 }));
    assert.equal(ser.computeContentHash([1, 2, 3]), ser.computeContentHash([1, 2, 3]));
    assert.notEqual(ser.computeContentHash([1, 2, 3]), ser.computeContentHash([1, 2, 4]));
    assert.ok(Number.isFinite(ser.computeGaussianDistance([0, 0], [1, 1], [1, 1], [1, 1])));
});

test('legion boots, builds its structure and persists a snapshot', async () => {
    const L = await loadLegion();
    const { CONFIG, state } = L;
    state.structureDims = [
        CONFIG.baseGroups, CONFIG.baseSections, CONFIG.baseLayers,
        (CONFIG.basePairs * 2) + ((CONFIG.maxTier - 1) * (CONFIG.elderPairs * 2)),
    ];
    const fresh = L.structure.buildFreshStructure();
    assert.equal(fresh.flat(3).length, state.structureDims.reduce((a, b) => a * b, 1));

    const loaded = L.initLegion();
    assert.ok(Number.isFinite(loaded));
    assert.equal(state.structureMap.flat(3).length, fresh.flat(3).length);
    assert.ok(state.structureMap.flat(3).every((c) => c.directoryPath));

    state.cache = [];
    const market = L.getCurrentMarketContext();
    assert.equal(market.price, 1.0);

    L.saveLegionState();
    const clean = L.getCleanLegionState();
    assert.equal(clean.positive.voters.length + clean.negative.voters.length, fresh.flat(3).length);
    assert.ok(['id', 'tier', 'signalSpeed', 'params', 'price', 'stats', 'memory'].every((k) => k in clean.positive.voters[0]));
});
