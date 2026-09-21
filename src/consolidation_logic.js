// Pure consolidation algorithms shared by `consolidation_worker.js` and its
// tests. These operate on already-decoded prototype records (plain number
// arrays for `mean`/`variance`), so they can be exercised without a database or
// a worker thread.
//
// This module was extracted verbatim from the worker. The worker used to hold
// two near-identical copies of the pairwise-merge loop (volatile and core); it
// now calls `mergeMemories` for both. Extraction is behaviour-preserving and is
// covered by a differential test against the original inline copies (see
// `test/browser/entries/consolidation.test.js`).

export const computeGaussianDistance = (mu1, var1, mu2, var2) => {
    const d = mu1.length;
    if (d !== mu2.length || d === 0) return Infinity;

    const eps = 1e-8;
    let mahalTerm = 0;
    let logDetTerm = 0;

    for (let j = 0; j < d; j++) {
        const v1 = Math.max(var1[j], eps);
        const v2 = Math.max(var2[j], eps);
        const avgV = (v1 + v2) / 2;
        const dm = mu1[j] - mu2[j];

        mahalTerm += (dm * dm) / avgV;
        logDetTerm += Math.log(avgV / Math.sqrt(v1 * v2));
    }

    return (1 / 8) * mahalTerm + (1 / 2) * logDetTerm;
};

