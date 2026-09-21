// Dynamic query modification for binary LSH suite (Claydon, Connor & Dearle,
// arXiv 2605.23807).
//
// Binary SimHash (Charikar 2002) hashes a query q to a sign word h(q) and
// retrieves the bucket sharing that word. Two failure modes limit recall:
// (a) the word sits in a sparse bucket, so the true neighbours live in
// neighbouring buckets — multi-probe attacks that (memory/multiprobe.js,
// memory/bitweight.js); and (b) the query itself is a poor representative of its
// own neighbourhood, hashing to a bucket that contains NONE of its neighbours.
// Dynamic query modification attacks (b): replace q with the l2-normalised
// centroid <c> of the neighbours found so far and continue the search with <c>.
//
// This entry proves the four results the module is built on, each exact, plus
// the two empirical laws the paper rests on:
//
//   THEORY (exact, deterministic — must never fail)
//     * Theorem 1 (maximality). For a finite unit-vector set S, no unit u beats
//       the centroid on sum_{x in S} (x . u); the sum at <c> equals ||sum x||
//       exactly, which also equals k*||mean||.
//     * Theorem 2 (average collision probability). Charikar's law makes
//       ACP(u, S) = 1 - mean arccos(x.u)/pi; to first order it is exactly
//       1/2 + dotProductSum(u, S)/(k pi), so Theorem 1 says <c> maximises it.
//     * Appendix C.1 (minimal average covariance). averageCovariance(u, S) is
//       exactly const - ((sum x.u)/k)^2, so <c> is one of its two minimisers
//       (±<c>) and no u beats it.
//     * Section 6.4 (hash-failure). Because <c> is parallel to sum_{x in S} x,
//       its bit on any direction is sign(sum_x x.w), which some member of S must
//       share: the centroid collides with a member on EVERY direction. A raw
//       query has no such guarantee.
//
//   EMPIRICAL (Monte Carlo, pinned with margin)
//     * Charikar's collision law P[h(a)=h(b)] = 1 - arccos(a.b)/pi is the
//       definition of the hash: the measured random-hyperplane agreement rate
//       matches it to < 0.01 at 4e4 hyperplanes.
//     * The denoising law: the centroid of M noisy views of a point has a
//       strictly lower per-bit error rate than a single view, and the rate
//       shrinks with M — the reason averaging the found neighbourhood is a
//       better query than any one of its members.
//     * The synthetic regime experiment maps WHEN the modification pays: on a
//       random-hyperplane index, query modification strictly raises pool recall
//       while the bucket word is informative, and the gain decays to zero as the
//       hash narrows (the empty-consensus-bucket regime) — the honest explanation
//       of the zero measured gain on the production 107-bit index (see
//       lsh.test.js section J).
//
// Pure module only (no HiveMind): every check is deterministic given the seeds.

import {
    DEFAULT_QUERYMOD_CONFIG, resolveQueryModConfig,
    dot, norm, cosine, normalize, meanVector, normalizedCentroid,
    dotProductSum, collisionProbabilityFromCos, collisionProbability,
    averageCollisionProbability, firstOrderCollisionProbability,
    averageCovariance, signBit, hashBits, collidesWithSet,
    centroidCollidesWithSet, collisionCoverage, selectCandidates,
    blendVectors, modifiedQuery, queryModificationGain,
} from '../../../src/hivemind/memory/querymod.js';

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

function randomUnit(dim, rnd) {
    const v = new Float64Array(dim);
    for (let d = 0; d < dim; d++) v[d] = gauss(rnd);
    let n = 0;
    for (let d = 0; d < dim; d++) n += v[d] * v[d];
    n = Math.sqrt(n) || 1;
    for (let d = 0; d < dim; d++) v[d] /= n;
    return v;
}

function randomSet(k, dim, rnd) {
    const out = [];
    for (let i = 0; i < k; i++) out.push(randomUnit(dim, rnd));
    return out;
}

