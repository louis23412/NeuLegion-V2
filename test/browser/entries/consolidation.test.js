// Consolidation-logic suite for NeuLegion, executed inside a browser Worker via
// test/browser/harness.js.
//
// `consolidation_worker.js` holds the core "hivemind" memory lifecycle (decay,
// pairwise merge, promotion to the core bank, and the prototype proximity
// graph). It used to be un-testable because it ran entirely inside a worker
// behind a database connection, so its pure algorithms were extracted verbatim
// into `src/consolidation_logic.js` (differentially verified against the
// original inline copies). This suite pins their contract.
//
// Note: `buildHierarchy` deliberately MUTATES the prototypes it is given (it
// applies the decay step in place) — the checks below assert that explicitly so
// a future change to copy-vs-mutate is a conscious decision.

import {
    computeGaussianDistance,
    computeContentHash,
    decayAndSortMemories,
    mergeMemories,
    collectPromotions,
    buildHierarchy
} from '../../../src/consolidation_logic.js';

function deepEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return false;
    if (typeof a === 'number' || typeof b === 'number') return Object.is(a, b);
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
        return true;
    }
    if (typeof a !== 'object') return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
    return true;
}

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

// Independent specification of buildHierarchy's edge emission: each prototype
// connects to its `k` nearest others (k linearly interpolated from maxNeighbors
// down to minNeighbors over the ranked list), and every chosen pair emits both
// directions. Used to pin the full directed-edge multiset.
function referenceEdges(protos, { minNeighbors, maxNeighbors, source, polarity }) {
    const n = protos.length;
    const inserts = [];
    for (let i = 0; i < n; i++) {
        const fraction = n <= 1 ? 0 : i / (n - 1);
        const k = Math.max(1, Math.round(minNeighbors + (maxNeighbors - minNeighbors) * (1 - fraction)));
        const candidates = [];
        for (let j = 0; j < n; j++) {
            if (i === j) continue;
            candidates.push({
                neighborId: protos[j].protoId,
                dist: computeGaussianDistance(protos[i].mean, protos[i].variance, protos[j].mean, protos[j].variance)
            });
        }
        candidates.sort((a, b) => a.dist - b.dist);
        const actualNum = Math.min(k, candidates.length);
        for (let t = 0; t < actualNum; t++) {
            inserts.push({ source, polarity, parent_proto: protos[i].protoId, child_proto: candidates[t].neighborId, accum_distance: candidates[t].dist });
            inserts.push({ source, polarity, parent_proto: candidates[t].neighborId, child_proto: protos[i].protoId, accum_distance: candidates[t].dist });
        }
    }
    return inserts;
}

const edgeKey = (e) => `${e.source}:${e.polarity}:${e.parent_proto}>${e.child_proto}`;

