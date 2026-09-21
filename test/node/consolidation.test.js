// Node mirror of test/browser/entries/consolidation.test.js.
//
// `consolidation_logic.js` is pure (no shims needed), so unlike the other node
// mirrors this one tests the exact module the worker imports rather than a
// re-implementation. Run with `npm test`.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    computeGaussianDistance,
    computeContentHash,
    decayAndSortMemories,
    mergeMemories,
    collectPromotions,
    buildHierarchy
} from '../../src/consolidation_logic.js';

function mem(id, mean, variance, over = {}) {
    return {
        protoId: id,
        mean: mean.slice(),
        variance: variance.slice(),
        size: 1, accessCount: 1, importance: 1,
        hash: 'h_' + id, lastAccessed: 0, usageCount: 1, merged_count: 1,
        ...over
    };
}

const clone = (arr) => arr.map((m) => ({ ...m, mean: m.mean.slice(), variance: m.variance.slice() }));

test('computeGaussianDistance: properties', () => {
    assert.equal(computeGaussianDistance([1, 2], [0.3, 0.4], [1, 2], [0.3, 0.4]), 0);
    const ab = computeGaussianDistance([0, 0], [1, 1], [2, 3], [0.5, 0.7]);
    assert.equal(ab, computeGaussianDistance([2, 3], [0.5, 0.7], [0, 0], [1, 1]));
    assert.ok(ab > 0);
    assert.equal(computeGaussianDistance([1], [1], [1, 2], [1, 2]), Infinity);
    assert.equal(computeGaussianDistance([], [], [], []), Infinity);
    assert.ok(computeGaussianDistance([0, 0], [1, 1], [0.5, 0.5], [1, 1]) < ab);
});

test('computeContentHash: format, determinism, sensitivity', () => {
    const h = computeContentHash([1, 2, 3, 4]);
    assert.match(h, /^[0-9a-f]{8}$/);
    assert.equal(computeContentHash([1, 2, 3, 4]), h);
    assert.notEqual(computeContentHash([1, 2, 3, 5]), h);
});

test('decayAndSortMemories: delta 0 leaves values untouched', () => {
    const m = [mem('a', [0], [1], { size: 10, importance: 3, lastAccessed: 7 })];
    decayAndSortMemories(m, { decayFactor: 0.5, memoryDecayFloor: 0, currentBatch: 7 });
    assert.equal(m[0].size, 10);
    assert.equal(m[0].importance, 3);
});

test('decayAndSortMemories: decays by factor^delta, with floor', () => {
    const noFloor = [mem('a', [0], [1], { size: 10, accessCount: 8, importance: 4, lastAccessed: 0 })];
    decayAndSortMemories(noFloor, { decayFactor: 0.5, memoryDecayFloor: 0, currentBatch: 10 });
    const factor = Math.pow(0.5, 10);
    assert.equal(noFloor[0].size, 10 * factor);
    assert.equal(noFloor[0].accessCount, 8 * factor);
    assert.equal(noFloor[0].importance, 4 * factor);

    const floored = [mem('a', [0], [1], { size: 10, importance: 4, lastAccessed: 0 })];
    decayAndSortMemories(floored, { decayFactor: 0.5, memoryDecayFloor: 1, currentBatch: 10 });
    assert.equal(floored[0].size, 1);
    assert.equal(floored[0].importance, 1);
});

test('decayAndSortMemories: sorts by importance desc then size desc', () => {
    const m = [
        mem('a', [0], [1], { importance: 1, size: 5, lastAccessed: 20 }),
        mem('b', [0], [1], { importance: 3, size: 1, lastAccessed: 20 }),
        mem('c', [0], [1], { importance: 3, size: 9, lastAccessed: 20 }),
    ];
    decayAndSortMemories(m, { decayFactor: 1, memoryDecayFloor: 0, currentBatch: 20 });
    assert.deepEqual(m.map((x) => x.protoId), ['c', 'b', 'a']);
});

test('mergeMemories: size-weighted merge of overlapping memories', () => {
    const mems = [
        mem('a', [0, 0], [1, 1], { size: 1, accessCount: 2, importance: 10, usageCount: 3, merged_count: 1 }),
        mem('b', [0, 0], [1, 1], { size: 1, accessCount: 4, importance: 8, usageCount: 5, merged_count: 2 }),
    ];
    const res = mergeMemories(mems, { threshold: 100, currentBatch: 5 });
    assert.equal(mems.length, 1);
    assert.deepEqual(res.deletes, ['b']);
    assert.equal(res.updates.length, 1);
    const u = res.updates[0];
    assert.equal(u.protoId, 'a');
    assert.equal(u.size, 2);
    assert.equal(u.importance, 9);
    assert.equal(u.accessCount, 3);
    assert.equal(u.usageCount, 8);
    assert.equal(u.merged_count, 3);
    assert.equal(u.lastAccessed, 5);
    assert.equal(u.hash, computeContentHash(u.mean));
    assert.deepEqual(u.mean, [0, 0]);
});

test('mergeMemories: no merge beyond the threshold', () => {
    const mems = [
        mem('a', [0, 0], [0.01, 0.01], { importance: 2 }),
        mem('b', [100, 100], [0.01, 0.01], { importance: 1 }),
    ];
    const res = mergeMemories(mems, { threshold: 0.02, currentBatch: 5 });
    assert.equal(mems.length, 2);
    assert.equal(res.updates.length, 0);
    assert.equal(res.deletes.length, 0);
});

