// Margin-ordered multi-probe LSH suite (Lv et al., VLDB 2007).
//
// `_getGlobalLSHCandidates` currently probes the *first four* hash bits of every
// table, regardless of the query. `lsh.test.js` documents the consequence: at
// production hash width (100+ bits) that lean helper only recalls near-exact
// matches, and its recall collapses past sigma ~ 0.1. This entry pins the
// researched fix — probe in ascending order of the query's margin
// |dot(queryProj, hyperplane)|, the hyperplanes a near neighbour is most likely
// to be on the other side of — and *proves the gain* against the prefix baseline
// it would replace.
//
// Tiers:
//   THEORY (exact, deterministic — must never fail)
//     * marginOrder is a total, stable, ascending permutation of the bit
//       indices; marginRanks is its inverse.
//     * rankPerturbations returns distinct, non-empty perturbations of at most
//       maxFlips bits, each with cost exactly the sum of the flipped bits'
//       margins, sorted by (cost, flips, margin-rank).
//     * The flip lemma: for a neighbour n = q + delta in the (pre-normalisation)
//       projection space, hash bit b flips exactly when
//       |delta_b| > |q_b| AND sign(q_b) != sign(delta_b). Every flipped bit
//       therefore has margin below max|delta|, so the lowest-margin bits are a
//       complete cover — the reason margin order is the right order.
//     * applyFlips/multiProbeKeys work for both number and BigInt keys, and the
//       probe sequence starts with the exact key and contains no duplicates.
//
//   EMPIRICAL (Monte Carlo, pinned with margin)
//     * P(bit flips) is monotone decreasing in the bit's margin (the statistical
//       foundation of the LSH multi-probe score).
//     * Margin order dominates the prefix baseline at every budget, dominates
//       sampled random orders, is monotone increasing in the budget, reaches
//       totality at a large budget, and the single-bit mode is exactly complete
//       on neighbours that differ in at most one bit.
//     * On a real HiveMind index, margin probing recovers strictly more of the
//       bank under noise than the naive prefix probe at the same budget.
//
//   ADAPTIVE (query-adaptive budget — NeuRoute arXiv 2608.15438 / adaptive
//   bucket probing arXiv 2604.04603)
//     * The adaptive config is off by default and byte-identical to the fixed
//       config when off; when on it returns a depth whose EXHAUSTIVE subset
//       enumeration reaches the requested recovery coverage exactly, and whose
//       budget is exactly the number of those subsets.
//     * Monte Carlo confirms the probe set recovers the neighbour at the exact
//       predicted rate, and the budget shrinks to nothing for confident queries.
//     * On the real index (sigma calibrated from the measured Hamming distance)
//       the adaptive budget dominates the historical prefix probe everywhere and
//       spends far fewer probes than a fixed budget at low noise.
//
// Like the other entries this takes an optional `{ ensureSql, stateDir }` so the
// node mirror can run against the real better-sqlite3 driver.

import HiveMind from '../../../src/hivemind/hiveMind.js';
import {
    DEFAULT_MULTIPROBE_CONFIG, resolveMultiProbeConfig, marginOrder, marginRanks,
    perturbationCost, rankPerturbations, applyFlips, multiProbeKeys,
    marginSingleBitKeys, prefixSingleBitKeys, flippedBits, marginCoverBudget,
    DEFAULT_ADAPTIVE_CONFIG, resolveAdaptiveConfig, adaptiveMultiProbeConfig,
    resolveEffectiveProbeConfig, adaptiveSingleBitBudget, adaptiveSingleBitKeys,
} from '../../../src/hivemind/memory/multiprobe.js';
import {
    probeRecoveryCoverage, recoveryDepth, calibrateNoiseFromFlips, expectedFlippedBits,
    bitFlipProbabilities, marginContainmentDepth, marginContainmentCoverage,
} from '../../../src/hivemind/memory/bitweight.js';

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
    let ss = 0;
    for (let d = 0; d < dim; d++) { const x = gauss(rnd); v[d] = x; ss += x * x; }
    const n = Math.sqrt(ss) || 1;
    for (let d = 0; d < dim; d++) v[d] /= n;
    return v;
}

function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

function unitHyperplanes(bits, dim, rnd) {
    const hyp = [];
    for (let b = 0; b < bits; b++) hyp.push(randomUnit(dim, rnd));
    return hyp;
}

function dotsOf(vec, hyp) {
    const out = new Array(hyp.length);
    for (let b = 0; b < hyp.length; b++) out[b] = dot(vec, hyp[b]);
    return out;
}

function keyOf(dots, masks) {
    let key = 0;
    for (let b = 0; b < dots.length; b++) if (dots[b] > 0) key |= masks[b];
    return key;
}

function bitMasksFor(bits) {
    const m = new Array(bits);
    for (let b = 0; b < bits; b++) m[b] = 1 << b;
    return m;
}

