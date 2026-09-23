// HiveMind component: lsh
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
//
// The additions over the original: `_getGlobalLSHCandidates` can probe in
// margin order (memory/multiprobe.js, Lv et al. VLDB 2007) when
// `this._multiProbeConfig` is set, and `_refreshLshHyperplanes` can replace the
// data-independent random hyperplanes with data-aware principal components
// (memory/binarypc.js, BinaryPC arXiv 2608.04405) when `this._pcaHashConfig` is
// set — including a data-driven aligned rank via `rankPolicy`
// (memory/bitweight.js, the exact bit-flip law). Both configs are null by
// default, and every disabled branch is byte-identical to the original, so the
// golden fingerprints are unchanged.
//
// A third, also-default-off addition: when `this._queryModConfig` is set,
// `_getGlobalLSHCandidates` runs `rounds` dynamic-query-modification rounds
// (memory/querymod.js, arXiv 2605.23807) after the ordinary probe pass. Each
// round re-hashes the l2-normalised centroid of the closest candidates found so
// far in each set — a representative that provably collides with at least one
// member of the found neighbourhood on EVERY hyperplane — and probes its
// buckets, so a query that hashed to a sparse region still recovers its
// neighbourhood. With the flag null the extra work is skipped entirely and the
// probe results are identical.
import { multiProbeKeys } from './multiprobe.js';
import { alignedHashTables } from './binarypc.js';
import { modifiedQuery, resolveQueryModConfig } from './querymod.js';