export const computeContentHash = (mean) => {
    let hash = 2166136261;
    for (let i = 0; i < mean.length; i++) {
        let iv = Math.floor(mean[i] * 10000 + 0.5);
        hash ^= iv;
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return ((hash >>> 0) % 0xFFFFFFFF).toString(16).padStart(8, '0');
};

// Decays size/accessCount/importance of each memory by its age (in batches),
// then orders them by descending importance (ties broken by size). Mutates the
// records in place; returns the same array for convenience.
export function decayAndSortMemories (mems, { decayFactor, memoryDecayFloor, currentBatch }) {
    for (const mem of mems) {
        const delta = currentBatch - mem.lastAccessed;
        if (delta > 0) {
            const multiplier = Math.pow(decayFactor, delta);
            mem.size = Math.max(memoryDecayFloor, mem.size * multiplier);
            mem.accessCount = Math.max(memoryDecayFloor, mem.accessCount * multiplier);
            mem.importance = Math.max(memoryDecayFloor, mem.importance * multiplier);
        }
    }

    mems.sort((a, b) => b.importance - a.importance || b.size - a.size);
    return mems;
}

// Greedy pairwise merge: walking the (decayed, sorted) memories in order, each
// surviving `mems[i]` absorbs every later memory within `threshold`, weighted by
// size. Mutates `mems` in place, removing absorbed entries, and returns the
// update/delete records for persistence.
export function mergeMemories (mems, { threshold, currentBatch }) {
    const updates = [];
    const deletes = [];

    let i = 0;
    while (i < mems.length - 1) {
        let j = i + 1;
        while (j < mems.length) {
            const dist = computeGaussianDistance(mems[i].mean, mems[i].variance, mems[j].mean, mems[j].variance);
            if (dist < threshold) {
                const target = mems[i];
                const source = mems[j];
                const s1 = target.size;
                const s2 = source.size;
                const totalSize = s1 + s2;

                const newMean = target.mean.map((m, k) => (s1 * m + s2 * source.mean[k]) / totalSize);
                const newVariance = target.mean.map((_, k) => {
                    const dm1 = target.mean[k] - newMean[k];
                    const dm2 = source.mean[k] - newMean[k];
                    return (s1 * (target.variance[k] + dm1 * dm1) + s2 * (source.variance[k] + dm2 * dm2)) / totalSize;
                }).map(v => Math.max(v, 1e-8));

                target.mean = newMean;
                target.variance = newVariance;
                target.size = totalSize;
                target.accessCount = (s1 * target.accessCount + s2 * source.accessCount) / totalSize;
                target.importance = (s1 * target.importance + s2 * source.importance) / totalSize;
                target.usageCount += source.usageCount;
                target.merged_count += source.merged_count;
                target.lastAccessed = Math.max(target.lastAccessed, source.lastAccessed, currentBatch);
                target.hash = computeContentHash(newMean);

                updates.push({
                    protoId: target.protoId,
                    mean: target.mean,
                    variance: target.variance,
                    size: target.size,
                    accessCount: target.accessCount,
                    importance: target.importance,
                    hash: target.hash,
                    lastAccessed: target.lastAccessed,
                    usageCount: target.usageCount,
                    merged_count: target.merged_count
                });

                deletes.push(source.protoId);
                mems.splice(j, 1);
            } else {
                j++;
            }
        }
        i++;
    }

    return { updates, deletes };
}

// After merging, any memory that has absorbed `>= promoteCount` others is
// promoted (the caller moves it to the core bank). Read-only over `mems`.
export function collectPromotions (mems, promoteCount, currentBatch) {
    const promotes = [];
    const deletes = [];

    for (const mem of mems) {
        if (mem.merged_count >= promoteCount) {
            const promoteHash = computeContentHash(mem.mean);
            promotes.push({
                protoId: mem.protoId,
                mean: mem.mean,
                variance: mem.variance,
                size: mem.size,
                accessCount: mem.accessCount,
                importance: mem.importance,
                hash: promoteHash,
                lastAccessed: currentBatch,
                usageCount: mem.usageCount,
                merged_count: mem.merged_count
            });
            deletes.push(mem.protoId);
        }
    }

    return { promotes, deletes };
}

// Builds the prototype proximity graph: decay + rank the prototypes, keep the
// top `maxHierarchyProtos`, and connect each to its nearest `numNeighbors`
// (a linearly-decreasing budget from `maxNeighbors` down to `minNeighbors`).
// Each neighbour pair yields edges in both directions. Returns the delete/insert
// records for the `proto_edges` table.
export function buildHierarchy (protos, {
    memType,
    polarity,
    decayFactor,
    memoryDecayFloor,
    currentBatch,
    maxHierarchyProtos,
    minNeighbors,
    maxNeighbors
}) {
    protos.forEach(p => {
        const delta = currentBatch - p.lastAccessed;
        if (delta > 0) {
            const mult = Math.pow(decayFactor, delta);
            p.size = Math.max(memoryDecayFloor, p.size * mult);
            p.accessCount = Math.max(memoryDecayFloor, p.accessCount * mult);
            p.importance = Math.max(memoryDecayFloor, p.importance * mult);
        }
    });

    protos.sort((a, b) =>
        b.importance - a.importance ||
        b.size - a.size ||
        b.accessCount - a.accessCount ||
        b.lastAccessed - a.lastAccessed
    );

    const limitedProtos = protos.slice(0, maxHierarchyProtos);
    if (limitedProtos.length < 2) return { deletes: [], inserts: [] };

    const n = limitedProtos.length;
    const deletes = [];
    const inserts = [];

    for (const p of limitedProtos) {
        deletes.push({ source: memType, polarity, protoId: p.protoId });
    }

    for (let i = 0; i < n; i++) {
        const proto = limitedProtos[i];
        const fraction = n <= 1 ? 0 : i / (n - 1);
        let numNeighbors = Math.round(minNeighbors + (maxNeighbors - minNeighbors) * (1 - fraction));
        numNeighbors = Math.max(1, numNeighbors);

        const candidates = [];
        for (let j = 0; j < n; j++) {
            if (i === j) continue;
            const other = limitedProtos[j];
            const dist = computeGaussianDistance(proto.mean, proto.variance, other.mean, other.variance);
            candidates.push({ neighborId: other.protoId, dist });
        }

        candidates.sort((a, b) => a.dist - b.dist);

        const actualNum = Math.min(numNeighbors, candidates.length);
        for (let k = 0; k < actualNum; k++) {
            const { neighborId, dist } = candidates[k];
            inserts.push({
                source: memType,
                polarity,
                parent_proto: proto.protoId,
                child_proto: neighborId,
                accum_distance: dist
            });
            inserts.push({
                source: memType,
                polarity,
                parent_proto: neighborId,
                child_proto: proto.protoId,
                accum_distance: dist
            });
        }
    }

    return { deletes, inserts };
}