export async function run() {
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    // ---------- computeGaussianDistance ----------
    check('distance of identical gaussians is 0',
        Object.is(computeGaussianDistance([1, 2], [0.3, 0.4], [1, 2], [0.3, 0.4]), 0),
        String(computeGaussianDistance([1, 2], [0.3, 0.4], [1, 2], [0.3, 0.4])));
    const dAB = computeGaussianDistance([0, 0], [1, 1], [2, 3], [0.5, 0.7]);
    const dBA = computeGaussianDistance([2, 3], [0.5, 0.7], [0, 0], [1, 1]);
    check('distance is symmetric', Object.is(dAB, dBA), `${dAB} vs ${dBA}`);
    check('distance is positive for distinct gaussians', dAB > 0, String(dAB));
    check('length mismatch -> Infinity', computeGaussianDistance([1], [1], [1, 2], [1, 2]) === Infinity);
    check('empty vectors -> Infinity', computeGaussianDistance([], [], [], []) === Infinity);
    // A farther mean must not be closer.
    const near = computeGaussianDistance([0, 0], [1, 1], [0.5, 0.5], [1, 1]);
    check('closer mean yields smaller distance', near < dAB, `${near} < ${dAB}`);

    // ---------- computeContentHash ----------
    const h = computeContentHash([1, 2, 3, 4]);
    check('hash is 8-char lowercase hex', /^[0-9a-f]{8}$/.test(h), h);
    check('hash is deterministic', computeContentHash([1, 2, 3, 4]) === h);
    check('hash differs for different content', computeContentHash([1, 2, 3, 5]) !== h);

    // ---------- decayAndSortMemories ----------
    {
        const noAge = [mem('a', [0], [1], { size: 10, importance: 3, lastAccessed: 7 })];
        decayAndSortMemories(noAge, { decayFactor: 0.5, memoryDecayFloor: 0, currentBatch: 7 });
        check('delta 0 leaves values untouched', Object.is(noAge[0].size, 10) && Object.is(noAge[0].importance, 3),
            JSON.stringify({ s: noAge[0].size, i: noAge[0].importance }));

        const aged = [mem('a', [0], [1], { size: 10, accessCount: 8, importance: 4, lastAccessed: 0 })];
        decayAndSortMemories(aged, { decayFactor: 0.5, memoryDecayFloor: 0, currentBatch: 10 });
        const m = Math.pow(0.5, 10);
        check('age decays by factor^delta (no floor)',
            Object.is(aged[0].size, 10 * m) && Object.is(aged[0].accessCount, 8 * m) && Object.is(aged[0].importance, 4 * m),
            JSON.stringify({ size: aged[0].size, expected: 10 * m }));

        const floored = [mem('a', [0], [1], { size: 10, importance: 4, lastAccessed: 0 })];
        decayAndSortMemories(floored, { decayFactor: 0.5, memoryDecayFloor: 1, currentBatch: 10 });
        check('floor clamps decayed values', Object.is(floored[0].size, 1) && Object.is(floored[0].importance, 1),
            JSON.stringify({ size: floored[0].size, importance: floored[0].importance }));

        const order = [
            mem('a', [0], [1], { importance: 1, size: 5, lastAccessed: 20 }),
            mem('b', [0], [1], { importance: 3, size: 1, lastAccessed: 20 }),
            mem('c', [0], [1], { importance: 3, size: 9, lastAccessed: 20 }),
        ];
        decayAndSortMemories(order, { decayFactor: 1, memoryDecayFloor: 0, currentBatch: 20 });
        check('sorts by importance desc, then size desc',
            order.map((x) => x.protoId).join(',') === 'c,b,a', order.map((x) => x.protoId).join(','));
    }

    // ---------- mergeMemories ----------
    {
        // Two overlapping memories with high threshold -> one weighted-average merge.
        const mems = [
            mem('a', [0, 0], [1, 1], { size: 1, accessCount: 2, importance: 10, usageCount: 3, merged_count: 1 }),
            mem('b', [0, 0], [1, 1], { size: 1, accessCount: 4, importance: 8, usageCount: 5, merged_count: 2 }),
        ];
        const res = mergeMemories(mems, { threshold: 100, currentBatch: 5 });
        check('merge removes the absorbed memory', mems.length === 1, `len=${mems.length}`);
        check('merge deletes the source', deepEqual(res.deletes, ['b']), JSON.stringify(res.deletes));
        check('merge emits one update for the target', res.updates.length === 1 && res.updates[0].protoId === 'a',
            JSON.stringify(res.updates.map((u) => u.protoId)));
        const u = res.updates[0];
        check('merge size is the summed size', Object.is(u.size, 2), String(u.size));
        check('merge importance is size-weighted', Object.is(u.importance, 9), String(u.importance));
        check('merge accessCount is size-weighted', Object.is(u.accessCount, 3), String(u.accessCount));
        check('merge usageCount is summed', Object.is(u.usageCount, 8), String(u.usageCount));
        check('merge merged_count is summed', Object.is(u.merged_count, 3), String(u.merged_count));
        check('merge lastAccessed is raised to currentBatch', Object.is(u.lastAccessed, 5), String(u.lastAccessed));
        check('merge hash matches content hash', u.hash === computeContentHash(u.mean), `${u.hash}`);
        check('merge target mean is the weighted mean', deepEqual(mems[0].mean, [0, 0]), JSON.stringify(mems[0].mean));
        check('merge emits the target snapshot from mems', res.updates[0].mean === mems[0].mean && res.updates[0].mean !== res.updates[0].variance);
    }

    {
        // Distinct memories with a tight threshold -> no merge.
        const mems = [
            mem('a', [0, 0], [0.01, 0.01], { importance: 2 }),
            mem('b', [100, 100], [0.01, 0.01], { importance: 1 }),
        ];
        const res = mergeMemories(mems, { threshold: 0.02, currentBatch: 5 });
        check('no merge when distance exceeds threshold',
            mems.length === 2 && res.updates.length === 0 && res.deletes.length === 0,
            `len=${mems.length} u=${res.updates.length}`);
    }

    {
        // Chain: a absorbs b, then the updated a absorbs c (order-sensitive greedy).
        const mems = [
            mem('a', [0], [1], { size: 1, importance: 5 }),
            mem('b', [0], [1], { size: 1, importance: 4 }),
            mem('c', [0], [1], { size: 1, importance: 3 }),
        ];
        const res = mergeMemories(mems, { threshold: 100, currentBatch: 1 });
        check('chain merge collapses all overlapping memories',
            mems.length === 1 && res.deletes.length === 2 && deepEqual(res.deletes, ['b', 'c']),
            `len=${mems.length} del=${JSON.stringify(res.deletes)}`);
        check('chain merge emits an update per absorbed memory', res.updates.length === 2,
            `updates=${res.updates.length}`);
    }

    {
        // mergeMemories must not mutate the input for non-overlapping inputs.
        const mems = [mem('a', [0], [1], { importance: 2 }), mem('b', [50], [0.001], { importance: 1 })];
        const before = JSON.parse(JSON.stringify(mems));
        mergeMemories(mems, { threshold: 0.001, currentBatch: 3 });
        check('no-merge path mutates nothing', deepEqual(mems, before));
    }

    // ---------- collectPromotions ----------
    {
        const mems = [
            mem('a', [0], [1], { merged_count: 5 }),
            mem('b', [0], [1], { merged_count: 4 }),
            mem('c', [0], [1], { merged_count: 25 }),
        ];
        const snapshot = JSON.parse(JSON.stringify(mems));
        const res = collectPromotions(mems, 5, 42);
        check('promotes only memories at/above the threshold',
            deepEqual(res.promotes.map((p) => p.protoId), ['a', 'c']),
            JSON.stringify(res.promotes.map((p) => p.protoId)));
        check('promotion deletes mirror the promoted ids',
            deepEqual(res.deletes, ['a', 'c']), JSON.stringify(res.deletes));
        check('promotion stamps lastAccessed with currentBatch',
            res.promotes.every((p) => Object.is(p.lastAccessed, 42)));
        check('promotion hashes the mean', res.promotes.every((p) => p.hash === computeContentHash(p.mean)));
        check('collectPromotions does not mutate the memories', deepEqual(mems, snapshot));
        check('no promotions below threshold -> empty', deepEqual(collectPromotions([mem('z', [0], [1], { merged_count: 2 })], 5, 1), { promotes: [], deletes: [] }));
    }

    // ---------- buildHierarchy ----------
    {
        check('singleton -> no hierarchy', deepEqual(buildHierarchy([mem('a', [0], [1])], {
            memType: 'core', polarity: 'positive', decayFactor: 1, memoryDecayFloor: 0,
            currentBatch: 0, maxHierarchyProtos: 10, minNeighbors: 1, maxNeighbors: 2
        }), { deletes: [], inserts: [] }));
    }

    {
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
        check('hierarchy deletes every kept prototype',
            deepEqual(res.deletes.map((d) => d.protoId).sort(), ['a', 'b', 'c']),
            JSON.stringify(res.deletes.map((d) => d.protoId)));
        check('hierarchy tags source and polarity',
            res.deletes.every((d) => d.source === 'volatile' && d.polarity === 'negative'));
        const outA = [...new Set(res.inserts.filter((e) => e.parent_proto === 'a').map((e) => e.child_proto))].sort();
        check('nearest neighbour of a (and a is nearest to b)', deepEqual(outA, ['b']), JSON.stringify(outA));
        // Each pair emits BOTH directions, so a mutual nearest-neighbour pair
        // yields the same (parent, child) row twice. The production insert is
        // `ON CONFLICT(...) DO NOTHING`, so this is safe — but it is pinned here
        // so a future change to the emission (or the schema) is deliberate.
        const abCount = res.inserts.filter((e) => e.parent_proto === 'a' && e.child_proto === 'b').length;
        const baCount = res.inserts.filter((e) => e.parent_proto === 'b' && e.child_proto === 'a').length;
        check('mutual neighbours emit a duplicated (but conflict-safe) directed edge',
            abCount === 2 && baCount === 2, `a>b=${abCount} b>a=${baCount}`);
        // every inserted edge has its reverse with the same distance
        const key = (e) => `${e.parent_proto}>${e.child_proto}`;
        const byKey = new Map(res.inserts.map((e) => [key(e), e]));
        check('hierarchy edges are symmetric with equal distance',
            res.inserts.every((e) => {
                const rev = byKey.get(`${e.child_proto}>${e.parent_proto}`);
                return rev && Object.is(rev.accum_distance, e.accum_distance);
            }),
            JSON.stringify(res.inserts.map((e) => [key(e), e.accum_distance])));
        check('hierarchy edge distance matches computeGaussianDistance',
            res.inserts.every((e) => {
                const p = snapshot.find((x) => x.protoId === e.parent_proto);
                const c = snapshot.find((x) => x.protoId === e.child_proto);
                return Object.is(e.accum_distance, computeGaussianDistance(p.mean, p.variance, c.mean, c.variance));
            }));

        // determinism (and that it mutates via decay) on a fresh clone
        const again = clone(protos);
        const res2 = buildHierarchy(again, opts);
        check('hierarchy is deterministic', deepEqual(res, res2));
        check('hierarchy applies decay in place (mutates input size/importance)',
            // decayFactor 1 + currentBatch 0 -> lastAccessed 0 -> delta 0 -> unchanged
            deepEqual(protos, snapshot));

        const decayed = clone(protos).map((p) => ({ ...p, lastAccessed: 0, size: 4, importance: 8 }));
        buildHierarchy(decayed, { ...opts, decayFactor: 0.5, currentBatch: 4, memoryDecayFloor: 0 });
        check('hierarchy decay mutates the input prototypes',
            Object.is(decayed[0].size, 4 * Math.pow(0.5, 4)) && Object.is(decayed[0].importance, 8 * Math.pow(0.5, 4)),
            JSON.stringify({ size: decayed[0].size, importance: decayed[0].importance }));
    }

    {
        // Neighbour budget decreases from max to min across the ranked list.
        // Compare the FULL directed-edge multiset against an independent
        // specification (this also pins the bilateral duplicate emission).
        const protos = [];
        for (let i = 0; i < 12; i++) protos.push(mem('p' + i, [i * 0.01], [1], { importance: 12 - i }));
        const cfg = {
            memType: 'core', polarity: 'positive', decayFactor: 1, memoryDecayFloor: 0,
            currentBatch: 0, maxHierarchyProtos: 12, minNeighbors: 1, maxNeighbors: 6
        };
        const res = buildHierarchy(clone(protos), cfg);
        const expectedEdges = referenceEdges(protos, { ...cfg, source: 'core', polarity: 'positive' });
        const got = res.inserts.map((e) => `${edgeKey(e)}=${e.accum_distance}`).sort();
        const want = expectedEdges.map((e) => `${edgeKey(e)}=${e.accum_distance}`).sort();
        check('hierarchy emits exactly the expected directed edges + distances', deepEqual(got, want),
            got.length === want.length ? 'content differs' : `got ${got.length} want ${want.length}`);
        check('hierarchy insert count is twice the chosen-neighbour count',
            res.inserts.length === 2 * protos.reduce((s, _, i) => s + Math.max(1, Math.round(1 + 5 * (1 - i / 11))), 0),
            `inserts=${res.inserts.length}`);

        const capped = buildHierarchy(clone(protos), {
            memType: 'core', polarity: 'positive', decayFactor: 1, memoryDecayFloor: 0,
            currentBatch: 0, maxHierarchyProtos: 5, minNeighbors: 1, maxNeighbors: 4
        });
        const keptIds = new Set(capped.deletes.map((d) => d.protoId));
        check('maxHierarchyProtos keeps only the most important',
            deepEqual([...keptIds].sort(), ['p0', 'p1', 'p2', 'p3', 'p4']), JSON.stringify([...keptIds].sort()));
    }

    return { total: checks.length, failed: checks.filter((c) => !c.pass).length, failures: checks.filter((c) => !c.pass), checks };
}
