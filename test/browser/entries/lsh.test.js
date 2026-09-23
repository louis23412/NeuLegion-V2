// LSH recall-preservation suite for NeuLegion.
//
// The semantic memory bank is only useful if `_getGlobalLSHCandidates` (and the
// retrieval probe loops built on the same primitives) actually *find* the
// prototypes that a query is close to. That property is what this entry pins.
//
// It splits the guarantees into three tiers so a failure names the tier:
//
//   THEORY (exact, must never fail)
//     * Every projection in `_projNorms` is unit norm, so `_projSimilarity` is a
//       true average cosine in [-1, 1] and self-similarity is exactly 1. This is
//       the direct regression guard for the historical 1/sqrt(lowDim) rescale
//       that compressed every projection score into [-1/lowDim, 1/lowDim] and
//       silently disabled semantic recall against the 0.35 similarity filter.
//     * A hash word is, bit for bit, the sign pattern of the projected vector
//       dotted with the set's random hyperplanes (`_computeLSHHashesLow`).
//     * Identical projected vectors hash identically (zero Hamming distance) and
//       land in the same bucket, so an exact-match query *always* recalls the
//       stored prototype.
//     * The bucket index is a faithful, leak-free mirror of `_semanticProtos`:
//       insert -> sets*tables references, remove -> zero references and pruned
//       empty buckets, update -> only the new hash buckets reference it.
//     * Random-hyperplane rounding (Goemans-Williamson / Charikar LSH): for two
//       projected vectors at angle theta, a random hyperplane through the origin
//       separates them with probability exactly theta/pi. We measure the
//       empirical flip rate and compare it against acos(cosine)/pi — the
//       defining correctness property of the whole index.
//
//   EMPIRICAL RECALL (pinned with margin)
//     * Near-duplicate queries (stored mean + Gaussian noise) recall the stored
//       prototype. Thresholds sit far above a broken index (which scores 0) and
//       comfortably below the measured curve, so they are robust to the random
//       hyperplanes while still catching a real recall regression.
//
//   PRODUCTION-SCALE NOTE
//     * At production dimensions the hash width (100+ bits) is far larger than
//       the 4 single-bit flips `_getGlobalLSHCandidates` probes, so that lean
//       helper only recalls near-exact matches. It is a *supplementary* pool
//       (see `broadcastMemory`, docs/LOCKED.md); the recall-critical path,
//       `_retrieveTopRelevantProtos`, probes every bit plus random multi-bit
//       perturbations and is checked end to end below.
//
// Like the other entries this takes an optional `{ ensureSql, stateDir }` so the
// node mirror can run against the real better-sqlite3 driver and a temp dir; in
// the browser harness it lazily loads the sql.js shim and uses the virtual fs.

import HiveMind from '../../../src/hivemind/hiveMind.js';

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function gauss(rnd) {
    let u = 0;
    let v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function bitAt(key, b) {
    return typeof key === 'bigint' ? ((key >> BigInt(b)) & 1n) === 1n : (key & (1 << b)) !== 0;
}

function hammingWord(a, b) {
    let d = 0;
    const bits = typeof a === 'bigint' ? a.toString(2).length : 32;
    for (let i = 0; i < bits; i++) if (bitAt(a, i) !== bitAt(b, i)) d++;
    return d;
}

// Count how many (set, table) buckets reference `proto`.
function bucketRefs(hm, transformerIdx, proto) {
    let refs = 0;
    for (let s = 0; s < hm._numLshSets; s++) {
        for (let t = 0; t < hm._lshNumTables; t++) {
            const bucket = hm._semanticLSHBuckets[transformerIdx][s][t];
            for (const set of bucket.values()) if (set.has(proto)) refs++;
        }
    }
    return refs;
}

// Number of empty Set values left behind in the index (should always be 0).
function emptyBucketSets(hm, transformerIdx) {
    let empties = 0;
    for (let s = 0; s < hm._numLshSets; s++) {
        for (let t = 0; t < hm._lshNumTables; t++) {
            for (const set of hm._semanticLSHBuckets[transformerIdx][s][t].values()) {
                if (set.size === 0) empties++;
            }
        }
    }
    return empties;
}

function makeBank(hm, transformerIdx, n, seed) {
    const H = hm._hiddenSize;
    const rnd = mulberry32(seed);
    const bank = [];
    for (let i = 0; i < n; i++) {
        const mean = new Float32Array(H);
        for (let d = 0; d < H; d++) mean[d] = gauss(rnd);
        const variance = new Float32Array(H);
        for (let d = 0; d < H; d++) variance[d] = 0.1 + rnd();
        const p = hm._createNewProto(mean, variance, 1 + Math.floor(rnd() * 5));
        hm._finalizeSemanticProto(p, transformerIdx);
        hm._semanticProtos[transformerIdx].push(p);
        bank.push(p);
    }
    return bank;
}

function noisyQuery(hm, proto, sigma, rnd) {
    const H = hm._hiddenSize;
    const mean = new Float32Array(H);
    for (let d = 0; d < H; d++) mean[d] = proto.mean[d] + gauss(rnd) * sigma;
    const q = hm._createNewProto(mean, proto.variance, 1);
    hm._finalizeSemanticProto(q, null);
    return q;
}

// Byte-identical comparison of two candidate pools (order included: the helper
// returns `Array.from(Set)`, so insertion order is deterministic).
function poolsEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].length !== b[i].length) return false;
        for (let j = 0; j < a[i].length; j++) if (a[i][j] !== b[i][j]) return false;
    }
    return true;
}

// Does the query-modified pool contain every baseline candidate (`subset`), and
// on how many queries did it change size at all (`differ`)?
function supersetReport(base, qm) {
    let subset = true;
    let differ = 0;
    for (let i = 0; i < base.length; i++) {
        const s = new Set(base[i]);
        for (const x of s) if (!qm[i].includes(x)) subset = false;
        if (qm[i].length !== s.size) differ++;
    }
    return { subset, differ };
}