test('mergeMemories: greedy chain collapse', () => {
    const mems = [
        mem('a', [0], [1], { size: 1, importance: 5 }),
        mem('b', [0], [1], { size: 1, importance: 4 }),
        mem('c', [0], [1], { size: 1, importance: 3 }),
    ];
    const res = mergeMemories(mems, { threshold: 100, currentBatch: 1 });
    assert.equal(mems.length, 1);
    assert.deepEqual(res.deletes, ['b', 'c']);
    assert.equal(res.updates.length, 2);
});

test('collectPromotions: threshold, fields, no mutation', () => {
    const mems = [
        mem('a', [0], [1], { merged_count: 5 }),
        mem('b', [0], [1], { merged_count: 4 }),
        mem('c', [0], [1], { merged_count: 25 }),
    ];
    const snapshot = clone(mems);
    const res = collectPromotions(mems, 5, 42);
    assert.deepEqual(res.promotes.map((p) => p.protoId), ['a', 'c']);
    assert.deepEqual(res.deletes, ['a', 'c']);
    assert.ok(res.promotes.every((p) => p.lastAccessed === 42));
    assert.ok(res.promotes.every((p) => p.hash === computeContentHash(p.mean)));
    assert.deepEqual(mems, snapshot);
    assert.deepEqual(collectPromotions([mem('z', [0], [1], { merged_count: 2 })], 5, 1), { promotes: [], deletes: [] });
});

test('buildHierarchy: singleton yields nothing', () => {
    assert.deepEqual(buildHierarchy([mem('a', [0], [1])], {
        memType: 'core', polarity: 'positive', decayFactor: 1, memoryDecayFloor: 0,
        currentBatch: 0, maxHierarchyProtos: 10, minNeighbors: 1, maxNeighbors: 2
    }), { deletes: [], inserts: [] });
});

test('buildHierarchy: nearest-neighbour edges, bilateral + conflict-safe duplicates', () => {
    const protos = [
        mem('a', [0], [1], { importance: 3 }),
        mem('b', [0.1], [1], { importance: 2 }),
        mem('c', [0.25], [1], { importance: 1 }),
    ];
    const opts = {
        memType: 'volatile', polarity: 'negative', decayFactor: 1, memoryDecayFloor: 0,
        currentBatch: 0, maxHierarchyProtos: 10, minNeighbors: 1, maxNeighbors: 1
    };
    const snapshot = clone(protos);
    const res = buildHierarchy(protos, opts);
    assert.deepEqual(res.deletes.map((d) => d.protoId).sort(), ['a', 'b', 'c']);
    assert.ok(res.deletes.every((d) => d.source === 'volatile' && d.polarity === 'negative'));

    const childrenOfA = [...new Set(res.inserts.filter((e) => e.parent_proto === 'a').map((e) => e.child_proto))];
    assert.deepEqual(childrenOfA, ['b']);

    // every edge has its reverse with an identical distance
    const key = (e) => `${e.parent_proto}>${e.child_proto}`;
    const byKey = new Map(res.inserts.map((e) => [key(e), e]));
    for (const e of res.inserts) {
        const rev = byKey.get(`${e.child_proto}>${e.parent_proto}`);
        assert.ok(rev);
        assert.equal(rev.accum_distance, e.accum_distance);
    }

    // mutual neighbours emit the same directed edge twice (DB insert is
    // ON CONFLICT DO NOTHING)
    assert.equal(res.inserts.filter((e) => e.parent_proto === 'a' && e.child_proto === 'b').length, 2);
    assert.equal(res.inserts.filter((e) => e.parent_proto === 'b' && e.child_proto === 'a').length, 2);

    assert.deepEqual(protos, snapshot); // decayFactor 1 / currentBatch 0 -> unchanged
});

test('buildHierarchy: decay is applied in place', () => {
    const protos = [mem('a', [0], [1], { lastAccessed: 0, size: 4, importance: 8 })];
    buildHierarchy(protos, {
        memType: 'core', polarity: 'positive', decayFactor: 0.5, memoryDecayFloor: 0,
        currentBatch: 4, maxHierarchyProtos: 10, minNeighbors: 1, maxNeighbors: 1
    });
    assert.equal(protos[0].size, 4 * Math.pow(0.5, 4));
    assert.equal(protos[0].importance, 8 * Math.pow(0.5, 4));
});

test('buildHierarchy: maxHierarchyProtos keeps the most important', () => {
    const protos = [];
    for (let i = 0; i < 12; i++) protos.push(mem('p' + i, [i * 0.01], [1], { importance: 12 - i }));
    const res = buildHierarchy(clone(protos), {
        memType: 'core', polarity: 'positive', decayFactor: 1, memoryDecayFloor: 0,
        currentBatch: 0, maxHierarchyProtos: 5, minNeighbors: 1, maxNeighbors: 4
    });
    assert.deepEqual([...new Set(res.deletes.map((d) => d.protoId))].sort(),
        ['p0', 'p1', 'p2', 'p3', 'p4']);
});