export const lshMethods = {
    _computeContentHash (mean) {
        let hash = 2166136261;
        for (let i = 0; i < mean.length; i++) {
            let iv = Math.floor(mean[i] * 10000 + 0.5);
            hash ^= iv;
            hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
        }
        return ((hash >>> 0) % 0xFFFFFFFF).toString(16).padStart(8, '0');
    },

    _computeProjNorms (mean, force = false) {
        if (!force) {
            const cached = this._projCache.get(mean);
            if (cached !== undefined) return cached;
        }

        const projs = new Array(this._numProjections);
        const matArray = this._projectionMatrices;

        for (let np = 0; np < this._numProjections; np++) {
            const proj = new Float32Array(this._lowDim);
            const mat = matArray[np];
            for (let d = 0; d < this._hiddenSize; d++) {
                const val = mean[d];
                const row = mat[d];
                for (let l = 0; l < this._lowDim; l++) proj[l] += val * row[l];
            }
            let normSq = 0;
            for (let l = 0; l < this._lowDim; l++) normSq += proj[l] * proj[l];
            // Each projection is normalised to unit norm so _projSimilarity returns
            // a true average cosine in [-1, 1]. It previously carried an extra
            // 1/sqrt(lowDim) factor, which compressed every projection similarity
            // into [-1/lowDim, 1/lowDim] (e.g. [-0.25, 0.25] for lowDim 4) and made
            // all cosine-calibrated thresholds (0.35 filter, 0.7 merge) unreachable
            // — semantic recall was silently disabled. LSH uses only the sign of the
            // dot product and consolidation uses projection scores only for ranking,
            // so both are invariant to this positive rescaling.
            const norm = Math.sqrt(normSq) || 1;
            for (let l = 0; l < this._lowDim; l++) proj[l] = proj[l] / norm;
            projs[np] = proj;
        }

        this._projCache.set(mean, projs);
        return projs;
    },

    _invalidateProjCache (mean) {
        if (mean) this._projCache.delete(mean);
    },

    // Precomputed `1n << BigInt(b)` offset masks for the LSH hash keys. The
    // probe loops flip single bits on BigInt keys tens of thousands of times
    // per predict, and each flip used to allocate a throwaway BigInt; the
    // masks depend only on the (fixed) hash width, so build them once.
    _getLshBitMasks () {
        const bits = this._lshHashBits;
        if (this._lshBitMasks && this._lshBitMasks.length === bits) return this._lshBitMasks;
        const masks = new Array(bits);
        // Plain-number LSH keys are dramatically cheaper than BigInt keys in the
        // bucket maps and in the XOR probe loops that dominate retrieval (no
        // heap-allocated BigInt per flip, fast SMI hash in Map.get), so use
        // numbers whenever the hash width fits in 32 bits - which it does for
        // every real configuration. BigInt remains as a correctness fallback.
        const useNumber = bits > 0 && bits <= 32;
        if (useNumber) {
            for (let b = 0; b < bits; b++) masks[b] = 1 << b;
        } else {
            for (let b = 0; b < bits; b++) masks[b] = 1n << BigInt(b);
        }
        this._lshKeyIsNumber = useNumber;
        this._lshBitMasks = masks;
        return masks;
    },

    _computeLSHHashesLow (projNorm, hyperplanesSet) {
        const numTables = this._lshNumTables;
        const hashBits = this._lshHashBits;
        const lowDim = this._lowDim;
        const hashes = new Array(numTables);
        const bitMasks = this._getLshBitMasks();
        const useNumber = this._lshKeyIsNumber;
        for (let t = 0; t < numTables; t++) {
            let hash = useNumber ? 0 : 0n;
            for (let b = 0; b < hashBits; b++) {
                let dot = 0;
                const hyp = hyperplanesSet[t][b];
                for (let d = 0; d < lowDim; d++) {
                    dot += projNorm[d] * hyp[d];
                }
                if (dot > 0) {
                    hash |= bitMasks[b];
                }
            }
            hashes[t] = hash;
        }
        return hashes;
    },

    _insertProtoToLSH (transformerIdx, proto) {
        if (!proto || !proto.mean || !proto.projNorms || proto.projNorms.length < this._numLshSets) return;

        const buckets = this._semanticLSHBuckets[transformerIdx];
        const numLshSets = this._numLshSets;
        const numTables = this._lshNumTables;
        const hashesAll = [];

        for (let s = 0; s < numLshSets; s++) {
            const proj = proto.projNorms[s];
            const hashes = this._computeLSHHashesLow(proj, this._lshHyperplanes[s]);
            hashesAll.push(hashes);

            const setBuckets = buckets[s];
            for (let t = 0; t < numTables; t++) {
                const key = hashes[t];
                let bucket = setBuckets[t].get(key);
                if (!bucket) {
                    bucket = new Set();
                    setBuckets[t].set(key, bucket);
                }
                bucket.add(proto);
            }
        }
        proto.lshHashes = hashesAll;
    },

    _removeProtoFromLSH (transformerIdx, proto) {
        if (!proto || !proto.lshHashes) return;

        const buckets = this._semanticLSHBuckets[transformerIdx];
        const numLshSets = this._numLshSets;
        const numTables = this._lshNumTables;
        for (let s = 0; s < numLshSets; s++) {
            const hashes = proto.lshHashes[s];
            if (!hashes) continue;
            const setBuckets = buckets[s];
            for (let t = 0; t < numTables; t++) {
                const key = hashes[t];
                const bucket = setBuckets[t].get(key);
                if (bucket) {
                    bucket.delete(proto);
                    if (bucket.size === 0) {
                        setBuckets[t].delete(key);
                    }
                }
            }
        }
        proto.lshHashes = undefined;
    },

    _updateProtoInLSH (transformerIdx, proto) {
        this._removeProtoFromLSH(transformerIdx, proto);
        this._insertProtoToLSH(transformerIdx, proto);
    },

    // The BROADCAST-path candidate probe (R27-2): its only caller in the tree is
    // `broadcastMemory` (knowledge/transfer.js), whose result `getSignal` stores in
    // `_memoryBroadcast` for the signal payload only — nothing reads it back into
    // the model — so `_multiProbeConfig`/`_queryModConfig` cannot move a scored
    // position and the A/B reports them `not-applicable` (BUGS.md #44). The LIVE
    // retrieval reader is `_retrieveTopRelevantProtos` (memory/retrieval.js), which
    // probes the buckets directly and consults neither flag; `_refreshLshHyperplanes`
    // mutates the buckets that reader reads, so `pca-hash` IS live.
    _getGlobalLSHCandidates (queryMean, queryProjs, maxCandidates = 200) {
        if (!queryMean || !queryProjs || !queryProjs.length) return [];

        const globalCandidates = new Set();
        const targetPerEnsemble = Math.ceil(maxCandidates / Math.max(1, this._ensembleSize));

        for (let t = 0; t < this._ensembleSize; t++) {
            const semProtos = this._semanticProtos[t];
            if (!semProtos || semProtos.length === 0) continue;

            const semCandidates = new Set();
            // Dynamic query modification (arXiv 2605.23807) needs to know which
            // candidates were found via which set, so it can take that set's
            // centroid. Only allocated when the (default-off) flag is set.
            const queryMod = this._queryModConfig;
            const perSetFound = queryMod ? Array.from({ length: this._numLshSets }, () => new Set()) : null;

            const hashesPerSet = new Array(this._numLshSets);
            const lshQueryProjs = queryProjs.slice(0, this._numLshSets);
            for (let s = 0; s < this._numLshSets; s++) {
                hashesPerSet[s] = this._computeLSHHashesLow(lshQueryProjs[s], this._lshHyperplanes[s]);
            }

            const bitMasks = this._getLshBitMasks();
            const nearBits = Math.min(4, this._lshHashBits);
            const multiProbe = this._multiProbeConfig;
            for (let s = 0; s < this._numLshSets; s++) {
                const hashes = hashesPerSet[s];
                const tableArray = this._semanticLSHBuckets[t][s];
                const proj = lshQueryProjs[s];
                const foundSet = perSetFound ? perSetFound[s] : null;

                for (let tbl = 0; tbl < this._lshNumTables; tbl++) {
                    let key = hashes[tbl];

                    let bucket = tableArray[tbl].get(key);
                    if (bucket) for (const p of bucket) { semCandidates.add(p); if (foundSet) foundSet.add(p); }

                    if (multiProbe) {
                        // Margin-ordered multi-probe (Lv et al. 2007): probe the
                        // hyperplanes the query sits closest to first, in ascending
                        // |query·hyperplane| order. The exact key was already
                        // probed above, so merge only the perturbations (index 0
                        // of the returned sequence).
                        const hyperplanes = this._lshHyperplanes[s][tbl];
                        const lowDim = this._lowDim;
                        const dots = new Array(this._lshHashBits);
                        for (let b = 0; b < this._lshHashBits; b++) {
                            const hyp = hyperplanes[b];
                            let dot = 0;
                            for (let d = 0; d < lowDim; d++) dot += proj[d] * hyp[d];
                            dots[b] = dot;
                        }
                        const probes = multiProbeKeys(key, dots, bitMasks, multiProbe);
                        for (let i = 1; i < probes.length; i++) {
                            const marginBucket = tableArray[tbl].get(probes[i]);
                            if (marginBucket) for (const p of marginBucket) { semCandidates.add(p); if (foundSet) foundSet.add(p); }
                        }
                    } else {
                        for (let b = 0; b < nearBits; b++) {
                            const flipped = key ^ bitMasks[b];
                            bucket = tableArray[tbl].get(flipped);
                            if (bucket) for (const p of bucket) { semCandidates.add(p); if (foundSet) foundSet.add(p); }
                        }
                    }
                }
            }

            // Dynamic query modification (Claydon, Connor & Dearle, arXiv
            // 2605.23807). For each set, take the l2-normalised centroid of the
            // candidates just found through that set (closest `topK` to the
            // current query), re-hash it and probe its buckets — exact bucket
            // plus the same margin-ordered perturbations — unioning anything new.
            // The centroid provably collides with at least one member of the
            // found neighbourhood on every hyperplane, so a query whose own word
            // sat in a sparse region still re-enters its neighbourhood's buckets.
            // `rounds > 1` repeats the update with the grown candidate set.
            if (queryMod) {
                const cfg = resolveQueryModConfig(queryMod);
                for (let round = 0; round < cfg.rounds; round++) {
                    let changed = false;
                    for (let s = 0; s < this._numLshSets; s++) {
                        const foundSet = perSetFound[s];
                        if (foundSet.size === 0) continue;
                        const candProjs = [];
                        for (const p of foundSet) {
                            const v = p.projNorms && p.projNorms[s];
                            if (v && v.length === this._lowDim) candProjs.push(v);
                        }
                        const current = lshQueryProjs[s];
                        const modified = modifiedQuery(current, candProjs, cfg);
                        if (modified === current) continue;
                        changed = true;
                        lshQueryProjs[s] = modified;
                        const modifiedHashes = this._computeLSHHashesLow(modified, this._lshHyperplanes[s]);
                        const tableArray = this._semanticLSHBuckets[t][s];
                        for (let tbl = 0; tbl < this._lshNumTables; tbl++) {
                            const bucket = tableArray[tbl].get(modifiedHashes[tbl]);
                            if (bucket) for (const p of bucket) { semCandidates.add(p); foundSet.add(p); }
                        }
                        // The modified word is generally in an empty bucket at
                        // production width, so probe its low-margin neighbours too.
                        if (cfg.probeBudget > 0) {
                            for (let tbl = 0; tbl < this._lshNumTables; tbl++) {
                                const hyp = this._lshHyperplanes[s][tbl];
                                const dots = new Array(this._lshHashBits);
                                for (let b = 0; b < this._lshHashBits; b++) {
                                    const hv = hyp[b];
                                    let d = 0;
                                    for (let l = 0; l < this._lowDim; l++) d += modified[l] * hv[l];
                                    dots[b] = d;
                                }
                                const probes = multiProbeKeys(modifiedHashes[tbl], dots, bitMasks, {
                                    maxFlips: cfg.maxFlips, budget: cfg.probeBudget,
                                });
                                for (let i = 1; i < probes.length; i++) {
                                    const b2 = tableArray[tbl].get(probes[i]);
                                    if (b2) for (const p of b2) { semCandidates.add(p); foundSet.add(p); }
                                }
                            }
                        }
                    }
                    if (!changed) break;
                }
            }

            const prio = this._priorityIndices[t] || [];
            for (let i = 0; i < Math.min(8, prio.length); i++) {
                const idx = prio[i];
                if (idx < semProtos.length) semCandidates.add(semProtos[idx]);
            }

            let added = 0;
            for (const p of semCandidates) {
                if (added >= targetPerEnsemble) break;
                globalCandidates.add(p);
                added++;
            }
        }

        return Array.from(globalCandidates);
    },

    // Data-aware (PCA-aligned) hash refresh — BinaryPC, arXiv 2608.04405.
    //
    // Random-hyperplane SimHash spends a fixed bit budget on directions the data
    // barely varies in; the top principal components of the data minimise the
    // orthogonal-complement variance (Eckart-Young), so the same bits carry more
    // of the data's structure. `binarypc.test.js` proves the pure dominance; this
    // method learns those directions from the LIVE prototype projections and
    // rebuilds the whole bucket index under them.
    //
    // Opt-in and default-off: with `_pcaHashConfig === null` it returns false
    // immediately, so the hot path (and every golden fingerprint) is unchanged.
    // Set `_pcaHashConfig = { seed, iters, tol, minRows, rankPolicy }` to enable
    // — `seed` null uses Math.random, `iters`/`tol` default to the binarypc
    // values, `minRows` (default `lowDim + 1`) is how many stored projections a
    // set needs before it is retrained, and `rankPolicy` (null | 'above-mean' |
    // 'noise') lets the aligned rank come from the spectrum instead of the fixed
    // `dim/4` default (memory/bitweight.js). This is an explicit offline step —
    // call it once enough prototypes have accumulated — not part of the training
    // loop.
    //
    // When `_pcaHashConfig.rankPolicy` is set the aligned rank comes from the
    // spectrum instead of the fixed `dim/4` default (memory/bitweight.js);
    // `alignedHashTables` reports each direction's data variance as
    // `tableVariances`, which is what the theory needs to reason about bit
    // reliability.
    _refreshLshHyperplanes () {
        const cfg = this._pcaHashConfig;
        if (!cfg) return false;

        const numSets = this._numLshSets;
        const lowDim = this._lowDim;

        // Set s hashes projection matrix s (see _getGlobalLSHCandidates), so its
        // training data is every stored prototype's `projNorms[s]`.
        const rowsPerSet = Array.from({ length: numSets }, () => []);
        for (let t = 0; t < this._ensembleSize; t++) {
            const protos = this._semanticProtos[t];
            if (!protos || protos.length === 0) continue;
            for (const p of protos) {
                const projs = p && p.projNorms;
                if (!projs) continue;
                for (let s = 0; s < numSets; s++) {
                    const vec = projs[s];
                    if (vec && vec.length === lowDim) rowsPerSet[s].push(Array.from(vec));
                }
            }
        }

        const minRows = Number.isFinite(cfg.minRows) && cfg.minRows > 0
            ? Math.floor(cfg.minRows)
            : (lowDim + 1);
        const next = Array.from({ length: numSets }, (_, s) => this._lshHyperplanes[s]);
        const ranks = new Array(numSets).fill(null);
        let refreshed = 0;
        for (let s = 0; s < numSets; s++) {
            const rows = rowsPerSet[s];
            if (rows.length < minRows) continue;
            // Seed per set so the rotation is reproducible and the sets differ.
            const seed = Number.isFinite(cfg.seed) ? cfg.seed + s : cfg.seed;
            // Default the aligned rank to a moderate slice of the projection
            // dimension. Measuring the sweep in lsh.test.js section I, aligning
            // every direction dedicates bits to the low-variance, noise-dominated
            // tail and loses the gain (at the shipped full config: rank 71 ->
            // 0.655 self-recall vs rank 16 -> 0.775 vs random -> 0.68); the
            // optimum is a broad plateau from ~dim/8 to ~dim/2 with ~dim/4 best.
            // `maxRank: Infinity` aligns every direction; an explicit finite
            // `maxRank` overrides the default. `rankPolicy` (bitweight.js) instead
            // derives the rank from the spectrum — when a policy is set and
            // `maxRank` is not given explicitly, the default cap is NOT applied
            // (otherwise the policy could never choose a rank above dim/4).
            let maxRank;
            if (cfg.maxRank !== undefined) maxRank = cfg.maxRank;
            else if (cfg.rankPolicy) maxRank = Infinity;
            else maxRank = Math.max(2, Math.round(lowDim / 4));
            let result;
            try {
                result = alignedHashTables(rows, {
                    bits: this._lshHashBits,
                    numTables: this._lshNumTables,
                    seed,
                    iters: cfg.iters,
                    tol: cfg.tol,
                    maxRank,
                    rankPolicy: cfg.rankPolicy || null,
                });
            } catch (e) {
                continue;
            }
            next[s] = result.tables.map((table) => table.map((v) => Float32Array.from(v)));
            ranks[s] = result.rank;
            refreshed++;
        }
        if (refreshed === 0) return false;

        this._lshHyperplanes = next;
        this._lshAlignedRank = ranks;
        // Rebuild every bucket so the adjacency index stays in lockstep with
        // _semanticProtos (the invariant sanity.test.js case C checks).
        for (let t = 0; t < this._ensembleSize; t++) {
            this._semanticLSHBuckets[t] = Array.from({ length: numSets }, () =>
                Array.from({ length: this._lshNumTables }, () => new Map()));
            const protos = this._semanticProtos[t];
            if (!protos) continue;
            for (const p of protos) if (p) this._insertProtoToLSH(t, p);
        }
        return true;
    }

};