function pooledRecall(pools, bank) {
    let hit = 0;
    for (let i = 0; i < bank.length; i++) if (pools[i].includes(bank[i])) hit++;
    return hit / bank.length;
}

// A bank whose means concentrate along a few planted orthonormal directions with
// decaying amplitudes — i.e. genuinely anisotropic, which is the regime where a
// data-aware (PCA-aligned) hash has structure to exploit. `makeBank` draws iid
// Gaussian means, whose projections are isotropic, so it cannot show the effect.
function makeAnisotropicBank(hm, transformerIdx, n, seed, spread = 6) {
    const H = hm._hiddenSize;
    const rnd = mulberry32(seed);
    const dirs = [];
    for (let j = 0; j < Math.min(6, H); j++) {
        const v = new Float64Array(H);
        for (let d = 0; d < H; d++) v[d] = gauss(rnd);
        for (const u of dirs) {
            let c = 0;
            for (let d = 0; d < H; d++) c += v[d] * u[d];
            for (let d = 0; d < H; d++) v[d] -= c * u[d];
        }
        let nn = 0;
        for (let d = 0; d < H; d++) nn += v[d] * v[d];
        nn = Math.sqrt(nn) || 1;
        for (let d = 0; d < H; d++) v[d] /= nn;
        dirs.push(v);
    }
    const bank = [];
    for (let i = 0; i < n; i++) {
        const mean = new Float32Array(H);
        for (let j = 0; j < dirs.length; j++) {
            const a = gauss(rnd) * spread * Math.pow(0.4, j);
            for (let d = 0; d < H; d++) mean[d] += a * dirs[j][d];
        }
        for (let d = 0; d < H; d++) mean[d] += gauss(rnd) * 1.0;
        const variance = new Float32Array(H);
        for (let d = 0; d < H; d++) variance[d] = 0.1 + rnd();
        const p = hm._createNewProto(mean, variance, 1 + Math.floor(rnd() * 5));
        hm._finalizeSemanticProto(p, transformerIdx);
        hm._semanticProtos[transformerIdx].push(p);
        bank.push(p);
    }
    return bank;
}