function negate(v) {
    const out = new Float64Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = -v[i];
    return out;
}

function maxDiff(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let m = 0;
    for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
    return m;
}

function sumVector(vectors, dim) {
    const out = new Float64Array(dim);
    for (const x of vectors) for (let d = 0; d < dim; d++) out[d] += x[d];
    return out;
}

// One random-hyperplane SimHash index over a bank of unit vectors, used by the
// synthetic regime experiment. The modified query is looked up by its exact
// bucket plus the lowest-margin bit flips — the same probe the production wiring
// uses (memory/lsh.js) at a controlled width.
function syntheticExperiment({ dim = 8, bits = 10, tables = 4, N = 200, k = 8,
    sigma = 0.5, rehashFlips = 0, seed = 1, rounds = 1, topK = 16, reps = 300 } = {}) {
    const rnd = mulberry32(seed);
    const hyper = [];
    for (let t = 0; t < tables; t++) {
        const tbl = [];
        for (let b = 0; b < bits; b++) tbl.push(randomUnit(dim, rnd));
        hyper.push(tbl);
    }
    const bank = [];
    for (let i = 0; i < N; i++) bank.push(randomUnit(dim, rnd));

    const dotsOf = (v, tbl) => tbl.map((h) => dot(v, h));
    const keyOf = (dots) => {
        let key = 0;
        for (let b = 0; b < dots.length; b++) if (dots[b] > 0) key |= (1 << b);
        return key;
    };
    // The `rehashFlips` lowest-margin bit flips of a word (ascending |dot|).
    const marginFlips = (dots) => {
        const idx = dots.map((d, i) => ({ i, m: Math.abs(d) }))
            .sort((a, b) => a.m - b.m)
            .slice(0, rehashFlips)
            .map((e) => e.i);
        return idx.map((i) => 1 << i);
    };

    const buckets = hyper.map(() => new Map());
    for (let i = 0; i < bank.length; i++) {
        for (let t = 0; t < tables; t++) {
            const key = keyOf(dotsOf(bank[i], hyper[t]));
            if (!buckets[t].has(key)) buckets[t].set(key, []);
            buckets[t].get(key).push(i);
        }
    }

    let baseHits = 0;
    let mqHits = 0;
    let trueTotal = 0;
    let poolBase = 0;
    let poolMq = 0;
    for (let r = 0; r < reps; r++) {
        const centre = randomUnit(dim, rnd);
        const q = new Float64Array(dim);
        for (let d = 0; d < dim; d++) q[d] = centre[d] + gauss(rnd) * sigma;

        const ranked = bank.map((v, i) => ({ i, s: cosine(q, v) })).sort((a, b) => b.s - a.s);
        const truth = new Set(ranked.slice(0, k).map((e) => e.i));
        trueTotal += k;

        const cand = new Set();
        for (let t = 0; t < tables; t++) {
            const hit = buckets[t].get(keyOf(dotsOf(q, hyper[t])));
            if (hit) for (const i of hit) cand.add(i);
        }

        const mqCand = new Set(cand);
        let cur = q;
        let found = Array.from(cand).map((i) => bank[i]);
        for (let round = 0; round < rounds && found.length > 0; round++) {
            const mod = modifiedQuery(cur, found, { alpha: 1, topK });
            if (mod === cur) break;
            cur = mod;
            for (let t = 0; t < tables; t++) {
                const md = dotsOf(mod, hyper[t]);
                const key = keyOf(md);
                const exact = buckets[t].get(key);
                if (exact) for (const i of exact) mqCand.add(i);
                for (const mask of marginFlips(md)) {
                    const near = buckets[t].get(key ^ mask);
                    if (near) for (const i of near) mqCand.add(i);
                }
            }
            found = Array.from(mqCand).map((i) => bank[i]);
        }

        let bh = 0;
        let mh = 0;
        for (const i of truth) { if (cand.has(i)) bh++; if (mqCand.has(i)) mh++; }
        baseHits += bh;
        mqHits += mh;
        poolBase += cand.size;
        poolMq += mqCand.size;
    }

    return {
        bits, tables, dim, N, k,
        baseRecall: baseHits / trueTotal,
        mqRecall: mqHits / trueTotal,
        poolBase: poolBase / reps,
        poolMq: poolMq / reps,
        gain: (mqHits - baseHits) / trueTotal,
    };
}