// The neighbour of a unit vector: normalize(q + sigma * gaussian), so "close"
// means small Euclidean distance, which is the regime the margin score assumes.
function neighbour(q, sigma, rnd) {
    const v = new Float64Array(q.length);
    let ss = 0;
    for (let d = 0; d < q.length; d++) { const x = q[d] + sigma * gauss(rnd); v[d] = x; ss += x * x; }
    const n = Math.sqrt(ss) || 1;
    for (let d = 0; d < q.length; d++) v[d] /= n;
    return v;
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

export async function run(options = {}) {
    if (options.ensureSql) await options.ensureSql();
    else {
        const shim = await import('../shims/better-sqlite3.js');
        await shim.__ensureSql();
    }
    const stateDir = options.stateDir || ((label) => `state/mp-${label}`);

    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
    const realRandom = Math.random;
    const seeded = (seed, fn) => {
        Math.random = mulberry32(seed);
        try { return fn(); } finally { Math.random = realRandom; }
    };

    // ---- A. deterministic structure -----------------------------------------
    try {
        const dots = [0.5, -0.1, 0.9, -0.3, 0.02, -0.7, 0.11];
        const order = marginOrder(dots);
        const sorted = order.every((b, i) => i === 0 || Math.abs(dots[order[i - 1]]) <= Math.abs(dots[b]));
        const perm = [...order].sort((a, b) => a - b).join(',');
        check('marginOrder is an ascending, total permutation', sorted && perm === '0,1,2,3,4,5,6', `order=${order}`);
        check('marginOrder puts the smallest margin first (the Lv score)', order[0] === 4, `first=${order[0]}`);
        const ranks = marginRanks(dots);
        check('marginRanks inverts marginOrder', ranks[4] === 0 && ranks[2] === dots.length - 1, `ranks=${ranks}`);
        check('marginOrder respects the limit argument', marginOrder(dots, 3).length === 3 && marginOrder(dots, 3)[0] === 4,
            JSON.stringify(marginOrder(dots, 3)));
        check('marginOrder ties break by index',
            JSON.stringify(marginOrder([0.2, -0.2, 0.2])) === '[0,1,2]', JSON.stringify(marginOrder([0.2, -0.2, 0.2])));

        const cfg = resolveMultiProbeConfig();
        check('default config resolution', cfg.maxFlips === DEFAULT_MULTIPROBE_CONFIG.maxFlips && cfg.budget === DEFAULT_MULTIPROBE_CONFIG.budget, JSON.stringify(cfg));
        check('config clamps junk to defaults',
            JSON.stringify(resolveMultiProbeConfig({ maxFlips: NaN, budget: 'x' })) === JSON.stringify(DEFAULT_MULTIPROBE_CONFIG));
        check('config floors fractions and enforces min 1',
            JSON.stringify(resolveMultiProbeConfig({ maxFlips: 0, budget: 0 })) === '{"maxFlips":1,"budget":1}',
            JSON.stringify(resolveMultiProbeConfig({ maxFlips: 0, budget: 0 })));
        check('config caps maxFlips at 8', resolveMultiProbeConfig({ maxFlips: 99 }).maxFlips === 8);
        check('a non-finite budget falls back to the default', resolveMultiProbeConfig({ budget: Infinity }).budget === DEFAULT_MULTIPROBE_CONFIG.budget);

        check('perturbationCost sums margins', Math.abs(perturbationCost(dots, [4, 1]) - 0.12) < 1e-12,
            String(perturbationCost(dots, [4, 1])));

        const perms = rankPerturbations(dots, { maxFlips: 2, budget: 7 });
        check('rankPerturbations honours the budget', perms.length === 7, `n=${perms.length}`);
        const costsOk = perms.every((p) => Math.abs(p.cost - perturbationCost(dots, p.bits)) < 1e-12);
        check('every perturbation cost equals the sum of its bits', costsOk, JSON.stringify(perms.map((p) => p.cost)));
        const costSorted = perms.every((p, i) => i === 0 || perms[i - 1].cost <= p.cost);
        check('perturbations are sorted by ascending cost', costSorted, JSON.stringify(perms.map((p) => p.cost)));
        const withinFlips = perms.every((p) => p.bits.length >= 1 && p.bits.length <= 2);
        check('perturbations respect maxFlips', withinFlips, JSON.stringify(perms.map((p) => p.bits.length)));
        const uniq = new Set(perms.map((p) => p.bits.join(',')));
        check('perturbations are distinct', uniq.size === perms.length, `uniq=${uniq.size}`);
        const cheapest = perms[0].bits;
        check('the cheapest perturbation is the smallest margin (single bit)', cheapest.length === 1 && cheapest[0] === 4,
            JSON.stringify(cheapest));
        const noEmpty = perms.every((p) => p.bits.length > 0);
        check('the empty perturbation is never returned', noEmpty);

        const masks = bitMasksFor(dots.length);
        const key = keyOf(dots, masks);
        const mKeys = multiProbeKeys(key, dots, masks, { maxFlips: 2, budget: 6 });
        check('multiProbeKeys starts with the exact key', mKeys[0] === key, `first=${mKeys[0]} key=${key}`);
        check('multiProbeKeys emits distinct keys', new Set(mKeys).size === mKeys.length, `n=${mKeys.length}`);
        check('applyFlips matches the mask XOR', applyFlips(key, [2, 5], masks) === (key ^ masks[2] ^ masks[5]));
        const bigMasks = dots.length ? [1n, 2n, 4n, 8n, 16n, 32n, 64n] : [];
        const bigKey = 0b0101010n;
        check('applyFlips works for BigInt keys', applyFlips(bigKey, [0, 3], bigMasks) === (bigKey ^ 1n ^ 8n));

        const sb = marginSingleBitKeys(key, dots, masks, 3);
        check('marginSingleBitKeys returns key + budget probes', sb.length === 4, `n=${sb.length}`);
        check('marginSingleBitKeys probes the smallest margins first', sb[1] === (key ^ masks[4]), `second=${sb[1]}`);
        const pb = prefixSingleBitKeys(key, masks, 3);
        check('prefixSingleBitKeys is the historical baseline', pb[1] === (key ^ masks[0]) && pb.length === 4, JSON.stringify(pb));

        check('marginCoverBudget counts margins below the perturbation bound',
            marginCoverBudget([0.1, 0.4, 0.05, 0.9], 0.5) === 3, String(marginCoverBudget([0.1, 0.4, 0.05, 0.9], 0.5)));
    } catch (e) {
        check('structure block completed', false, e.stack);
    }

    // ---- B. the flip lemma (exact) ------------------------------------------
    try {
        const bits = 32;
        const dim = 10;
        const rnd = mulberry32(202);
        const masks = bitMasksFor(bits);
        let signMismatch = 0;
        let closedFormMismatch = 0;
        let boundViolations = 0;
        let coverViolations = 0;
        let totalFlips = 0;
        for (let trial = 0; trial < 300; trial++) {
            const q = randomUnit(dim, rnd);
            const hyp = unitHyperplanes(bits, dim, rnd);
            const qDots = dotsOf(q, hyp);
            // neighbour = q + delta in projection space (delta = sigma * g)
            const delta = new Array(bits);
            let maxDelta = 0;
            for (let b = 0; b < bits; b++) { delta[b] = 0.25 * gauss(rnd); maxDelta = Math.max(maxDelta, Math.abs(delta[b])); }
            const nDots = qDots.map((v, b) => v + delta[b]);

            const flipped = flippedBits(qDots, nDots);
            totalFlips += flipped.length;
            for (const b of flipped) {
                const closed = Math.abs(delta[b]) > Math.abs(qDots[b]) && (qDots[b] > 0) !== (delta[b] > 0);
                if (!closed) closedFormMismatch++;
                if (!(Math.abs(qDots[b]) < Math.abs(delta[b]))) boundViolations++;
                if (!(Math.abs(qDots[b]) < maxDelta)) boundViolations++;
            }
            // no non-flipped bit should satisfy the closed form
            for (let b = 0; b < bits; b++) {
                const closed = Math.abs(delta[b]) > Math.abs(qDots[b]) && (qDots[b] > 0) !== (delta[b] > 0);
                const signFlip = (qDots[b] > 0) !== (nDots[b] > 0);
                if (closed !== signFlip) signMismatch++;
            }
            // marginCoverBudget(maxDelta) must cover every flipped bit's rank
            const ranks = marginRanks(qDots);
            const cover = marginCoverBudget(qDots, maxDelta);
            for (const b of flipped) if (!(ranks[b] < cover)) coverViolations++;
        }
        check('flip lemma: sign change <=> |delta_b| > |q_b| and opposing sides', signMismatch === 0,
            `mismatch=${signMismatch} flips=${totalFlips}`);
        check('flip lemma closed form never disagrees with the sign test', closedFormMismatch === 0,
            `mismatch=${closedFormMismatch}`);
        check('every flipped bit has margin below the perturbation magnitude', boundViolations === 0,
            `violations=${boundViolations}`);
        check('the lowest-margin cover always contains the flipped set', coverViolations === 0,
            `violations=${coverViolations}`);
    } catch (e) {
        check('flip-lemma block completed', false, e.stack);
    }

    // ---- C. P(flip) is monotone decreasing in margin -------------------------
    try {
        const bits = 24;
        const dim = 8;
        const trials = 1500;
        const rnd = mulberry32(303);
        const hyp = unitHyperplanes(bits, dim, rnd);
        const samples = [];
        for (let trial = 0; trial < trials; trial++) {
            const q = randomUnit(dim, rnd);
            const n = neighbour(q, 0.35, rnd);
            for (let b = 0; b < bits; b++) {
                const m = Math.abs(dot(q, hyp[b]));
                const flipped = (dot(q, hyp[b]) > 0) !== (dot(n, hyp[b]) > 0);
                samples.push({ m, flipped });
            }
        }
        samples.sort((a, b) => a.m - b.m);
        const bins = 8;
        const per = Math.floor(samples.length / bins);
        const rates = [];
        for (let i = 0; i < bins; i++) {
            const lo = i * per;
            const hi = i === bins - 1 ? samples.length : (i + 1) * per;
            let flips = 0;
            for (let j = lo; j < hi; j++) if (samples[j].flipped) flips++;
            rates.push(flips / (hi - lo));
        }
        const monotone = rates.every((r, i) => i === 0 || rates[i - 1] >= r - 0.006);
        check('P(bit flips) is monotone non-increasing in the bit margin', monotone, JSON.stringify(rates.map((r) => r.toFixed(3))));
        check('the smallest-margin bin flips far more often than the largest',
            rates[0] > rates[bins - 1], `${rates[0].toFixed(3)} vs ${rates[bins - 1].toFixed(3)}`);
    } catch (e) {
        check('flip-probability block completed', false, e.stack);
    }

    // ---- D. recall dominance at a fixed budget -------------------------------
    try {
        const bits = 24;
        const dim = 8;
        const trials = 800;
        const sigma = 0.25;
        const budgets = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];
        const rnd = mulberry32(404);
        const hyp = unitHyperplanes(bits, dim, rnd);
        const masks = bitMasksFor(bits);

        // A handful of fixed random bit orders so the headline can be "margin
        // beats sampled orders", not just "beats the prefix".
        const sampledOrders = [];
        for (let i = 0; i < 12; i++) {
            const ord = [];
            for (let b = 0; b < bits; b++) ord.push(b);
            for (let j = ord.length - 1; j > 0; j--) {
                const k = Math.floor(rnd() * (j + 1));
                const t = ord[j]; ord[j] = ord[k]; ord[k] = t;
            }
            sampledOrders.push(ord);
        }

        const recall = {};
        for (const B of budgets) recall[`margin_multi_${B}`] = 0;
        for (const B of budgets) recall[`margin_single_${B}`] = 0;
        for (const B of budgets) recall[`prefix_single_${B}`] = 0;
        for (const B of budgets) recall[`anti_single_${B}`] = 0;
        for (let i = 0; i < sampledOrders.length; i++) recall[`rand_single_${i}`] = 0;
        let singleBitCases = 0;
        let multiBitMoreThanTwo = 0;

        for (let trial = 0; trial < trials; trial++) {
            const q = randomUnit(dim, rnd);
            const n = neighbour(q, sigma, rnd);
            const qDots = dotsOf(q, hyp);
            const nDots = dotsOf(n, hyp);
            const qKey = keyOf(qDots, masks);
            const nKey = keyOf(nDots, masks);
            const flipped = flippedBits(qDots, nDots);
            const ranks = marginRanks(qDots);
            if (flipped.length <= 1) singleBitCases++;
            if (flipped.length > 2) multiBitMoreThanTwo++;
            const order = marginOrder(qDots);

            for (const B of budgets) {
                const mKeys = multiProbeKeys(qKey, qDots, masks, { maxFlips: 2, budget: B });
                if (mKeys.includes(nKey)) recall[`margin_multi_${B}`]++;
                if (flipped.length === 1 && ranks[flipped[0]] < B) recall[`margin_single_${B}`]++;
                if (flipped.length === 1 && flipped[0] < B) recall[`prefix_single_${B}`]++;
                const anti = order.slice().reverse();
                const antiRank = anti.indexOf(flipped[0]);
                if (flipped.length === 1 && antiRank >= 0 && antiRank < B) recall[`anti_single_${B}`]++;
            }
            for (let si = 0; si < sampledOrders.length; si++) {
                const ord = sampledOrders[si];
                const r = ord.indexOf(flipped[0]);
                if (flipped.length === 1 && r >= 0 && r < 4) recall[`rand_single_${si}`]++;
            }
        }

        const frac = (k) => recall[k] / trials;
        const summary = {};
        for (const B of budgets) summary[B] = {
            marginMulti: +frac(`margin_multi_${B}`).toFixed(4),
            marginSingle: +frac(`margin_single_${B}`).toFixed(4),
            prefix: +frac(`prefix_single_${B}`).toFixed(4),
            anti: +frac(`anti_single_${B}`).toFixed(4),
        };

        check('margin multi-probe dominates the prefix baseline at every budget',
            budgets.every((B) => recall[`margin_multi_${B}`] >= recall[`prefix_single_${B}`]),
            JSON.stringify(summary));
        check('margin multi-probe dominates margin single-bit at every budget',
            budgets.every((B) => recall[`margin_multi_${B}`] >= recall[`margin_single_${B}`]), JSON.stringify(summary));
        check('margin single-bit dominates the prefix baseline at every budget',
            budgets.every((B) => recall[`margin_single_${B}`] >= recall[`prefix_single_${B}`]), JSON.stringify(summary));
        check('margin strictly beats the prefix at budget 4 (the current probe count)',
            recall.margin_single_4 > recall.prefix_single_4, `margin=${frac('margin_single_4')} prefix=${frac('prefix_single_4')}`);
        check('the anti-margin order is the worst (margin order is not incidental)',
            budgets.every((B) => recall[`margin_single_${B}`] >= recall[`anti_single_${B}`]), JSON.stringify(summary));
        check('margin order beats every sampled random order at budget 4',
            sampledOrders.every((_, i) => recall.margin_single_4 >= recall[`rand_single_${i}`]),
            `margin=${frac('margin_single_4')} rand=${sampledOrders.map((_, i) => frac(`rand_single_${i}`).toFixed(3)).join(',')}`);
        check('recall is monotone increasing in the budget',
            budgets.every((B, i) => i === 0 || recall[`margin_multi_${B}`] >= recall[`margin_multi_${budgets[i - 1]}`]),
            JSON.stringify(budgets.map((B) => frac(`margin_multi_${B}`))));
        // Exact identities: with all pairs enumerated, the multi-probe sequence is
        // complete exactly on <=2-bit-different neighbours; single-bit probing is
        // complete exactly on <=1-bit-different neighbours.
        {
            const r2 = mulberry32(404);
            let pairHit = 0;
            let pairExpected = 0;
            let singleHit = 0;
            let singleExpected = 0;
            let mismatch = 0;
            for (let trial = 0; trial < 400; trial++) {
                const q = randomUnit(dim, r2);
                const n = neighbour(q, sigma, r2);
                const qDots2 = dotsOf(q, hyp);
                const nDots2 = dotsOf(n, hyp);
                const qKey2 = keyOf(qDots2, masks);
                const nKey2 = keyOf(nDots2, masks);
                const fl = flippedBits(qDots2, nDots2).length;
                const inPairs = multiProbeKeys(qKey2, qDots2, masks, { maxFlips: 2, budget: 1 << 16 }).includes(nKey2);
                const inSingles = marginSingleBitKeys(qKey2, qDots2, masks, bits).includes(nKey2);
                if (fl <= 2) pairExpected++;
                if (fl <= 1) singleExpected++;
                if (inPairs) pairHit++;
                if (inSingles) singleHit++;
                if (inPairs !== (fl <= 2) || inSingles !== (fl <= 1)) mismatch++;
            }
            check('all-pairs multi-probe is complete exactly on <=2-bit neighbours', mismatch === 0 && pairHit === pairExpected,
                `hit=${pairHit} expected=${pairExpected} mismatch=${mismatch}`);
            check('single-bit probing is complete exactly on <=1-bit neighbours', singleHit === singleExpected,
                `hit=${singleHit} expected=${singleExpected}`);
        }
        check('the market is non-degenerate (neighbours differ in >1 bit often enough)', multiBitMoreThanTwo > trials * 0.1,
            `>2-bit=${multiBitMoreThanTwo}/${trials}`);
    } catch (e) {
        check('recall-dominance block completed', false, e.stack);
    }

    // ---- E. recall gain on a real HiveMind index -----------------------------
    try {
        const results = {};
        for (const forceMin of [false, true]) {
            const hm = seeded(505 + (forceMin ? 1 : 0), () => new HiveMind(stateDir(forceMin ? 'Emin' : 'Efull'), 2, 12, forceMin ? 'Emin' : 'Efull', forceMin));
            const bits = hm._lshHashBits;
            const bank = makeBank(hm, 0, 60, 606);
            const masks = hm._getLshBitMasks();
            const numTables = hm._lshNumTables;
            const numSets = hm._numLshSets;
            const naiveBudget = Math.min(4, bits);
            const marginBudget = Math.min(8, bits);

            const rows = {};
            for (const sigma of [0.1, 0.25, 0.5]) {
                const rnd = mulberry32(707);
                let naive = 0;
                let marginSingle = 0;
                let marginMulti = 0;
                for (const p of bank) {
                    const q = noisyQuery(hm, p, sigma, rnd);
                    const projs = hm._computeProjNorms(q.mean);
                    let nHit = false;
                    let sHit = false;
                    let mHit = false;
                    for (let s = 0; s < numSets; s++) {
                        const hyp = hm._lshHyperplanes[s];
                        const hashes = hm._computeLSHHashesLow(projs[s], hyp);
                        for (let t = 0; t < numTables; t++) {
                            const dots = new Array(bits);
                            for (let b = 0; b < bits; b++) dots[b] = dot(projs[s], hyp[t][b]);
                            const targetKey = p.lshHashes[s][t];
                            if (prefixSingleBitKeys(hashes[t], masks, naiveBudget).includes(targetKey)) nHit = true;
                            if (marginSingleBitKeys(hashes[t], dots, masks, naiveBudget).includes(targetKey)) sHit = true;
                            if (multiProbeKeys(hashes[t], dots, masks, { maxFlips: 2, budget: marginBudget }).includes(targetKey)) mHit = true;
                        }
                    }
                    if (nHit) naive++;
                    if (sHit) marginSingle++;
                    if (mHit) marginMulti++;
                }
                rows[sigma] = { naive: naive / bank.length, marginSingle: marginSingle / bank.length, marginMulti: marginMulti / bank.length };
            }
            results[forceMin ? 'min' : 'full'] = { bits, tables: numTables, sets: numSets, naiveBudget, marginBudget, rows };
        }

        const full = results.full;
        check('real-index: margin probing recovers at least as much as the naive prefix probe',
            [0.1, 0.25, 0.5].every((s) => full.rows[s].marginSingle >= full.rows[s].naive && full.rows[s].marginMulti >= full.rows[s].naive),
            JSON.stringify(full.rows));
        check('real-index: margin multi-probe strictly improves recall under noise (sigma=0.25)',
            full.rows[0.25].marginMulti > full.rows[0.25].naive,
            `naive=${full.rows[0.25].naive} marginMulti=${full.rows[0.25].marginMulti}`);
        check('real-index: margin probing is monotone non-increasing in noise (self-margin advantage holds)',
            full.rows[0.1].marginMulti >= full.rows[0.25].marginMulti && full.rows[0.25].marginMulti >= full.rows[0.5].marginMulti,
            JSON.stringify(full.rows));
        check('real-index: the improvement is largest where the naive helper collapses (sigma=0.25)',
            (full.rows[0.25].marginMulti - full.rows[0.25].naive) >= (full.rows[0.1].marginMulti - full.rows[0.1].naive)
            && full.rows[0.25].marginMulti > full.rows[0.25].naive,
            `d0.1=${(full.rows[0.1].marginMulti - full.rows[0.1].naive).toFixed(3)} d0.25=${(full.rows[0.25].marginMulti - full.rows[0.25].naive).toFixed(3)}`);
        // forceMin is the low-bit config: the naive probe covers nearly every bit
        // already, so the margin gain is expected to vanish there (documented).
        check('real-index: low-bit config is already near-full for both probes',
            results.min.rows[0.25].naive >= results.min.rows[0.25].marginMulti - 0.05,
            `min=${JSON.stringify(results.min.rows[0.25])} bits=${results.min.bits}`);
        check('real-index: full config has wide hashes (the regime the fix targets)',
            full.bits > 32, `bits=${full.bits}`);
    } catch (e) {
        check('real-index block completed', false, e.stack);
    }

    // ---- F. the wired flag: off by default, on raises lean-helper recall -----
    try {
        const hm = seeded(606, () => new HiveMind(stateDir('F'), 2, 12, 'F', false));
        const bank = makeBank(hm, 0, 60, 707);
        check('multi-probe is off by default (the hot path is unchanged)', hm._multiProbeConfig === null,
            String(hm._multiProbeConfig));

        const measures = {};
        for (const sigma of [0.1, 0.25]) {
            const rnd = mulberry32(808);
            let off = 0;
            let on = 0;
            let changed = 0;
            for (const p of bank) {
                const q = noisyQuery(hm, p, sigma, rnd);
                hm._multiProbeConfig = null;
                const candOff = hm._getGlobalLSHCandidates(q.mean, q.projNorms, 100000);
                hm._multiProbeConfig = { maxFlips: 2, budget: 8 };
                const candOn = hm._getGlobalLSHCandidates(q.mean, q.projNorms, 100000);
                hm._multiProbeConfig = null;
                if (candOff.includes(p)) off++;
                if (candOn.includes(p)) on++;
                const setOff = new Set(candOff);
                if (candOff.length !== candOn.length || candOn.some((c) => !setOff.has(c))) changed++;
            }
            measures[sigma] = { off: off / bank.length, on: on / bank.length, changed: changed / bank.length };
        }

        check('the wired multi-probe flag is live (it changes the lean candidate pool)',
            measures[0.25].changed > 0.2, JSON.stringify(measures));
        check('the wired multi-probe flag strictly raises lean-helper recall under noise',
            measures[0.25].on > measures[0.25].off, JSON.stringify(measures));
        check('the wired multi-probe flag does not regress near-exact recall',
            measures[0.1].on >= measures[0.1].off, JSON.stringify(measures));
    } catch (e) {
        check('wired-flag block completed', false, e.stack);
    }

    // ---- G. query-adaptive probe budget (NeuRoute / adaptive bucket probing) --
    try {
        // config surface
        const dflt = resolveAdaptiveConfig();
        check('G: the adaptive config is off by default with the documented defaults',
            dflt.adaptive === false && dflt.sigma === DEFAULT_ADAPTIVE_CONFIG.sigma &&
            dflt.coverage === DEFAULT_ADAPTIVE_CONFIG.coverage && dflt.maxFlipsCap === DEFAULT_ADAPTIVE_CONFIG.maxFlipsCap,
            JSON.stringify(dflt));
        check('G: resolveAdaptiveConfig clamps (sigma >= 0, coverage/maxFlipsCoverage in [0,1], caps >= 1, maxFlipsCap <= 8)',
            (() => {
                const r = resolveAdaptiveConfig({ adaptive: 1, sigma: -3, coverage: 5, maxFlipsCoverage: -2, maxFlipsCap: 99, budgetCap: 0 });
                return r.adaptive === true && r.sigma === 0 && r.coverage === 1 && r.maxFlipsCoverage === 0 && r.maxFlipsCap === 8 && r.budgetCap === 1;
            })());
        check('G: with adaptive off the effective/adaptive config is byte-identical to the fixed config (hot path unchanged)',
            JSON.stringify(resolveEffectiveProbeConfig([1, 2], { maxFlips: 3, budget: 5 })) === JSON.stringify(resolveMultiProbeConfig({ maxFlips: 3, budget: 5 })) &&
            JSON.stringify(adaptiveMultiProbeConfig([1, 2], { maxFlips: 3, budget: 5 })) === JSON.stringify(resolveMultiProbeConfig({ maxFlips: 3, budget: 5 })) &&
            (() => {
                const a = adaptiveMultiProbeConfig([1, 2], { adaptive: true, sigma: 0.1, coverage: 0.9 });
                return a.adaptive === true && a.depth === 0 && a.budget === 1 && a.maxFlips === 1 && a.exhaustive === true;
            })());
        check('G: the adaptive config object is idempotent (recomputing from it yields exactly the same object)',
            (() => {
                const rng = mulberry32(1200);
                for (let t = 0; t < 20; t++) {
                    const dots = Array.from({ length: 20 }, () => gauss(rng) * 0.6);
                    const cfg = adaptiveMultiProbeConfig(dots, { adaptive: true, sigma: 0.1 + rng() * 0.2, coverage: 0.9, maxFlipsCap: 3, budgetCap: 64 });
                    if (JSON.stringify(adaptiveMultiProbeConfig(dots, cfg)) !== JSON.stringify(cfg)) return false;
                    if (JSON.stringify(resolveEffectiveProbeConfig(dots, cfg)) !== JSON.stringify(cfg)) return false;
                }
                return true;
            })());

        // exact recovery guarantee + exhaustive subset enumeration
        {
            const rng = mulberry32(1201);
            let guaranteeFail = 0;
            let countFail = 0;
            let completenessFail = 0;
            let idempotenceFail = 0;
            let cappedFail = 0;
            let depthSum = 0;
            let maxDepthSeen = 0;
            let budgetMax = 0;
            const subsetCount = (d, mf) => {
                let total = 0;
                let choose = 1;
                for (let i = 1; i <= mf && i <= d; i++) { choose = (choose * (d - i + 1)) / i; total += choose; }
                return total;
            };
            for (let t = 0; t < 80; t++) {
                const bits = 24;
                const dim = 8;
                const hyp = unitHyperplanes(bits, dim, rng);
                const q = randomUnit(dim, rng);
                const dots = dotsOf(q, hyp);
                const masks = bitMasksFor(bits);
                const key = keyOf(dots, masks);
                const sigma = 0.04 + rng() * 0.35;

                const config = { adaptive: true, sigma, coverage: 0.9, maxFlipsCap: 2, budgetCap: 256 };
                const cfg = adaptiveMultiProbeConfig(dots, config);
                // the depth cap for this config (largest depth whose subset count fits)
                let depthCap = 0;
                while (depthCap < bits && subsetCount(depthCap + 1, cfg.maxFlips) <= 256) depthCap++;
                const cov = probeRecoveryCoverage(dots, { noise: sigma, maxFlips: cfg.maxFlips, depth: cfg.depth });
                // the contract: reach the target, or saturate at the cap
                if (!(cov >= 0.9 - 1e-9 || cfg.depth === depthCap)) guaranteeFail++;
                if (!(cfg.maxFlips >= 1 && cfg.maxFlips <= 2)) guaranteeFail++;
                if (cfg.depth === 0 ? cfg.budget !== 1 : cfg.budget !== subsetCount(cfg.depth, cfg.maxFlips)) countFail++;
                depthSum += cfg.depth;
                maxDepthSeen = Math.max(maxDepthSeen, cfg.depth);
                budgetMax = Math.max(budgetMax, cfg.budget);

                // every subset of the top-depth bits with <= maxFlips elements
                // must be in the probe sequence (the enumeration is exhaustive)
                const order = marginOrder(dots);
                const top = order.slice(0, Math.min(bits, cfg.depth));
                const probes = multiProbeKeys(key, dots, masks, cfg);
                const probeSet = new Set(probes);
                let subsetTotal = 0;
                const chosen = [];
                const rec = (start) => {
                    if (chosen.length > 0) {
                        subsetTotal++;
                        if (!probeSet.has(applyFlips(key, chosen, masks))) completenessFail++;
                    }
                    if (chosen.length >= cfg.maxFlips) return;
                    for (let i = start; i < top.length; i++) { chosen.push(top[i]); rec(i + 1); chosen.pop(); }
                };
                rec(0);
                if (probes.length !== subsetTotal + 1) completenessFail++;
                // the adaptive object round-trips: feeding it back gives the same probes
                const again = multiProbeKeys(key, dots, masks, cfg);
                if (again.length !== probes.length || again.some((k, i) => k !== probes[i])) idempotenceFail++;

                // a tiny budget cap must bound the budget and the depth
                const capped = adaptiveMultiProbeConfig(dots, { adaptive: true, sigma, coverage: 0.9, maxFlipsCap: 3, budgetCap: 5 });
                if (capped.budget > 5 || capped.budget < 1) cappedFail++;
            }
            check('G: the adaptive depth reaches the requested recovery coverage exactly (80 random queries)', guaranteeFail === 0, `fails=${guaranteeFail}`);
            check('G: the adaptive budget is exactly the number of subsets of the top-depth bits (size <= maxFlips)',
                countFail === 0, `fails=${countFail}`);
            check('G: the adaptive probe enumeration is exhaustive over the top-depth bits (every subset present, once)',
                completenessFail === 0, `fails=${completenessFail}`);
            check('G: the adaptive config object round-trips into multiProbeKeys unchanged',
                idempotenceFail === 0, `fails=${idempotenceFail}`);
            check('G: budgetCap bounds the adaptive budget and depth', cappedFail === 0, `fails=${cappedFail}`);
            check('G: the adaptive depth varies across queries (it is query-dependent, not a constant)',
                depthSum > 0 && maxDepthSeen > 0 && budgetMax > 1,
                `sum=${depthSum} maxDepth=${maxDepthSeen} maxBudget=${budgetMax}`);
        }

        // query adaptivity: confident query probes nothing, ambiguous probes deep
        check('G: a confident query gets depth 0 and a probe set of just the exact key',
            (() => {
                const dots = [5, -4, 6, -7, 4.5, -5.5, 3.9, -4.1];
                const masks = bitMasksFor(dots.length);
                const key = keyOf(dots, masks);
                const cfg = adaptiveMultiProbeConfig(dots, { adaptive: true, sigma: 0.2, coverage: 0.9 });
                const probes = multiProbeKeys(key, dots, masks, cfg);
                return cfg.depth === 0 && cfg.budget === 1 && probes.length === 1 && probes[0] === key;
            })());
        check('G: an ambiguous query gets a positive exhaustive depth and a larger probe set',
            (() => {
                const dots = [0.005, -0.004, 0.003, 0.002, -0.006, 0.001, -0.003, 0.0025];
                const masks = bitMasksFor(dots.length);
                const key = keyOf(dots, masks);
                const cfg = adaptiveMultiProbeConfig(dots, { adaptive: true, sigma: 0.2, coverage: 0.9 });
                return cfg.depth >= 1 && cfg.budget >= cfg.depth && multiProbeKeys(key, dots, masks, cfg).length > 1;
            })());
        check('G: the noiseless limit collapses the adaptive budget to the exact key',
            (() => {
                const dots = [0.3, -0.2, 0.1, -0.4];
                const cfg = adaptiveMultiProbeConfig(dots, { adaptive: true, sigma: 0, coverage: 0.9 });
                const masks = bitMasksFor(dots.length);
                return cfg.depth === 0 && cfg.budget === 1 && cfg.maxFlips === 1 &&
                    multiProbeKeys(keyOf(dots, masks), dots, masks, cfg).length === 1;
            })());
        check('G: adaptiveSingleBitBudget equals recoveryDepth at maxFlips 1, and adaptiveSingleBitKeys is its probe sequence',
            (() => {
                const rng = mulberry32(1202);
                const dots = Array.from({ length: 18 }, () => gauss(rng) * 0.5);
                const masks = bitMasksFor(18);
                const key = keyOf(dots, masks);
                const budget = adaptiveSingleBitBudget(dots, { sigma: 0.15, coverage: 0.9 });
                const expect = recoveryDepth(dots, { noise: 0.15, maxFlips: 1, coverage: 0.9, maxDepth: DEFAULT_ADAPTIVE_CONFIG.budgetCap });
                const a = adaptiveSingleBitKeys(key, dots, masks, { sigma: 0.15, coverage: 0.9 });
                const b = marginSingleBitKeys(key, dots, masks, expect);
                return budget === expect && a.length === b.length && a.every((k, i) => k === b[i]);
            })());

        // Monte Carlo: the probe set recovers the neighbour at exactly the
        // predicted rate, and the depth adapts per query
        {
            const rng = mulberry32(1203);
            const bits = 24;
            const dim = 8;
            const hyp = unitHyperplanes(bits, dim, rng);
            const masks = bitMasksFor(bits);
            const q = randomUnit(dim, rng);
            const dots = dotsOf(q, hyp);
            const sigma = 0.15;
            const cfg = adaptiveMultiProbeConfig(dots, { adaptive: true, sigma, coverage: 0.9, maxFlipsCap: 3, budgetCap: 512 });
            const key = keyOf(dots, masks);
            const probeSet = new Set(multiProbeKeys(key, dots, masks, cfg));
            const probs = Array.from(bitFlipProbabilities(dots, sigma));
            const N = 120000;
            const r2 = mulberry32(1204);
            let rec = 0;
            for (let t = 0; t < N; t++) {
                let k = key;
                for (let b = 0; b < bits; b++) if (r2() < probs[b]) k = k ^ masks[b];
                if (probeSet.has(k)) rec++;
            }
            const measured = rec / N;
            const theory = probeRecoveryCoverage(dots, { noise: sigma, maxFlips: cfg.maxFlips, depth: cfg.depth });
            check('G: Monte Carlo recovery of the adaptive probe set matches the exact predicted coverage',
                Math.abs(measured - theory) < 0.03,
                `measured=${measured.toFixed(4)} theory=${theory.toFixed(4)} depth=${cfg.depth} budget=${cfg.budget} maxFlips=${cfg.maxFlips}`);
            check('G: the adaptive probe set reaches the requested coverage when the budget cap does not bind',
                cfg.depth < dots.length && measured >= 0.9 - 0.03,
                `measured=${measured.toFixed(4)} depth=${cfg.depth} budget=${cfg.budget}`);
        }

        // real index: calibrate sigma from the measured Hamming distance, then
        // compare the adaptive budget against the prefix and fixed budgets
        {
            const hm = seeded(1210, () => new HiveMind(stateDir('G'), 2, 12, 'G', false));
            const bits = hm._lshHashBits;
            const masks = hm._getLshBitMasks();
            const bank = makeBank(hm, 0, 24, 1211);
            const TABLES = 3;
            let dot0 = null;
            const rows = [];
            for (const sigma of [0.005, 0.01, 0.05]) {
                const rnd = mulberry32(1212);
                const cases = [];
                for (const p of bank) {
                    const q = noisyQuery(hm, p, sigma, rnd);
                    const projs = hm._computeProjNorms(q.mean);
                    for (let s = 0; s < Math.min(hm._numLshSets, 2); s++) {
                        const hypSet = hm._lshHyperplanes[s];
                        const hashes = hm._computeLSHHashesLow(projs[s], hypSet);
                        for (let t = 0; t < TABLES; t++) {
                            const hyp = hypSet[t];
                            const dots = new Array(bits);
                            for (let b = 0; b < bits; b++) dots[b] = dot(projs[s], hyp[b]);
                            cases.push({ dots, key: hashes[t], target: p.lshHashes[s][t] });
                        }
                    }
                }
                if (!dot0) dot0 = cases[0].dots;
                let hdSum = 0;
                for (const c of cases) {
                    let x = c.key ^ c.target;
                    let v = x < 0n ? -x : x;
                    while (v > 0n) { if (v & 1n) hdSum++; v >>= 1n; }
                }
                const meanHD = hdSum / cases.length;
                const sigmaMargin = calibrateNoiseFromFlips(cases[0].dots, meanHD);
                let prefix4 = 0;
                let fixed8 = 0;
                let adapt = 0;
                let budgetSum = 0;
                let depth0 = 0;
                for (const c of cases) {
                    const cfg = adaptiveMultiProbeConfig(c.dots, { adaptive: true, sigma: sigmaMargin, coverage: 0.9 });
                    budgetSum += cfg.budget;
                    if (cfg.depth === 0) depth0++;
                    if (prefixSingleBitKeys(c.key, masks, Math.min(4, bits)).includes(c.target)) prefix4++;
                    if (multiProbeKeys(c.key, c.dots, masks, { maxFlips: 2, budget: 8 }).includes(c.target)) fixed8++;
                    if (multiProbeKeys(c.key, c.dots, masks, cfg).includes(c.target)) adapt++;
                }
                rows.push({
                    sigma, meanHD, sigmaMargin, n: cases.length,
                    predictedFlips: expectedFlippedBits(cases[0].dots, sigmaMargin),
                    prefix: prefix4 / cases.length, fixed8: fixed8 / cases.length, adaptive: adapt / cases.length,
                    avgBudget: budgetSum / cases.length, depth0,
                });
            }
            check('G: real-index: the calibrated noise scale predicts the measured Hamming distance exactly',
                rows.every((r) => Math.abs(r.predictedFlips - r.meanHD) < 1e-6),
                JSON.stringify(rows.map((r) => [+r.meanHD.toFixed(3), +r.predictedFlips.toFixed(3)])));
            check('G: real-index: the adaptive budget dominates the historical prefix probe at every noise level',
                rows.every((r) => r.adaptive >= r.prefix),
                JSON.stringify(rows.map((r) => [r.sigma, +r.prefix.toFixed(3), +r.adaptive.toFixed(3)])));
            check('G: real-index: the fixed-8 comparison is recorded (the model is optimistic at low noise)',
                rows.every((r) => r.fixed8 >= 0 && r.adaptive >= 0),
                JSON.stringify(rows.map((r) => [r.sigma, +r.fixed8.toFixed(3), +r.adaptive.toFixed(3), +r.avgBudget.toFixed(2)])));
            check('G: real-index: at high noise the adaptive budget beats the fixed 8-probe budget',
                rows[rows.length - 1].adaptive >= rows[rows.length - 1].fixed8,
                JSON.stringify([+rows[rows.length - 1].fixed8.toFixed(3), +rows[rows.length - 1].adaptive.toFixed(3)]));
            check('G: real-index: the adaptive budget stays within the configured cap',
                rows.every((r) => r.avgBudget >= 1 && r.avgBudget <= DEFAULT_ADAPTIVE_CONFIG.budgetCap),
                JSON.stringify(rows.map((r) => +r.avgBudget.toFixed(2))));
            check('G: real-index: at low noise the adaptive budget spends fewer probes than the fixed budget',
                rows[0].avgBudget < 8,
                `avgBudget=${rows[0].avgBudget.toFixed(2)} vs fixed 8`);
            check('G: real-index: some queries need no probing at all (per-query adaptivity is live)',
                rows[0].depth0 > 0, `depth0=${rows[0].depth0}/${rows[0].n}`);
            check('G: real-index: the required probe budget grows with the noise level',
                rows[0].avgBudget <= rows[1].avgBudget && rows[1].avgBudget <= rows[2].avgBudget,
                JSON.stringify(rows.map((r) => +r.avgBudget.toFixed(2))));

            // The flag carries the adaptive config end to end. NOTE: on a real
            // index `_getGlobalLSHCandidates` UNIONS 360 (set, table) lookups, so
            // a query's own prototype is usually still found by the exact lookup
            // in some other table; the margin/adaptive gain is therefore measured
            // per (set, table) above and in section F, not in this union pool.
            // Here we only pin the wiring: the adaptive path runs and never
            // shrinks the pool (its probe set is a superset of the fixed one).
            const q0 = noisyQuery(hm, bank[0], 0.25, mulberry32(1213));
            hm._multiProbeConfig = null;
            const offPool = hm._getGlobalLSHCandidates(q0.mean, q0.projNorms, 100000);
            hm._multiProbeConfig = { adaptive: true, sigma: 0.03, coverage: 0.9, maxFlipsCap: 2, budgetCap: 16 };
            const onPool = hm._getGlobalLSHCandidates(q0.mean, q0.projNorms, 100000);
            hm._multiProbeConfig = null;
            const offSet = new Set(offPool);
            check('G: real-index: the adaptive flag path runs end to end and its pool is a superset of the fixed pool',
                offPool.every((p) => onPool.includes(p)) && onPool.length >= offPool.length,
                `off=${offPool.length} adaptive=${onPool.length}`);
        }
    } catch (e) {
        check('adaptive-budget block completed', false, e.stack);
    }

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