export async function run(options = {}) {
    if (options.ensureSql) await options.ensureSql();
    else {
        const shim = await import('../shims/better-sqlite3.js');
        await shim.__ensureSql();
    }
    const stateDir = options.stateDir || ((label) => `state/lsh-${label}`);

    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
    const realRandom = Math.random;
    const seeded = (seed, fn) => {
        Math.random = mulberry32(seed);
        try { return fn(); } finally { Math.random = realRandom; }
    };

    // ---- A. projection metric integrity (projNorms rescale regression) -------
    try {
        const hm = seeded(11, () => new HiveMind(stateDir('A'), 2, 12, 'A', true));
        const H = hm._hiddenSize;
        const rnd = mulberry32(101);
        const means = [];
        for (let i = 0; i < 40; i++) {
            const m = new Float32Array(H);
            for (let d = 0; d < H; d++) m[d] = gauss(rnd);
            means.push(m);
        }
        const projs = means.map((m) => hm._computeProjNorms(m));

        let maxNormErr = 0;
        for (const P of projs) {
            for (let np = 0; np < hm._numProjections; np++) {
                let ss = 0;
                for (let d = 0; d < hm._lowDim; d++) ss += P[np][d] * P[np][d];
                maxNormErr = Math.max(maxNormErr, Math.abs(Math.sqrt(ss) - 1));
            }
        }
        check('every projection is unit norm', maxNormErr < 1e-5, `maxNormErr=${maxNormErr.toExponential(3)}`);

        let minSelf = Infinity;
        for (const P of projs) minSelf = Math.min(minSelf, hm._projSimilarity(P, P));
        check('self projection-similarity is exactly 1', Math.abs(minSelf - 1) < 1e-5, `minSelf=${minSelf}`);

        let maxAbs = 0;
        for (let i = 0; i < projs.length; i++) {
            for (let j = 0; j < projs.length; j++) maxAbs = Math.max(maxAbs, Math.abs(hm._projSimilarity(projs[i], projs[j])));
        }
        check('projection similarity stays within [-1,1]', maxAbs <= 1 + 1e-5, `maxAbs=${maxAbs}`);

        // The historical bug scaled each projection by 1/sqrt(lowDim): every
        // cosine collapsed into [-1/lowDim, 1/lowDim], so a self-match scored
        // 1/lowDim and the 0.35 semantic filter rejected everything. Reproduce
        // the compressed metric here so the regression can never silently return.
        const compressedSelf = hm._projSimilarity(projs[0], projs[0]) / hm._lowDim;
        check('compressed (historical-bug) self-score would fall below the 0.35 filter',
            compressedSelf < 0.35, `compressedSelf=${compressedSelf} lowDim=${hm._lowDim}`);
        check('live self-score passes the 0.35 semantic filter', minSelf > 0.35, `self=${minSelf}`);

        check('_getLshBitMasks returns the cached masks array',
            hm._getLshBitMasks() === hm._getLshBitMasks(), 'not cached');
        const masksOk = hm._getLshBitMasks().every((m, b) => m === (1 << b));
        check('bit masks equal 1<<b for the low-bit config', masksOk && hm._lshKeyIsNumber === true,
            `keyIsNumber=${hm._lshKeyIsNumber}`);
    } catch (e) {
        check('projection metric block completed', false, e.stack);
    }

    // ---- B. hash primitive correctness ---------------------------------------
    try {
        const hm = seeded(12, () => new HiveMind(stateDir('B'), 2, 12, 'B', true));
        const H = hm._hiddenSize;
        const rnd = mulberry32(202);

        let mismatches = 0;
        let totalBits = 0;
        let zeroDistance = true;
        for (let i = 0; i < 20; i++) {
            const mean = new Float32Array(H);
            for (let d = 0; d < H; d++) mean[d] = gauss(rnd);
            const projs = hm._computeProjNorms(mean);
            for (let s = 0; s < hm._numLshSets; s++) {
                const hashes = hm._computeLSHHashesLow(projs[s], hm._lshHyperplanes[s]);
                for (let t = 0; t < hm._lshNumTables; t++) {
                    for (let b = 0; b < hm._lshHashBits; b++) {
                        const hyp = hm._lshHyperplanes[s][t][b];
                        let dot = 0;
                        for (let d = 0; d < hm._lowDim; d++) dot += projs[s][d] * hyp[d];
                        const expected = dot > 0;
                        if (bitAt(hashes[t], b) !== expected) mismatches++;
                        totalBits++;
                    }
                }
                const again = hm._computeLSHHashesLow(projs[s], hm._lshHyperplanes[s]);
                for (let t = 0; t < hm._lshNumTables; t++) {
                    if (again[t] !== hashes[t]) zeroDistance = false;
                }
                // identical vector -> identical hash word (zero Hamming distance)
                if (hammingWord(hashes[0], again[0]) !== 0) zeroDistance = false;
            }
        }
        check('hash words are exactly the sign of the hyperplane dot products', mismatches === 0,
            `mismatches=${mismatches}/${totalBits}`);
        check('hashing is deterministic and identical vectors collide', zeroDistance, 'nondeterministic or non-colliding');

        const hmBig = seeded(13, () => new HiveMind(stateDir('B2'), 2, 12, 'B2', false));
        check('wide-hash config falls back to BigInt keys (bits > 32)',
            hmBig._lshHashBits > 32 && hmBig._lshKeyIsNumber === false,
            `bits=${hmBig._lshHashBits} keyIsNumber=${hmBig._lshKeyIsNumber}`);
    } catch (e) {
        check('hash primitive block completed', false, e.stack);
    }

    // ---- C. bucket index fidelity (lockstep with _semanticProtos) ------------
    try {
        const hm = seeded(14, () => new HiveMind(stateDir('C'), 2, 12, 'C', true));
        const t = 0;
        const bank = makeBank(hm, t, 60, 303);
        const perProto = hm._numLshSets * hm._lshNumTables;

        let badOccupancy = 0;
        for (const p of bank) if (bucketRefs(hm, t, p) !== perProto) badOccupancy++;
        check('each prototype occupies exactly sets*tables buckets', badOccupancy === 0, `bad=${badOccupancy} expected=${perProto}`);

        const victim = bank[17];
        hm._removeProtoFromLSH(t, victim);
        check('removed prototype leaves the index completely', bucketRefs(hm, t, victim) === 0, `refs=${bucketRefs(hm, t, victim)}`);
        check('removed prototype clears its cached hashes', victim.lshHashes === undefined, String(victim.lshHashes));
        check('removal prunes empty buckets (no leak)', emptyBucketSets(hm, t) === 0, `empties=${emptyBucketSets(hm, t)}`);

        hm._insertProtoToLSH(t, victim);
        check('re-insert restores full occupancy', bucketRefs(hm, t, victim) === perProto, `refs=${bucketRefs(hm, t, victim)}`);

        // update-in-place with a fresh mean must move, not duplicate
        const oldHashes = victim.lshHashes[0][0];
        const H = hm._hiddenSize;
        const rnd = mulberry32(404);
        const newMean = new Float32Array(H);
        for (let d = 0; d < H; d++) newMean[d] = gauss(rnd);
        victim.mean = newMean;
        hm._invalidateProjCache(newMean);
        victim.projNorms = hm._computeProjNorms(newMean);
        hm._updateProtoInLSH(t, victim);
        const expectHashes = hm._computeLSHHashesLow(victim.projNorms[0], hm._lshHyperplanes[0]);
        check('update registers the new hashes', victim.lshHashes[0][0] === expectHashes[0],
            `got=${victim.lshHashes[0][0]} want=${expectHashes[0]}`);
        check('update keeps exactly one bucket per table', bucketRefs(hm, t, victim) === perProto, `refs=${bucketRefs(hm, t, victim)}`);

        const cand = hm._getGlobalLSHCandidates(victim.mean, victim.projNorms, 4096);
        check('exact query after update recalls the moved prototype', cand.includes(victim), `n=${cand.length}`);
        void oldHashes;
        check('index carries no empty buckets after churn', emptyBucketSets(hm, t) === 0, `empties=${emptyBucketSets(hm, t)}`);
    } catch (e) {
        check('bucket fidelity block completed', false, e.stack);
    }

    // ---- D. exact-match recall is total --------------------------------------
    const minHm = seeded(15, () => new HiveMind(stateDir('D'), 2, 12, 'D', true));
    let minBank = [];
    try {
        minBank = makeBank(minHm, 0, 80, 505);
        let hit = 0;
        for (const p of minBank) {
            const projs = minHm._computeProjNorms(p.mean);
            const cand = minHm._getGlobalLSHCandidates(p.mean, projs, 100000);
            if (cand.includes(p)) hit++;
        }
        check('exact-match query recalls every stored prototype', hit === minBank.length, `hit=${hit}/${minBank.length}`);
    } catch (e) {
        check('exact-recall block completed', false, e.stack);
    }

    // ---- E. near-duplicate recall (pinned, with margin) ----------------------
    try {
        const measured = {};
        for (const sigma of [0.05, 0.1, 0.25, 0.5, 1.0]) {
            const rnd = mulberry32(606);
            let selfHit = 0;
            let top1Covered = 0;
            for (const p of minBank) {
                const q = noisyQuery(minHm, p, sigma, rnd);
                const cand = minHm._getGlobalLSHCandidates(q.mean, q.projNorms, 100000);
                if (cand.includes(p)) selfHit++;
                let bi = -1;
                let bs = -Infinity;
                for (const other of minBank) {
                    const s = minHm._projSimilarity(q.projNorms, other.projNorms);
                    if (s > bs) { bs = s; bi = other; }
                }
                if (cand.includes(bi)) top1Covered++;
            }
            measured[sigma] = { selfHit: selfHit / minBank.length, top1: top1Covered / minBank.length };
        }
        check('near-duplicate recall @ noise 0.05 >= 0.97', measured[0.05].selfHit >= 0.97, JSON.stringify(measured[0.05]));
        check('near-duplicate recall @ noise 0.1 >= 0.92', measured[0.1].selfHit >= 0.92, JSON.stringify(measured[0.1]));
        check('near-duplicate recall @ noise 0.25 >= 0.85', measured[0.25].selfHit >= 0.85, JSON.stringify(measured[0.25]));
        check('brute-force top-1 neighbour covered @ noise 0.5 >= 0.85', measured[0.5].top1 >= 0.85, JSON.stringify(measured[0.5]));
        check('recall is monotone non-increasing in noise',
            measured[0.05].selfHit >= measured[0.1].selfHit && measured[0.1].selfHit >= measured[0.25].selfHit,
            JSON.stringify(Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, v.selfHit]))));
    } catch (e) {
        check('near-duplicate recall block completed', false, e.stack);
    }

    // ---- F. random-hyperplane rounding theorem: P(flip) = theta / pi ---------
    try {
        const H = minHm._hiddenSize;
        const rows = {};
        let maxDev = 0;
        for (const sigma of [0.05, 0.1, 0.25, 0.5, 1.0]) {
            const rnd = mulberry32(707);
            let predSum = 0;
            let measSum = 0;
            let n = 0;
            for (const p of minBank) {
                const q = noisyQuery(minHm, p, sigma, rnd);
                for (let s = 0; s < minHm._numLshSets; s++) {
                    const A = p.projNorms[s];
                    const B = q.projNorms[s];
                    let dot = 0;
                    for (let d = 0; d < minHm._lowDim; d++) dot += A[d] * B[d];
                    const cos = Math.max(-1, Math.min(1, dot));
                    const predicted = Math.acos(cos) / Math.PI;
                    const hA = minHm._computeLSHHashesLow(A, minHm._lshHyperplanes[s]);
                    const hB = minHm._computeLSHHashesLow(B, minHm._lshHyperplanes[s]);
                    for (let t = 0; t < minHm._lshNumTables; t++) {
                        for (let b = 0; b < minHm._lshHashBits; b++) {
                            predSum += predicted;
                            measSum += bitAt(hA[t], b) !== bitAt(hB[t], b) ? 1 : 0;
                            n++;
                        }
                    }
                }
            }
            const predicted = predSum / n;
            const measured = measSum / n;
            rows[sigma] = { predicted, measured, n };
            maxDev = Math.max(maxDev, Math.abs(predicted - measured));
        }
        check('measured bit-flip rate matches the theta/pi rounding theorem (<= 0.03)',
            maxDev <= 0.03, `maxDev=${maxDev.toFixed(4)} rows=${JSON.stringify(rows)}`);
        check('flip rate is monotone increasing in noise',
            rows[0.05].measured < rows[0.1].measured &&
            rows[0.1].measured < rows[0.25].measured &&
            rows[0.25].measured < rows[0.5].measured &&
            rows[0.5].measured < rows[1.0].measured,
            JSON.stringify(Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.measured]))));
    } catch (e) {
        check('rounding-theorem block completed', false, e.stack);
    }

    // ---- G. retrieval-path recall (end to end) --------------------------------
    try {
        const trials = 8;
        let recalled = 0;
        let maxSimSeen = -2;
        seeded(909, () => {
            for (let i = 0; i < trials; i++) {
                const target = minBank[(i * 9 + 3) % minBank.length];
                const rnd = mulberry32(9000 + i);
                const q = noisyQuery(minHm, target, 0.05, rnd);
                const selected = minHm._retrieveTopRelevantProtos(0, [q], 16);
                let best = -2;
                let hit = false;
                for (const p of selected) {
                    const s = minHm._projSimilarity(q.projNorms, p.projNorms);
                    if (s > best) best = s;
                    if (p === target) hit = true;
                }
                if (hit) recalled++;
                maxSimSeen = Math.max(maxSimSeen, best);
            }
        });
        check('retrieval recalls the query prototype in every trial', recalled === trials,
            `recalled=${recalled}/${trials}`);
        check('retrieval surfaces a near-identical prototype (projSim > 0.9)', maxSimSeen > 0.9,
            `maxSim=${maxSimSeen.toFixed(4)}`);
    } catch (e) {
        check('retrieval-path block completed', false, e.stack);
    }

    // ---- H. production-scale config: exact recall + documented curve ---------
    try {
        const midHm = seeded(16, () => new HiveMind(stateDir('H'), 2, 12, 'H', false));
        const bank = makeBank(midHm, 0, 80, 808);
        let exact = 0;
        for (const p of bank) {
            const projs = midHm._computeProjNorms(p.mean);
            const cand = midHm._getGlobalLSHCandidates(p.mean, projs, 100000);
            if (cand.includes(p)) exact++;
        }
        check('wide-hash config still recalls every exact match', exact === bank.length, `exact=${exact}/${bank.length}`);

        let near = 0;
        let far = 0;
        const rnd = mulberry32(818);
        for (const p of bank) {
            const q1 = noisyQuery(midHm, p, 0.1, rnd);
            if (midHm._getGlobalLSHCandidates(q1.mean, q1.projNorms, 100000).includes(p)) near++;
            const q2 = noisyQuery(midHm, p, 0.5, rnd);
            if (midHm._getGlobalLSHCandidates(q2.mean, q2.projNorms, 100000).includes(p)) far++;
        }
        check('wide-hash near-duplicate recall @ noise 0.1 >= 0.9', near / bank.length >= 0.9, `near=${near}/${bank.length}`);

        // The lean candidate helper is a supplementary pool at production width,
        // so a far query may miss it; the recall-critical path must not.
        let retrievalHit = 0;
        seeded(919, () => {
            for (let i = 0; i < 4; i++) {
                const target = bank[(i * 17 + 5) % bank.length];
                const q = noisyQuery(midHm, target, 0.25, mulberry32(9500 + i));
                const selected = midHm._retrieveTopRelevantProtos(0, [q], 24);
                if (selected.some((p) => midHm._projSimilarity(q.projNorms, p.projNorms) > 0.9)) retrievalHit++;
            }
        });
        check('wide-hash retrieval path still finds a near neighbour', retrievalHit === 4, `hit=${retrievalHit}/4`);
        // The lean helper is a supplementary pool at production width (4 single-bit
        // flips vs 100+ hash bits), so its recall must degrade with noise. The
        // recall-critical path is _retrieveTopRelevantProtos, checked above.
        check('wide-hash lean-helper recall degrades with noise (supplementary pool)',
            far <= near, `near=${near}/${bank.length} far=${far}/${bank.length}`);
    } catch (e) {
        check('production-scale block completed', false, e.stack);
    }

    // ---- I. data-aware (PCA-aligned) hyperplane refresh ----------------------
    // BinaryPC (arXiv 2608.04405): learn the hash directions from the data. The
    // flag is off by default, so this whole section is the *only* place the
    // trained hyperplanes are exercised. The measurement is paired (same seeded
    // noisy queries before and after the refresh), so it isolates the hash change.
    try {
        const hm = seeded(21, () => new HiveMind(stateDir('I'), 2, 12, 'I', false));
        const bank = makeAnisotropicBank(hm, 0, 200, 2121);
        const sigmas = [0.1, 0.25, 0.5];

        const measure = (sigma, useProbe) => {
            hm._multiProbeConfig = useProbe ? { maxFlips: 2, budget: 8 } : null;
            const rnd = mulberry32(2200 + Math.round(sigma * 100));
            let hit = 0;
            for (const p of bank) {
                const q = noisyQuery(hm, p, sigma, rnd);
                const cand = hm._getGlobalLSHCandidates(q.mean, q.projNorms, 100000);
                if (cand.includes(p)) hit++;
            }
            hm._multiProbeConfig = null;
            return hit / bank.length;
        };
        const snapshot = () => ({
            prefix: sigmas.map((s) => measure(s, false)),
            probe: sigmas.map((s) => measure(s, true)),
        });

        check('data-aware hash config is off by default', hm._pcaHashConfig === null);
        const hypBefore = hm._lshHyperplanes;
        check('refresh with the flag off is an exact no-op (returns false, hyperplanes untouched)',
            hm._refreshLshHyperplanes() === false && hm._lshHyperplanes === hypBefore);

        const record = {};
        record.random = snapshot();

        // Default config (no maxRank): the wiring picks its own alignment rank.
        hm._pcaHashConfig = { seed: 4242, iters: 48, tol: 1e-8 };
        check('refresh with the default config replaces the hyperplanes', hm._refreshLshHyperplanes() === true);
        record.default = snapshot();

        const ranks = {};
        for (const maxRank of [4, 8, 16, 32, 71]) {
            hm._pcaHashConfig = { seed: 4242, iters: 48, tol: 1e-8, maxRank };
            check(`refresh(maxRank=${maxRank}) replaces the hyperplanes`, hm._refreshLshHyperplanes() === true);
            record[`rank${maxRank}`] = snapshot();
            ranks[`rank${maxRank}`] = hm._lshAlignedRank.slice();
        }
        // Data-driven rank (memory/bitweight.js): instead of the fixed dim/4
        // constant, pick the aligned rank from the spectrum — 'above-mean' keeps
        // only PCs above the random-direction baseline trace/dim.
        for (const rankPolicy of ['above-mean', 'noise']) {
            hm._pcaHashConfig = { seed: 4242, iters: 48, tol: 1e-8, rankPolicy };
            check(`refresh(rankPolicy=${rankPolicy}) replaces the hyperplanes`, hm._refreshLshHyperplanes() === true);
            record[`policy_${rankPolicy}`] = snapshot();
            ranks[`policy_${rankPolicy}`] = hm._lshAlignedRank.slice();
        }
        check('SWEEP', true, JSON.stringify({ bits: hm._lshHashBits, dim: hm._lowDim, sets: hm._numLshSets, tables: hm._lshNumTables, ranks, record }));

        const R = record.random;
        const best = record.rank16;
        check('real-index: no config regresses near-exact recall (sigma=0.1 is total everywhere)',
            Object.values(record).every((v) => v.prefix[0] === 1 && v.probe[0] === 1));
        check('real-index: aligned hyperplanes + margin multi-probe strictly beat random + multi-probe (sigma=0.25)',
            best.probe[1] > R.probe[1], `random=${R.probe[1]} rank16=${best.probe[1]}`);
        check('real-index: the aligned hash also lifts prefix-probe recall (sigma=0.25)',
            best.prefix[1] > R.prefix[1], `random=${R.prefix[1]} rank16=${best.prefix[1]}`);
        check('real-index: the gain holds deep in the noise (sigma=0.5 with multi-probe)',
            best.probe[2] > R.probe[2], `random=${R.probe[2]} rank16=${best.probe[2]}`);
        check('real-index: aligning EVERY direction is a no-gain (noise-tail) config, beaten by the moderate rank',
            record.rank71.probe[1] <= best.probe[1] && record.rank71.prefix[1] <= best.prefix[1],
            `rank71=${record.rank71.probe[1]}/${record.rank71.prefix[1]} rank16=${best.probe[1]}/${best.prefix[1]}`);
        check('real-index: the measured default rank sits in the winning plateau',
            record.default.probe[1] >= R.probe[1],
            `default=${record.default.probe[1]} random=${R.probe[1]}`);

        // The data-driven rank (bitweight.js `selectReliableRank`, policy
        // 'above-mean'): keep only PCs above the random-direction baseline
        // trace/dim. This is the principled replacement for the magic dim/4
        // constant — the rank is read off the spectrum, not hard-coded.
        const policy = record['policy_above-mean'];
        check('real-index: the data-driven above-mean rank policy beats random multi-probe',
            policy.probe[1] > R.probe[1] && policy.prefix[1] >= R.prefix[1],
            `random=${R.probe[1]} policy=${policy.probe[1]} prefixRandom=${R.prefix[1]} prefixPolicy=${policy.prefix[1]}`);
        check('real-index: the above-mean policy avoids the full-alignment no-gain config',
            policy.probe[1] > record.rank71.probe[1],
            `policy=${policy.probe[1]} rank71=${record.rank71.probe[1]}`);
        check('real-index: the above-mean rank is read off the spectrum, not the dim/4 constant',
            ranks['policy_above-mean'].length === hm._numLshSets &&
            ranks['policy_above-mean'].every((r) => r > 0 && r < hm._lowDim) &&
            ranks['policy_above-mean'].some((r) => r !== Math.round(hm._lowDim / 4)),
            JSON.stringify(ranks['policy_above-mean']));

        // The rebuilt index must stay a leak-free mirror of _semanticProtos.
        let refsOk = true;
        for (const p of bank) if (bucketRefs(hm, 0, p) !== hm._numLshSets * hm._lshNumTables) refsOk = false;
        check('refreshed index keeps every proto in exactly numLshSets*numTables buckets', refsOk);
        check('refreshed index leaves no empty bucket sets behind', emptyBucketSets(hm, 0) === 0);

        // Hyperplanes must remain finite, lowDim-sized and unit-norm.
        let hypOk = true;
        for (let s = 0; s < hm._numLshSets; s++) {
            if (hm._lshHyperplanes[s].length !== hm._lshNumTables) hypOk = false;
            for (let t = 0; t < hm._lshNumTables; t++) {
                if (hm._lshHyperplanes[s][t].length !== hm._lshHashBits) hypOk = false;
                for (let b = 0; b < hm._lshHashBits; b++) {
                    const v = hm._lshHyperplanes[s][t][b];
                    if (!v || v.length !== hm._lowDim) { hypOk = false; continue; }
                    let ss = 0;
                    for (let d = 0; d < v.length; d++) { if (!Number.isFinite(v[d])) hypOk = false; ss += v[d] * v[d]; }
                    if (Math.abs(Math.sqrt(ss) - 1) > 1e-4) hypOk = false;
                }
            }
        }
        check('refreshed hyperplanes are finite, lowDim-sized unit vectors', hypOk);

        // Determinism: two identically-seeded instances refresh identically.
        const freshPair = () => {
            const m = seeded(21, () => new HiveMind(stateDir('I3'), 2, 12, 'I3', false));
            makeAnisotropicBank(m, 0, 200, 2121);
            m._pcaHashConfig = { seed: 4242, iters: 48, tol: 1e-8, maxRank: 8 };
            m._refreshLshHyperplanes();
            return m;
        };
        const hA = freshPair();
        const hB = freshPair();
        let same = true;
        for (let s = 0; s < hA._numLshSets; s++)
            for (let t = 0; t < hA._lshNumTables; t++)
                for (let b = 0; b < hA._lshHashBits; b++) {
                    const a = hA._lshHyperplanes[s][t][b];
                    const c = hB._lshHyperplanes[s][t][b];
                    for (let d = 0; d < hA._lowDim; d++) if (a[d] !== c[d]) same = false;
                }
        check('the seeded refresh is bit-deterministic across instances', same);

        // Too little data: below minRows the set falls back to its random
        // hyperplanes and the refresh reports no work done.
        const hmSparse = seeded(22, () => new HiveMind(stateDir('I4'), 2, 12, 'I4', false));
        const hBefore = hmSparse._lshHyperplanes;
        hmSparse._pcaHashConfig = { seed: 1, iters: 8, tol: 1e-6 };
        check('refresh with too few prototypes is a no-op (falls back to random hyperplanes)',
            hmSparse._refreshLshHyperplanes() === false && hmSparse._lshHyperplanes === hBefore);

        // The refreshed hyperplanes must survive a SQLite round-trip: they are
        // persisted per set/table/bit and restored on load, and the loader rebuilds
        // the buckets from the protos under them, so the reloaded instance needs no
        // re-refresh (its `_pcaHashConfig` is the fresh class default, null).
        hm.dumpState();
        const hmReload = seeded(21, () => new HiveMind(stateDir('I'), 2, 12, 'I', false));
        let roundTrip = true;
        for (let s = 0; s < hm._numLshSets; s++)
            for (let t = 0; t < hm._lshNumTables; t++)
                for (let b = 0; b < hm._lshHashBits; b++) {
                    const a = hm._lshHyperplanes[s][t][b];
                    const c = hmReload._lshHyperplanes[s][t][b];
                    for (let d = 0; d < hm._lowDim; d++) if (a[d] !== c[d]) roundTrip = false;
                }
        let reloadRefsOk = hmReload._semanticProtos[0].length === bank.length;
        for (const p of hmReload._semanticProtos[0]) {
            if (bucketRefs(hmReload, 0, p) !== hmReload._numLshSets * hmReload._lshNumTables) reloadRefsOk = false;
        }
        check('aligned hyperplanes survive a save/load round-trip and the reloaded index is leak-free',
            roundTrip && reloadRefsOk && hmReload._pcaHashConfig === null,
            `roundTrip=${roundTrip} reloadRefsOk=${reloadRefsOk} protos=${hmReload._semanticProtos[0].length}/${bank.length}`);
    } catch (e) {
        check('data-aware refresh block completed', false, e.stack);
    }

    // ---- J. dynamic query modification (query-side recall fix) ---------------
    // Claydon, Connor & Dearle, arXiv 2605.23807. `_getGlobalLSHCandidates` runs
    // `rounds` query-modification rounds per set when `_queryModConfig` is set
    // (memory/querymod.js, proved in querymod.test.js): each round replaces the
    // set's query projection with the l2-normalised centroid of the candidates
    // found through that set, re-hashes it and unions new buckets. The flag is
    // null by default, so the branch is skipped and every golden fingerprint is
    // unchanged. The union means the returned pool is MECHANICALLY a superset of
    // the baseline, so recall can never fall; whether it grows depends entirely
    // on how dense the buckets are:
    //   * NARROW hash (the `forceMin` 6-bit / lowDim-4 index, buckets ~58% of the
    //     bank): the branch is demonstrably LIVE — it enlarges the pool for the
    //     large majority of queries.
    //   * PRODUCTION 107-bit index: it adds nothing. The exact buckets hold
    //     ~0.1-1 prototypes, so each set's found set is empty (skipped) or a
    //     single candidate whose own word was already probed, and the consensus
    //     word h(<c>) is an empty bucket. This is exactly the empty-consensus-
    //     bucket regime mapped by querymod.test.js section I — an honest,
    //     measured negative, not a wiring bug.
    try {
        const minHm = seeded(41, () => new HiveMind(stateDir('J1'), 2, 12, 'J1', true));
        const minBank = makeBank(minHm, 0, 80, 4141);

        const collect = (hm, bank, sigma, cfg) => {
            hm._multiProbeConfig = { maxFlips: 2, budget: 8 };
            hm._queryModConfig = cfg;
            const rnd = mulberry32(4300 + Math.round(sigma * 100));
            const out = [];
            for (const p of bank) {
                const q = noisyQuery(hm, p, sigma, rnd);
                out.push(hm._getGlobalLSHCandidates(q.mean, q.projNorms, 100000));
            }
            hm._queryModConfig = null;
            hm._multiProbeConfig = null;
            return out;
        };
        const qmCfg = { alpha: 1, topK: 16, rounds: 1, maxFlips: 2, probeBudget: 8 };

        check('query-modification config is off by default', minHm._queryModConfig === null);

        // The flag off (never set, then toggled back) is byte-identical.
        const offA = collect(minHm, minBank, 0.5, null);
        const on1 = collect(minHm, minBank, 0.5, qmCfg);
        const on2 = collect(minHm, minBank, 0.5, qmCfg);
        const offB = collect(minHm, minBank, 0.5, null);
        check('flag off is byte-identical (toggling the flag back is an exact no-op)',
            poolsEqual(offA, offB));
        check('the query-modified pass is deterministic under a fixed seed',
            poolsEqual(on1, on2));

        const narrow = supersetReport(offA, on1);
        const narrowRecallBase = pooledRecall(offA, minBank);
        const narrowRecallQm = pooledRecall(on1, minBank);
        check('narrow-hash index: the modified pool is a superset of the baseline',
            narrow.subset, `differ=${narrow.differ}/${minBank.length}`);
        check('narrow-hash index: the branch is LIVE (it enlarges the pool for most queries)',
            narrow.differ > minBank.length / 2, `differ=${narrow.differ}/${minBank.length}`);
        check('narrow-hash index: recall is never lost by query modification',
            narrowRecallQm + 1e-9 >= narrowRecallBase,
            `base=${narrowRecallBase} qm=${narrowRecallQm}`);

        // Production width: the pool is still a superset (no regression) but the
        // query-modified pass adds nothing — the empty-consensus-bucket regime.
        const prodHm = seeded(31, () => new HiveMind(stateDir('J2'), 2, 12, 'J2', false));
        const prodBank = makeAnisotropicBank(prodHm, 0, 80, 3131);
        check('production index has the wide hash width this negative is about',
            prodHm._lshHashBits >= 64 && prodHm._lowDim > 16,
            `bits=${prodHm._lshHashBits} dim=${prodHm._lowDim}`);

        const prodReport = {};
        for (const sigma of [0.25]) {
            const base = collect(prodHm, prodBank, sigma, null);
            const qm = collect(prodHm, prodBank, sigma, qmCfg);
            const rep = supersetReport(base, qm);
            prodReport[sigma] = {
                subset: rep.subset, differ: rep.differ,
                baseRecall: pooledRecall(base, prodBank), qmRecall: pooledRecall(qm, prodBank),
                poolBase: base.reduce((s, p) => s + p.length, 0) / base.length,
                poolQm: qm.reduce((s, p) => s + p.length, 0) / qm.length,
            };
            check(`production 107-bit index @ sigma=${sigma}: the modified pool is a superset (recall never falls)`,
                rep.subset && prodReport[sigma].qmRecall + 1e-9 >= prodReport[sigma].baseRecall,
                JSON.stringify(prodReport[sigma]));
        }
        check('SWEEP', true, JSON.stringify({ narrow: { differ: narrow.differ, base: narrowRecallBase, qm: narrowRecallQm }, prod: prodReport }));
        check('production 107-bit index: query modification adds nothing (empty-consensus-bucket regime)',
            Object.values(prodReport).every((r) => r.differ === 0),
            JSON.stringify(prodReport));
    } catch (e) {
        check('dynamic-query-modification block completed', false, e.stack);
    }

    // ---- K. retrieval liveness of the PCA-aligned basis (round 28, BUGS.md #53 / P2)
    // `_retrieveTopRelevantProtos` is the SCORED reader (R27-2), and
    // `_refreshLshHyperplanes` mutates the buckets it reads — so the open
    // question is not reachability but whether the basis can change the
    // *retrieved prototype set*. Its `Math.random()` draws are of two kinds:
    // bucket-probe flips (basis-dependent) and index-picks over `semProtos`
    // (`semProtos[floor(rand*numSem)]`, basis-independent). So under a FIXED
    // retrieval RNG seed, EQUAL draw counts mean the two configs consume the
    // same stream and every index-pick is identical — any retrieved-id
    // difference is then attributable to the basis, not to stream desync.
    //
    // Measured (round-28 P2 probe, RUN-ANALYSIS.md §14): the unique retrieved
    // SET is INVARIANT to the basis at every tested pool/budget (80/200/600
    // prototypes, production and narrow width). What can differ at production
    // width is the *returned list's duplicate multiplicity* — the fallback
    // fillers in retrieval.js push without adding to their guard Set, so the
    // same prototype can enter `candProtos` more than once (BUGS.md #59), and
    // the basis changes which duplicates survive. At narrow (6-bit) width the
    // draw stream desyncs, so a difference there would not be attributable at
    // all — which is why the certificate uses the set + equal-draw-count test.
    try {
        const uniqIds = (s) => [...new Set(s.split(',').filter(Boolean))].sort().join(',');
        const measure = (forceMin, pool, retSeeds, qCount) => {
            const width = forceMin ? 'narrow' : 'prod';
            const rows = [];
            for (const rs of retSeeds) {
                const build = (tag) => seeded(1000 + pool + rs, () => {
                    const hm = new HiveMind(stateDir(`K-${width}-${pool}-${tag}-${rs}`), 2, 12, 'K', forceMin);
                    const bank = makeAnisotropicBank(hm, 0, pool, 4000 + pool);
                    return { hm, bank };
                });
                const b = build('b');
                const p = build('p');
                const makeQ = (hm, bank, seed) => {
                    const rnd = mulberry32(seed);
                    return Array.from({ length: qCount }, (_, i) => noisyQuery(hm, bank[(i * 7 + 3) % bank.length], 0.25, rnd));
                };
                const qSeed = 2000 + pool + rs;
                const bq = makeQ(b.hm, b.bank, qSeed);
                const pq = makeQ(p.hm, p.bank, qSeed);
                p.hm._pcaHashConfig = { seed: 4242, iters: 48, tol: 1e-8 };
                p.hm._refreshLshHyperplanes();
                b.bank.forEach((pp, i) => { pp.__kId = i; });
                p.bank.forEach((pp, i) => { pp.__kId = i; });
                const run = (hm, qs) => {
                    let draws = 0;
                    const rnd = mulberry32(rs);
                    const real = Math.random;
                    Math.random = () => { draws++; return rnd(); };
                    const sig = [];
                    let hasDup = false;
                    try {
                        for (const q of qs) {
                            const ids = hm._retrieveTopRelevantProtos(0, [q], 116).map((pp) => pp.__kId);
                            if (new Set(ids).size !== ids.length) hasDup = true;
                            sig.push(ids.sort((a, bb) => a - bb).join(','));
                        }
                    } finally { Math.random = real; }
                    return { sig, draws, hasDup };
                };
                const rb = run(b.hm, bq);
                const rp = run(p.hm, pq);
                let setDiff = 0, listDiff = 0;
                for (let i = 0; i < rb.sig.length; i++) {
                    if (uniqIds(rb.sig[i]) !== uniqIds(rp.sig[i])) setDiff += 1;
                    if (rb.sig[i] !== rp.sig[i]) listDiff += 1;
                }
                rows.push({ rs, setDiff, listDiff, drawsEq: rb.draws === rp.draws, baseDraws: rb.draws, pcaDraws: rp.draws, baseHasDup: rb.hasDup });
            }
            return rows;
        };

        const rows80 = measure(false, 80, [2, 3, 5], 4);
        check('production width, 80-prototype bank: the retrieved prototype SET is INVARIANT to the aligned basis at every seeded query set (the P2 negative — the mechanism is retrieval-set-inert)',
            rows80.every((r) => r.setDiff === 0), JSON.stringify(rows80));
        check('production width, 80-prototype bank: the RNG draw count is invariant to the basis at every seed, so the returned-list difference below is attributable to the basis, not to stream desync',
            rows80.every((r) => r.drawsEq), JSON.stringify(rows80.map((r) => [r.baseDraws, r.pcaDraws])));
        check('production width, 80-prototype bank: the aligned basis DOES change the returned list on >=1 seeded query set (duplicate-multiplicity only, BUGS.md #59) while the set stays identical — so the mechanism reaches the scored reader\'s output without changing the retrieved neighbourhood',
            rows80.some((r) => r.listDiff > 0 && r.setDiff === 0), JSON.stringify(rows80));

        const rows600 = measure(false, 600, [5], 4);
        check('production width, 600-prototype bank: the retrieved set (and list) is unchanged at this seed — the multiplicity effect is pool-size dependent, not universal',
            rows600.every((r) => r.setDiff === 0 && r.listDiff === 0), JSON.stringify(rows600));

        const rowsNarrow = measure(true, 200, [3, 5], 4);
        check('narrow (6-bit) width: the draw stream DESYNCS across the basis at >=1 seed, so a set/list difference there would not be attributable — the reason the certificate uses the production-width, equal-draw-count test',
            rowsNarrow.some((r) => !r.drawsEq), JSON.stringify(rowsNarrow.map((r) => [r.setDiff, r.listDiff, r.drawsEq, r.baseDraws, r.pcaDraws])));
        check('SWEEP', true, JSON.stringify({ prod80: rows80, prod600: rows600, narrow200: rowsNarrow }));
    } catch (e) {
        check('retrieval-liveness block completed', false, e.stack);
    }

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