export async function run() {
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    // ---- A. centroid algebra (exact) -----------------------------------------
    try {
        const c = normalizedCentroid([[1, 0], [0, 1]]);
        check('normalizedCentroid of orthogonal unit vectors is the diagonal unit vector',
            Math.abs(c[0] - Math.SQRT1_2) < 1e-12 && Math.abs(c[1] - Math.SQRT1_2) < 1e-12,
            `c=[${c[0]},${c[1]}]`);

        const same = normalizedCentroid([[1, 0], [1, 0]]);
        check('normalizedCentroid collapses identical vectors to that direction',
            Math.abs(same[0] - 1) < 1e-12 && Math.abs(same[1]) < 1e-12, `c=[${same[0]},${same[1]}]`);

        check('normalizedCentroid of antipodal vectors is null (zero mean)',
            normalizedCentroid([[1, 0], [-1, 0]]) === null);

        check('normalizedCentroid of an empty / degenerate set is null',
            normalizedCentroid([]) === null && normalizedCentroid(null) === null
            && normalizedCentroid([[0, 0], [0, 0]]) === null);

        const scaleA = normalizedCentroid([[2, 0], [0, 3]]);
        const scaleB = normalizedCentroid([[4, 0], [0, 6]]);
        check('normalizedCentroid is scale invariant', maxDiff(scaleA, scaleB) < 1e-12,
            `diff=${maxDiff(scaleA, scaleB)}`);

        const perm = normalizedCentroid([[0, 3], [2, 0]]);
        check('normalizedCentroid is permutation invariant', maxDiff(scaleA, perm) < 1e-12);

        const rnd = mulberry32(9001);
        const uc = normalizedCentroid(randomSet(7, 24, rnd));
        check('normalizedCentroid is unit norm', Math.abs(norm(uc) - 1) < 1e-12, `norm=${norm(uc)}`);

        const mixed = meanVector([[1, 2], [3, 4, 5], [5, 6]]);
        check('meanVector drops length-mismatched entries',
            !!mixed && mixed.length === 2 && Math.abs(mixed[0] - 3) < 1e-12 && Math.abs(mixed[1] - 4) < 1e-12,
            `mixed=${mixed ? Array.from(mixed) : mixed}`);

        check('normalize is null for zero / empty vectors',
            normalize([0, 0, 0]) === null && normalize([]) === null && normalize(null) === null);
    } catch (e) {
        check('centroid algebra block completed', false, e.stack);
    }

    // ---- B. Theorem 1: the centroid maximises the dot-product sum ------------
    try {
        const rnd = mulberry32(9002);
        const dim = 24;
        const S = randomSet(12, dim, rnd);
        const cen = normalizedCentroid(S);
        const atCen = dotProductSum(cen, S);

        let beaten = 0;
        let best = -Infinity;
        for (let i = 0; i < 400; i++) {
            const u = randomUnit(dim, rnd);
            const s = dotProductSum(u, S);
            best = Math.max(best, s);
            if (s > atCen + 1e-9) beaten++;
        }
        check('Theorem 1: no random direction beats the centroid on sum of dot products',
            beaten === 0, `beaten=${beaten} best=${best} atCen=${atCen}`);

        const sumVec = sumVector(S, dim);
        check('Theorem 1 identity: dotProductSum(<c>, S) equals ||sum x|| exactly',
            Math.abs(atCen - norm(sumVec)) < 1e-9, `atCen=${atCen} normSum=${norm(sumVec)}`);

        const mean = meanVector(S);
        check('Theorem 1 identity: ||sum x|| equals k*||mean|| exactly',
            Math.abs(norm(sumVec) - S.length * norm(mean)) < 1e-9);

        let worst = Infinity;
        for (let r = 0; r < 5; r++) {
            const T = randomSet(10, dim, rnd);
            const tCen = dotProductSum(normalizedCentroid(T), T);
            let tBest = -Infinity;
            for (let i = 0; i < 60; i++) tBest = Math.max(tBest, dotProductSum(randomUnit(dim, rnd), T));
            worst = Math.min(worst, tCen - tBest);
        }
        check('Theorem 1 holds with non-negative margin across 5 random sets', worst >= -1e-9,
            `worst_margin=${worst}`);
    } catch (e) {
        check('Theorem 1 block completed', false, e.stack);
    }

    // ---- C. Theorem 2: the centroid maximises the first-order ACP -------------
    try {
        const rnd = mulberry32(9003);
        const dim = 24;
        const S = randomSet(12, dim, rnd);
        const cen = normalizedCentroid(S);

        const u = randomUnit(dim, rnd);
        check('firstOrderCollisionProbability has the exact 1/2 + dotProductSum/(k pi) form',
            Math.abs(firstOrderCollisionProbability(u, S)
                - (0.5 + dotProductSum(u, S) / (S.length * Math.PI))) < 1e-12);

        const atCen = firstOrderCollisionProbability(cen, S);
        let beaten = 0;
        for (let i = 0; i < 400; i++) {
            if (firstOrderCollisionProbability(randomUnit(dim, rnd), S) > atCen + 1e-12) beaten++;
        }
        check('Theorem 2: no random direction beats the centroid on first-order ACP',
            beaten === 0, `beaten=${beaten} atCen=${atCen}`);

        const acpCen = averageCollisionProbability(cen, S);
        let sumAcp = 0;
        const trials = 400;
        for (let i = 0; i < trials; i++) sumAcp += averageCollisionProbability(randomUnit(dim, rnd), S);
        check('the centroid beats the AVERAGE random direction on the exact (not just first-order) ACP',
            acpCen > sumAcp / trials, `centroid=${acpCen} randomMean=${sumAcp / trials}`);
    } catch (e) {
        check('Theorem 2 block completed', false, e.stack);
    }

    // ---- D. Appendix C.1: minimal average residual covariance ----------------
    try {
        const rnd = mulberry32(9004);
        const dim = 24;
        const S = randomSet(12, dim, rnd);
        const cen = normalizedCentroid(S);
        const atCen = averageCovariance(cen, S);

        let beaten = 0;
        for (let i = 0; i < 400; i++) {
            if (averageCovariance(randomUnit(dim, rnd), S) < atCen - 1e-9) beaten++;
        }
        check('Appendix C.1: no random direction beats the centroid on average residual covariance',
            beaten === 0, `beaten=${beaten} atCen=${atCen}`);

        // cov(u, S) = (1/k^2) sum_i sum_j x_i.x_j - ((sum_i x_i.u)/k)^2.
        let c0 = 0;
        for (const x of S) for (const y of S) c0 += dot(x, y);
        c0 /= S.length * S.length;
        const u = randomUnit(dim, rnd);
        const predicted = c0 - Math.pow(dotProductSum(u, S) / S.length, 2);
        check('the covariance objective is exactly const - ((sum x.u)/k)^2',
            Math.abs(averageCovariance(u, S) - predicted) < 1e-9,
            `measured=${averageCovariance(u, S)} predicted=${predicted}`);
    } catch (e) {
        check('Appendix C.1 block completed', false, e.stack);
    }

    // ---- E. Section 6.4: the centroid never hashes into the void -------------
    try {
        const rnd = mulberry32(9005);
        const dim = 24;
        const dirs = [];
        for (let i = 0; i < 200; i++) dirs.push(randomUnit(dim, rnd));

        // A tight neighbourhood: every member within a tiny angle of `base`.
        const base = randomUnit(dim, rnd);
        const tight = [];
        for (let i = 0; i < 6; i++) {
            const v = new Float64Array(dim);
            for (let d = 0; d < dim; d++) v[d] = base[d] + 0.02 * gauss(rnd);
            tight.push(normalize(v));
        }
        let centroidFails = 0;
        for (const w of dirs) if (!centroidCollidesWithSet(tight, w)) centroidFails++;
        check('Section 6.4: the centroid collides with some set member on every direction (200 directions)',
            centroidFails === 0, `fails=${centroidFails}`);

        // The opposing raw query shares NO member's bit on any direction: the
        // paper's hash-failure case, exhibited exactly with a singleton set
        // S = {x}, q = -x (sign(-x.w) = -sign(x.w) for every non-orthogonal w).
        let exactFails = 0;
        for (const w of dirs) if (!collidesWithSet(negate(base), [base], w)) exactFails++;
        check('Section 6.4: an opposing raw query collides with NO member (exact singleton witness)',
            exactFails === dirs.length, `fails=${exactFails}/${dirs.length}`);

        // On the tight (non-degenerate) set the centroid still scores a full
        // sweep while the opposing query misses on every direction whose
        // |base . w| exceeds the neighbourhood's angular spread — a majority.
        const opposing = negate(base);
        let queryFails = 0;
        for (const w of dirs) if (!collidesWithSet(opposing, tight, w)) queryFails++;
        check('Section 6.4: the opposing query still fails on a majority of directions (hash failure)',
            queryFails >= dirs.length / 2, `fails=${queryFails}/${dirs.length}`);

        check('centroid collision coverage is the full sweep; the opposing query covers at most half',
            collisionCoverage(normalizedCentroid(tight), tight, dirs) === dirs.length
            && collisionCoverage(opposing, tight, dirs) <= dirs.length / 2);

        // A general random (set, query, direction) trio still exhibits failures.
        let randomFails = 0;
        for (let i = 0; i < 400; i++) {
            const T = randomSet(3, 16, rnd);
            const q = randomUnit(16, rnd);
            const w = randomUnit(16, rnd);
            if (!collidesWithSet(q, T, w)) randomFails++;
        }
        check('random queries still exhibit hash-failure cases', randomFails > 0, `fails=${randomFails}/400`);
    } catch (e) {
        check('Section 6.4 block completed', false, e.stack);
    }

    // ---- F. Charikar's collision law (definitional Monte Carlo) ---------------
    try {
        const rnd = mulberry32(9006);
        const dim = 16;
        const a = randomUnit(dim, rnd);
        const b = randomUnit(dim, rnd);
        const predicted = collisionProbability(a, b);
        const cos = cosine(a, b);

        let collided = 0;
        const trials = 40000;
        for (let i = 0; i < trials; i++) {
            const w = randomUnit(dim, rnd);
            if (signBit(dot(a, w)) === signBit(dot(b, w))) collided++;
        }
        check('measured random-hyperplane agreement matches 1 - arccos(cos)/pi (< 0.01)',
            Math.abs(collided / trials - predicted) < 0.01,
            `measured=${collided / trials} predicted=${predicted} cos=${cos}`);

        check('collisionProbabilityFromCos(1) is exactly 1 (a point with itself)',
            Math.abs(collisionProbabilityFromCos(1) - 1) < 1e-12);

        check('collisionProbabilityFromCos clamps out-of-range cosines',
            collisionProbabilityFromCos(2) === collisionProbabilityFromCos(1)
            && collisionProbabilityFromCos(-2) === collisionProbabilityFromCos(-1));

        const S = randomSet(12, dim, rnd);
        const cen = normalizedCentroid(S);
        check('the centroid has a higher exact ACP against its own set than the query average',
            averageCollisionProbability(cen, S)
            > averageCollisionProbability(randomUnit(dim, rnd), S));
    } catch (e) {
        check('Charikar law block completed', false, e.stack);
    }

    // ---- G. building the modified query --------------------------------------
    try {
        const cfg = resolveQueryModConfig();
        check('resolveQueryModConfig returns the frozen defaults',
            cfg.alpha === DEFAULT_QUERYMOD_CONFIG.alpha && cfg.topK === DEFAULT_QUERYMOD_CONFIG.topK
            && cfg.rounds === DEFAULT_QUERYMOD_CONFIG.rounds && cfg.maxFlips === DEFAULT_QUERYMOD_CONFIG.maxFlips
            && cfg.probeBudget === DEFAULT_QUERYMOD_CONFIG.probeBudget);

        const clamped = resolveQueryModConfig({ alpha: 5, topK: 3.7, rounds: 0, maxFlips: 20, probeBudget: -5 });
        check('resolveQueryModConfig clamps every field into range',
            clamped.alpha === 1 && clamped.topK === 3 && clamped.rounds === 1
            && clamped.maxFlips === 8 && clamped.probeBudget === 0, JSON.stringify(clamped));

        const fallback = resolveQueryModConfig({ alpha: 'x', topK: NaN });
        check('resolveQueryModConfig falls back on non-finite input',
            fallback.alpha === DEFAULT_QUERYMOD_CONFIG.alpha && fallback.topK === DEFAULT_QUERYMOD_CONFIG.topK);

        const rnd = mulberry32(9007);
        const dim = 24;
        const S = randomSet(8, dim, rnd);
        const q = randomUnit(dim, rnd);

        check('modifiedQuery with alpha 0 returns the same reference (a no-op)',
            modifiedQuery(q, S, { alpha: 0 }) === q);
        check('modifiedQuery with no candidates returns the same reference',
            modifiedQuery(q, [], { alpha: 1 }) === q);
        check('modifiedQuery with a non-vector query is a no-op',
            modifiedQuery(null, S) === null);

        const top2 = selectCandidates(q, S, 2);
        const ranked = S.map((v) => ({ v, s: cosine(q, v) })).sort((x, y) => y.s - x.s).slice(0, 2);
        check('selectCandidates returns the topK closest to the query, in order',
            top2.length === 2 && top2[0] === ranked[0].v && top2[1] === ranked[1].v);

        check('selectCandidates with topK >= size returns the whole list',
            selectCandidates(q, S, S.length).length === S.length
            && selectCandidates(q, S, 0).length === S.length);

        const cen = normalizedCentroid(S);
        check('modifiedQuery alpha 1 / topK 0 equals the full centroid exactly',
            maxDiff(modifiedQuery(q, S, { alpha: 1, topK: 0 }), cen) < 1e-12);
        check('modifiedQuery honours topK (centroid of the closest subset)',
            maxDiff(modifiedQuery(q, S, { alpha: 1, topK: 2 }), normalizedCentroid(top2)) < 1e-12);
        check('a blended modified query is unit norm',
            Math.abs(norm(modifiedQuery(q, S, { alpha: 0.5 })) - 1) < 1e-12);
        check('alpha is clamped: 5 behaves as 1 and 0.5 as 0.5',
            maxDiff(modifiedQuery(q, S, { alpha: 5 }), modifiedQuery(q, S, { alpha: 1 })) < 1e-12
            && maxDiff(modifiedQuery(q, S, { alpha: 0.5 }), cen) > 1e-6);

        check('blendVectors rejects mismatched lengths, returns null',
            blendVectors([1, 0], [1, 0, 0], 0.5) === null);

        const gain = queryModificationGain(q, S, { alpha: 1 });
        check('queryModificationGain is non-negative against a real candidate set',
            gain >= -1e-12, `gain=${gain}`);
    } catch (e) {
        check('modified-query block completed', false, e.stack);
    }

    // ---- H. the denoising law (Monte Carlo) ----------------------------------
    try {
        const rnd = mulberry32(9008);
        const dim = 71;
        const sigma = 0.3;
        const x = randomUnit(dim, rnd);
        const dirs = [];
        for (let i = 0; i < 300; i++) dirs.push(randomUnit(dim, rnd));

        const views = [];
        for (let i = 0; i < 40; i++) {
            const v = new Float64Array(dim);
            for (let d = 0; d < dim; d++) v[d] = x[d] + gauss(rnd) * sigma;
            views.push(v);
        }

        const errorRate = (u) => {
            let bad = 0;
            for (const w of dirs) if (signBit(dot(u, w)) !== signBit(dot(x, w))) bad++;
            return bad / dirs.length;
        };
        const single = errorRate(views[0]);
        const cen40 = errorRate(normalizedCentroid(views));
        const cen8 = errorRate(normalizedCentroid(views.slice(0, 8)));

        check('denoising: the centroid of the noisy views has a lower per-bit error rate than a single view',
            cen40 < single, `single=${single} centroid40=${cen40}`);
        check('denoising: the error rate shrinks with more views',
            cen40 <= cen8 + 1e-9, `centroid8=${cen8} centroid40=${cen40}`);
        check('denoising: the 40-view centroid cuts the error rate several-fold',
            cen40 < single * 0.6, `single=${single} centroid40=${cen40} ratio=${cen40 / single}`);
        check('denoising: the centroid is closer to the truth in cosine than a single view',
            cosine(normalizedCentroid(views), x) > cosine(views[0], x),
            `centroid=${cosine(normalizedCentroid(views), x)} single=${cosine(views[0], x)}`);
    } catch (e) {
        check('denoising block completed', false, e.stack);
    }

    // ---- I. synthetic regime: when does query modification pay? ---------------
    // A random-hyperplane index with a controlled hash width. The modified query
    // is looked up by its exact bucket plus the two lowest-margin bit flips. The
    // measured pattern — a strict gain while the word is informative, decaying to
    // nothing as the word narrows — is what explains the zero gain on the real
    // 107-bit index (lsh.test.js section J): there the exact buckets are nearly
    // empty, so the consensus word is in an empty bucket and nothing is added.
    try {
        const bitsSweep = [6, 8, 10, 12, 16, 20, 24];
        const sweep = bitsSweep.map((bits) => syntheticExperiment({
            bits, tables: 4, dim: 8, N: 200, k: 8, sigma: 0.5, rehashFlips: 2, seed: 5,
        }));
        check('SWEEP', true, JSON.stringify(sweep));

        const low = sweep.filter((r) => r.bits <= 12);
        check('query modification strictly raises pool recall while the hash is informative (bits <= 12)',
            low.every((r) => r.mqRecall > r.baseRecall + 0.02),
            JSON.stringify(low.map((r) => [r.bits, r.baseRecall, r.mqRecall])));

        let monotone = true;
        for (let i = 1; i < sweep.length; i++) if (sweep[i].gain > sweep[i - 1].gain + 1e-9) monotone = false;
        check('the query-modification gain decays monotonically as the hash narrows',
            monotone, JSON.stringify(sweep.map((r) => [r.bits, r.gain])));

        const wide = sweep[sweep.length - 1];
        check('at a very wide hash the gain vanishes (empty-consensus-bucket regime, 24 bits)',
            wide.gain <= 0.005, `bits=${wide.bits} gain=${wide.gain}`);

        check('the modified-query pool is never smaller than the baseline pool',
            sweep.every((r) => r.poolMq >= r.poolBase - 1e-9));

        const sigmaSweep = [0.3, 0.5, 0.7].map((sigma) => syntheticExperiment({
            bits: 10, tables: 4, dim: 8, N: 200, k: 8, sigma, rehashFlips: 2, seed: 5,
        }));
        check('the gain is robust across query noise levels at bits=10',
            sigmaSweep.every((r) => r.mqRecall > r.baseRecall + 0.02),
            JSON.stringify(sigmaSweep.map((r) => [r.baseRecall, r.mqRecall])));
    } catch (e) {
        check('synthetic-regime block completed', false, e.stack);
    }

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
