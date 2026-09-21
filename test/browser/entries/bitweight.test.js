// Bit-reliability theory — proof suite for `src/hivemind/memory/bitweight.js`.
//
// Grounding: Charikar's rounding law (STOC 2002), Lv et al. multi-probe LSH
// (VLDB 2007), weighted Hamming (arXiv 2009.08591) and Density Sensitive
// Hashing (arXiv 1205.2930). The claim the lock registry needs is the exact
// bit-flip law for a data-aligned hash direction:
//
//   P(flip) = arccos( sqrt(lambda / (lambda + sigma^2)) ) / pi
//
// with the limits 1/2 as lambda -> 0 (a pure-noise bit) and 0 as lambda ->
// infinity (a perfectly stable bit). The suite splits the guarantees so a
// failure names the tier:
//
//   A. THE LAW                exact values + the limits + monotonicity.
//   B. MONTE CARLO            the closed form against sampled Gaussians, and
//                             the law as the average of the margin law.
//   C. MARGIN LAW             Phi(-|margin|/sigma), and why margin order is
//                             the flip-probability order Lv wants.
//   D. NOISE ESTIMATE         the sub-mean / min / median-tail spectrum reader.
//   E. RELIABLE RANK          the above-mean "beat a random direction" rule.
//   F. WEIGHTS                exact per-bit reliability weights.
//   G. WEIGHTED HAMMING       the metric, and the packed-word fast path.
//   H. INDEX VALIDATION       the law predicts the measured flip rate of a real
//                             aligned index (theory <-> live hash).
//   I. RECORDED NEGATIVE      reliability-weighted *candidate ranking* does NOT
//                             beat plain Hamming on the rotation-based index
//                             (the rotation already equalises per-direction
//                             variance); recorded so the next session does not
//                             re-derive it.
//   J. ADAPTIVE PROBE BUDGET  the per-query budget of NeuRoute (arXiv
//                             2608.15438) / adaptive bucket probing (arXiv
//                             2604.04603): the Poisson-binomial flip count, the
//                             exact containment and recovery coverages, the
//                             incremental recovery depth, and the noise
//                             calibration used to fit sigma to an observed flip
//                             rate. Validated against Monte Carlo.
//
// Pure module: no `{ ensureSql, stateDir }` needed, but it accepts the options
// object for symmetry with the other entries.

import {
    DEFAULT_BITWEIGHT_CONFIG,
    resolveBitWeightConfig,
    binaryEntropy,
    erf,
    normalCdf,
    flipProbability,
    reliabilityWeight,
    bitInformation,
    flipProbabilityFromMargin,
    estimateNoiseVariance,
    selectReliableRank,
    reliabilityWeights,
    weightedHamming,
    weightedKeyDistance,
    unpackWord,
    bitFlipProbabilities,
    poissonBinomialPmf,
    poissonBinomialQuantile,
    expectedFlippedBits,
    marginContainmentCoverage,
    marginContainmentDepth,
    probeRecoveryCoverage,
    recoveryDepth,
    calibrateNoiseFromFlips,
} from '../../../src/hivemind/memory/bitweight.js';
import { alignedHashTables } from '../../../src/hivemind/memory/binarypc.js';

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function gauss(rng) {
    const u = Math.max(rng(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

const close = (a, b, tol = 1e-9) => Number.isFinite(a) && Math.abs(a - b) <= tol;

export async function run(_options = {}) {
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    // ---- A. the law ----------------------------------------------------------
    check('A: flipProbability(sigma^2, sigma^2) is exactly 1/4 (the arccos(1/sqrt2)/pi point)',
        close(flipProbability(1, 1), 0.25, 1e-12), `${flipProbability(1, 1)}`);
    check('A: limits — 0 variance is a pure-noise bit (1/2), noiseless is 0, both-zero is 1/2',
        flipProbability(0, 1) === 0.5 && flipProbability(1, 0) === 0 && flipProbability(0, 0) === 0.5);
    check('A: flipProbability is strictly decreasing in the signal variance',
        (() => {
            const vs = [0.01, 0.1, 0.5, 1, 2, 8, 64];
            const q = vs.map((v) => flipProbability(v, 1));
            return q.every((x, i) => i === 0 || x < q[i - 1]);
        })());
    check('A: flipProbability is strictly increasing in the noise variance',
        (() => {
            const ns = [0.01, 0.1, 0.5, 1, 4, 16];
            const q = ns.map((n) => flipProbability(1, n));
            return q.every((x, i) => i === 0 || x > q[i - 1]);
        })());
    check('A: flipProbability stays in [0, 1/2] over a grid',
        (() => {
            let ok = true;
            for (let lv = -4; lv <= 4; lv += 0.5) {
                for (let ln = -4; ln <= 4; ln += 0.5) {
                    const q = flipProbability(Math.pow(10, lv), Math.pow(10, ln));
                    if (!(q >= 0 && q <= 0.5 && Number.isFinite(q))) ok = false;
                }
            }
            return ok;
        })());
    check('A: non-finite inputs are treated as 0 variance / 0 noise (no NaN)',
        Number.isFinite(flipProbability(NaN, 1)) && Number.isFinite(flipProbability(1, NaN)) &&
        flipProbability(NaN, 1) === 0.5 && flipProbability(1, NaN) === 0);

    check('A: reliabilityWeight == 1 - 2*flipProbability exactly, and is 0 for a pure-noise bit',
        (() => {
            const v = [0, 0.25, 1, 4, 100];
            return v.every((x) => reliabilityWeight(x, 2) === Math.min(1, Math.max(0, 1 - 2 * flipProbability(x, 2)))) &&
                reliabilityWeight(0, 2) === 0;
        })());
    check('A: reliabilityWeight -> 1 for a very stable bit and stays in [0,1]',
        reliabilityWeight(1e6, 1) > 0.999 && reliabilityWeight(1, 1) >= 0 && reliabilityWeight(1, 1) <= 1);
    check('A: bitInformation is 0 bits for a pure-noise bit and ->1 for a noiseless / very stable one',
        close(bitInformation(0, 1), 0, 1e-12) && close(bitInformation(1, 0), 1, 1e-12) &&
        bitInformation(1e6, 1) > 0.99);
    check('A: bitInformation is monotone increasing in the signal variance and bounded by 1',
        (() => {
            const vs = [0.01, 0.25, 1, 4, 16, 256];
            const i = vs.map((v) => bitInformation(v, 1));
            return i.every((x, k) => (k === 0 || x > i[k - 1]) && x >= 0 && x <= 1);
        })());
    check('A: binaryEntropy has the exact endpoints and peak (H2(0)=H2(1)=0, H2(1/2)=1)',
        binaryEntropy(0) === 0 && binaryEntropy(1) === 0 && close(binaryEntropy(0.5), 1, 1e-12));

    // ---- B. Monte Carlo against the closed form ------------------------------
    const mc = mulberry32(12345);
    const mcRows = [];
    for (const [v, n] of [[1, 1], [4, 1], [0.25, 1], [9, 1]]) {
        const N = 200000;
        let flips = 0;
        const sd = Math.sqrt(v);
        const sn = Math.sqrt(n);
        for (let i = 0; i < N; i++) {
            const p = gauss(mc) * sd;
            const e = gauss(mc) * sn;
            if ((p > 0) !== (p + e > 0)) flips++;
        }
        const measured = flips / N;
        const law = flipProbability(v, n);
        mcRows.push({ v, n, measured: +measured.toFixed(5), law: +law.toFixed(5), diff: Math.abs(measured - law) });
        check(`B: the flip law matches Monte Carlo at (lambda=${v}, sigma^2=${n})`,
            Math.abs(measured - law) < 0.006, `measured=${measured.toFixed(5)} law=${law.toFixed(5)}`);
    }
    check('B: MC/law table recorded', true, JSON.stringify(mcRows));

    // The flip law is the average of the margin law over the signal distribution
    // N(0, lambda). Check that identity by sampling the margins directly.
    const mc2 = mulberry32(777);
    const vT = 4;
    const nT = 1;
    let avg = 0;
    const NN = 200000;
    for (let i = 0; i < NN; i++) avg += flipProbabilityFromMargin(gauss(mc2) * Math.sqrt(vT), Math.sqrt(nT));
    avg /= NN;
    check('B: flipProbability(lambda, sigma) is the average of flipProbabilityFromMargin over N(0,lambda)',
        Math.abs(avg - flipProbability(vT, nT)) < 0.006, `avg=${avg.toFixed(5)} law=${flipProbability(vT, nT).toFixed(5)}`);

    // ---- C. the margin law and Lv's ordering ---------------------------------
    check('C: normalCdf is exact at the centre and within 1.5e-6 at 1.96 and -1.96',
        normalCdf(0) === 0.5 && close(normalCdf(1.96), 0.9750021, 1.5e-6) && close(normalCdf(-1.96), 0.0249979, 1.5e-6),
        `${normalCdf(1.96)}`);
    check('C: erf is odd with the correct saturation (erf(0)=0, erf(inf)=1)',
        close(erf(0), 0, 1e-12) && close(erf(6), 1, 1e-7) && erf(-1) === -erf(1));
    check('C: flipProbabilityFromMargin is exactly 1/2 at zero margin and vanishes for a large margin',
        flipProbabilityFromMargin(0, 1) === 0.5 && flipProbabilityFromMargin(1e6, 1) < 1e-9);
    check('C: flipProbabilityFromMargin is monotone decreasing in |margin|',
        (() => {
            const ms = [0, 0.1, 0.5, 1, 2, 5];
            const q = ms.map((m) => flipProbabilityFromMargin(m, 0.5));
            return q.every((x, i) => i === 0 || x < q[i - 1]);
        })());
    check('C: ascending |margin| order IS descending flip-probability order (the Lv justification)',
        (() => {
            const rng = mulberry32(4);
            const dots = Array.from({ length: 64 }, () => gauss(rng) * (0.2 + rng() * 3));
            const order = dots.map((d, b) => b).sort((a, b) => Math.abs(dots[a]) - Math.abs(dots[b]));
            const q = order.map((b) => flipProbabilityFromMargin(dots[b], 0.7));
            return q.every((x, i) => i === 0 || x <= q[i - 1] + 1e-12);
        })());

    // ---- D. noise estimate ---------------------------------------------------
    const spec = [4, 1, 0.25, 0.0625];
    const totalV = spec.reduce((s, v) => s + v, 0);
    check('D: sub-mean policy averages the eigenvalues below trace/dim',
        close(estimateNoiseVariance(spec, { totalVariance: totalV, dim: 4 }), 0.4375, 1e-12),
        `${estimateNoiseVariance(spec, { totalVariance: totalV, dim: 4 })}`);
    check('D: min policy returns the smallest eigenvalue; median-tail the middle of the tail',
        close(estimateNoiseVariance(spec, { policy: 'min' }), 0.0625, 1e-12) &&
        close(estimateNoiseVariance(spec, { policy: 'median-tail', totalVariance: totalV, dim: 4 }), 0.25, 1e-12));
    check('D: an empty spectrum estimates 0 noise and never returns NaN',
        estimateNoiseVariance([]) === 0 && estimateNoiseVariance([0, 0, 0]) === 0);

    // ---- E. reliable rank ----------------------------------------------------
    check('E: above-mean counts the PCs strictly above the random-direction baseline',
        selectReliableRank([9, 4, 1, 0.1], { totalVariance: 14.1, dim: 4 }) === 2,
        `${selectReliableRank([9, 4, 1, 0.1], { totalVariance: 14.1, dim: 4 })}`);
    check('E: noise policy counts the eigenvalues above factor*noise',
        selectReliableRank([9, 4, 1, 0.1], { policy: 'noise', noise: 1, factor: 2 }) === 2 &&
        selectReliableRank([9, 4, 1, 0.1], { policy: 'noise', noise: 0 }) === 4);
    check('E: the rank is always >= 1 and never exceeds the spectrum length',
        selectReliableRank([0.001, 0.001], { totalVariance: 0.002, dim: 2 }) === 1 &&
        selectReliableRank([9, 4, 1], { totalVariance: 14, dim: 3 }) <= 3 &&
        selectReliableRank([]) === 1);
    check('E: an all-equal spectrum has nothing above the mean, so the rank falls back to 1',
        selectReliableRank([2, 2, 2, 2], { totalVariance: 8, dim: 4 }) === 1);

    // ---- F. reliability weights ----------------------------------------------
    const wUniform = reliabilityWeights([1, 1, 1, 1], { noise: 0.5 });
    check('F: equal variances give equal weights (the weighted metric collapses to Hamming)',
        wUniform.every((w) => w === wUniform[0]) && wUniform[0] >= 0 && wUniform[0] <= 1);
    check('F: weights are exactly reliabilityWeight(variance, noise) per bit',
        (() => {
            const v = [4, 0.25, 1];
            const w = reliabilityWeights(v, { noise: 1 });
            return v.every((x, i) => w[i] === reliabilityWeight(x, 1));
        })());
    check('F: weight is monotone increasing in variance and 0 for a zero-variance bit',
        (() => {
            const w = reliabilityWeights([0, 0.1, 1, 10, 100], { noise: 1 });
            return w[0] === 0 && w.every((x, i) => i === 0 || x > w[i - 1]);
        })());
    check('F: noise = 0 makes every positive-variance bit perfectly reliable (weight 1), a zero-variance bit degenerate (0)',
        reliabilityWeights([1, 2, 3], { noise: 0 }).every((w) => w === 1) &&
        reliabilityWeights([0, 0], { noise: 0 }).every((w) => w === 0));
    check("F: 'auto' noise picks the sub-mean of the supplied variances",
        (() => {
            const v = [4, 1, 0.25, 0.0625];
            const auto = reliabilityWeights(v, { noise: 'auto' });
            const manual = reliabilityWeights(v, { noise: estimateNoiseVariance(v) });
            return auto.every((x, i) => x === manual[i]);
        })());

    // ---- G. weighted Hamming + packed words ----------------------------------
    check('G: weightedHamming is exact on a hand vector, symmetric and 0 iff equal',
        (() => {
            const a = [1, 0, 1, 1];
            const b = [0, 0, 0, 1];
            const w = [1, 2, 3, 4];
            return weightedHamming(a, b, w) === 4 && weightedHamming(b, a, w) === 4 &&
                weightedHamming(a, a, w) === 0;
        })());
    check('G: unit weights reproduce the plain Hamming distance, and weighted <= max(w)*Hamming',
        (() => {
            const rng = mulberry32(31);
            for (let t = 0; t < 50; t++) {
                const a = Array.from({ length: 20 }, () => (rng() < 0.5 ? 0 : 1));
                const b = Array.from({ length: 20 }, () => (rng() < 0.5 ? 0 : 1));
                const ones = new Array(20).fill(1);
                const ham = a.reduce((s, x, i) => s + (x !== b[i] ? 1 : 0), 0);
                const w = Array.from({ length: 20 }, () => 0.01 + rng());
                if (weightedHamming(a, b, ones) !== ham) return false;
                if (weightedHamming(a, b, w) > Math.max(...w) * ham + 1e-9) return false;
            }
            return true;
        })());
    check('G: weightedKeyDistance matches the unpacked weighted Hamming on 32-bit words',
        (() => {
            const rng = mulberry32(99);
            const masks = Array.from({ length: 30 }, (_, b) => 1 << b);
            for (let t = 0; t < 40; t++) {
                const a = (rng() * 0xffffffff) >>> 0;
                const b = (rng() * 0xffffffff) >>> 0;
                const w = Array.from({ length: 30 }, () => 0.05 + rng() * 2);
                const fast = weightedKeyDistance(a, b, w, masks);
                const slow = weightedHamming(unpackWord(a, 30, masks), unpackWord(b, 30, masks), w);
                if (Math.abs(fast - slow) > 1e-9) return false;
            }
            return true;
        })());
    check('G: weightedKeyDistance also matches on BigInt words wider than 32 bits',
        (() => {
            const masks = Array.from({ length: 40 }, (_, b) => 1n << BigInt(b));
            const w = Array.from({ length: 40 }, (_, b) => 0.1 + (b % 5) * 0.3);
            const a = 0b1011011100101010111100001111000011110110n;
            const b = 0b1111000011001100110011001100110000111100n;
            const fast = weightedKeyDistance(a, b, w, masks);
            const slow = weightedHamming(unpackWord(a, 40, masks), unpackWord(b, 40, masks), w);
            return Math.abs(fast - slow) < 1e-9;
        })());
    check('G: unpackWord round-trips a packed word',
        (() => {
            const masks = Array.from({ length: 32 }, (_, b) => 1 << b);
            const word = 0b10101010101010101010101010101010 | 0;
            const code = unpackWord(word >>> 0, 32, masks);
            let repacked = 0;
            for (let b = 0; b < 32; b++) if (code[b]) repacked |= masks[b];
            return (repacked >>> 0) === (word >>> 0) && code.reduce((s, x) => s + x, 0) === 16;
        })());

    // ---- H. the law predicts a real aligned index ----------------------------
    // Build a genuinely anisotropic bank, hash it with PCA-aligned directions,
    // then measure the bit-flip rate between each prototype and a Gaussian-noised
    // query. The theory predicts mean_b flipProbability(var_b, sigma^2), where
    // var_b is the reported variance of direction b — so this is a direct
    // theory <-> live-hash check.
    {
        const dim = 10;
        const n = 200;
        const sigma = 0.5;
        const rng = mulberry32(20260920);
        const base = [];
        for (let j = 0; j < 4; j++) {
            const v = new Float64Array(dim);
            for (let d = 0; d < dim; d++) v[d] = gauss(rng);
            for (const u of base) {
                let c = 0;
                for (let d = 0; d < dim; d++) c += v[d] * u[d];
                for (let d = 0; d < dim; d++) v[d] -= c * u[d];
            }
            let nn = 0;
            for (let d = 0; d < dim; d++) nn += v[d] * v[d];
            nn = Math.sqrt(nn) || 1;
            for (let d = 0; d < dim; d++) v[d] /= nn;
            base.push(v);
        }
        const rows = [];
        for (let i = 0; i < n; i++) {
            const x = new Float64Array(dim);
            for (let j = 0; j < base.length; j++) {
                const a = gauss(rng) * 3 * Math.pow(0.45, j);
                for (let d = 0; d < dim; d++) x[d] += a * base[j][d];
            }
            for (let d = 0; d < dim; d++) x[d] += gauss(rng) * 0.6;
            rows.push(x);
        }
        const bits = 40;
        const res = alignedHashTables(rows, { bits, numTables: 1, seed: 314 });
        check('H: alignedHashTables returns per-direction data variances (one per bit)',
            Array.isArray(res.tableVariances) && res.tableVariances.length === 1 &&
            res.tableVariances[0].length === bits && res.tableVariances[0].every((v) => Number.isFinite(v) && v >= 0));

        const tab = res.tables[0];
        const code = (x) => {
            const c = new Uint8Array(bits);
            for (let b = 0; b < bits; b++) {
                let s = 0;
                for (let d = 0; d < dim; d++) s += x[d] * tab[b][d];
                c[b] = s > 0 ? 1 : 0;
            }
            return c;
        };
        const codes = rows.map(code);
        const rq = mulberry32(5150);
        let diffs = 0;
        const q = new Float64Array(dim);
        for (let i = 0; i < n; i++) {
            for (let d = 0; d < dim; d++) q[d] = rows[i][d] + gauss(rq) * sigma;
            const qc = code(q);
            for (let b = 0; b < bits; b++) if (qc[b] !== codes[i][b]) diffs++;
        }
        const measured = diffs / (n * bits);
        let predicted = 0;
        for (let b = 0; b < bits; b++) predicted += flipProbability(res.tableVariances[0][b], sigma * sigma);
        predicted /= bits;
        check('H: the law predicts the measured bit-flip rate of the real aligned index (within 0.03)',
            Math.abs(measured - predicted) < 0.03,
            `measured=${measured.toFixed(4)} predicted=${predicted.toFixed(4)}`);

        // The tail directions carry less information than the head directions.
        const w = reliabilityWeights(res.tableVariances[0], { noise: sigma * sigma });
        const sorted = Array.from(w).sort((a, b) => a - b);
        check('H: reliability weights are ordered — the least reliable bit is well below the most reliable',
            sorted[sorted.length - 1] > sorted[0] + 0.1,
            `min=${sorted[0].toFixed(3)} max=${sorted[sorted.length - 1].toFixed(3)}`);
    }

    // ---- I. recorded negative: reliability-weighted candidate ranking --------
    // The theorem says a bit's weight should be its BSC reliability. Applied to
    // the *rotation-based* aligned index, however, every aligned direction is a
    // rotation mixing the whole aligned subspace, so its variance is already
    // near trace/dim and the weights are near-uniform — while the random surplus
    // bits are down-weighted for no reason. Measured (this check, 200 protos,
    // sigma=0.5): weighted Hamming ranks the true neighbour *worse* than plain
    // Hamming. This is why `_getGlobalLSHCandidates` does NOT rank its pool by
    // weighted Hamming — the pool is already re-scored downstream by the exact
    // projection cosine. The numbers are recorded so the finding is not
    // re-derived.
    {
        const dim = 12;
        const n = 200;
        const sigma = 0.5;
        const rng = mulberry32(8675309);
        const rows = [];
        for (let i = 0; i < n; i++) {
            const x = new Float64Array(dim);
            for (let d = 0; d < dim; d++) x[d] = gauss(rng) * (d < 3 ? 2.5 : 0.5);
            rows.push(x);
        }
        const bits = 32;
        const res = alignedHashTables(rows, { bits, numTables: 1, seed: 2718 });
        const tab = res.tables[0];
        const w = reliabilityWeights(res.tableVariances[0], { noise: sigma * sigma });
        const code = (x) => {
            const c = new Uint8Array(bits);
            for (let b = 0; b < bits; b++) {
                let s = 0;
                for (let d = 0; d < dim; d++) s += x[d] * tab[b][d];
                c[b] = s > 0 ? 1 : 0;
            }
            return c;
        };
        const codes = rows.map(code);
        const rq = mulberry32(424242);
        let plainRank = 0;
        let wtdRank = 0;
        const q = new Float64Array(dim);
        for (let i = 0; i < n; i++) {
            for (let d = 0; d < dim; d++) q[d] = rows[i][d] + gauss(rq) * sigma;
            const qc = code(q);
            let dp = 0;
            let dw = 0;
            let rp = 0;
            let rw = 0;
            for (let k = 0; k < n; k++) {
                let a = 0;
                let b2 = 0;
                for (let b = 0; b < bits; b++) {
                    if (qc[b] !== codes[k][b]) { a += 1; b2 += w[b]; }
                }
                if (k === i) { dp = a; dw = b2; }
            }
            for (let k = 0; k < n; k++) {
                if (k === i) continue;
                let a = 0;
                let b2 = 0;
                for (let b = 0; b < bits; b++) {
                    if (qc[b] !== codes[k][b]) { a += 1; b2 += w[b]; }
                }
                if (a < dp) rp++;
                if (b2 < dw) rw++;
            }
            plainRank += rp;
            wtdRank += rw;
        }
        check('I: recorded negative — plain Hamming outranks reliability-weighted Hamming on the rotation-based index',
            plainRank < wtdRank,
            `meanRank plain=${(plainRank / n).toFixed(2)} weighted=${(wtdRank / n).toFixed(2)}`);
    }

    // ---- J. query-adaptive probe budgeting -----------------------------------
    // Per-bit flip probabilities, the Poisson-binomial count, the exact
    // containment / recovery coverages, the incremental recovery depth, and the
    // noise calibration. References: NeuRoute (arXiv 2608.15438), adaptive
    // bucket probing (arXiv 2604.04603), Lv et al. (VLDB 2007).
    try {
        // (1) per-bit flip probabilities
        const jdots = [0, 0.25, -1, 2];
        const jq = bitFlipProbabilities(jdots, 0.5);
        check('J: bitFlipProbabilities returns Phi(-|margin|/sigma) per bit',
            jq.length === 4 && jdots.every((d, b) => jq[b] === flipProbabilityFromMargin(d, 0.5)),
            Array.from(jq).join(','));
        check('J: bitFlipProbabilities is empty for no dots and all-zero in the noiseless limit',
            bitFlipProbabilities([], 1).length === 0 && Array.from(bitFlipProbabilities([1, 2, 3], 0)).every((x) => x === 0));

        // (2) Poisson-binomial pmf: exact on the symmetric case and on the limits
        const jflat16 = Array.from(poissonBinomialPmf([0.5, 0.5, 0.5, 0.5]));
        const jbinomial = [1, 4, 6, 4, 1].map((x) => x / 16);
        check('J: poissonBinomialPmf of four 1/2 coins is exactly the binomial pmf 1,4,6,4,1 over 16',
            jflat16.length === 5 && jflat16.every((x, k) => Math.abs(x - jbinomial[k]) < 1e-15),
            JSON.stringify(jflat16));
        check('J: poissonBinomialPmf sums to 1 and is a point mass in the degenerate cases',
            (() => {
                const s = jflat16.reduce((a, b) => a + b, 0);
                const zero = Array.from(poissonBinomialPmf([0, 0, 0]));
                const one = Array.from(poissonBinomialPmf([1, 1, 1]));
                return Math.abs(s - 1) < 1e-12 && zero[0] === 1 && zero.every((x, k) => k === 0 || x === 0) &&
                    one[3] === 1 && one.every((x, k) => k === 3 || x === 0);
            })());

        // (3) quantile: exact on the symmetric case
        check('J: poissonBinomialQuantile is exact (1/2->2, 0.6875->2, 0.9375->3, 1->4, 0->0)',
            poissonBinomialQuantile([0.5, 0.5, 0.5, 0.5], 0.5) === 2 &&
            poissonBinomialQuantile([0.5, 0.5, 0.5, 0.5], 0.6875) === 2 &&
            poissonBinomialQuantile([0.5, 0.5, 0.5, 0.5], 0.6876) === 3 &&
            poissonBinomialQuantile([0.5, 0.5, 0.5, 0.5], 1) === 4 &&
            poissonBinomialQuantile([0.5, 0.5, 0.5, 0.5], 0) === 0,
            [0.5, 0.6875, 0.6876, 1, 0].map((c) => poissonBinomialQuantile([0.5, 0.5, 0.5, 0.5], c)).join(','));
        check('J: quantile is monotone non-decreasing in coverage and bounded by the bit count',
            (() => {
                const p = [0.1, 0.4, 0.2, 0.05, 0.3, 0.15];
                let prev = -1;
                for (let c = 0; c <= 1.0001; c += 0.05) {
                    const k = poissonBinomialQuantile(p, c);
                    if (k < prev || k > p.length) return false;
                    prev = k;
                }
                return true;
            })());
        check('J: quantile is exactly n when coverage is 1 and 0 when coverage is 0',
            poissonBinomialQuantile([0.3, 0.2, 0.5], 1) === 3 && poissonBinomialQuantile([0.3, 0.2, 0.5], 0) === 0);

        // (4) expected flip count
        check('J: expectedFlippedBits is the exact sum of the per-bit probabilities, n/2 at zero margins, 0 noiseless',
            Math.abs(expectedFlippedBits(jdots, 0.5) - Array.from(jq).reduce((a, b) => a + b, 0)) < 1e-15 &&
            expectedFlippedBits([0, 0, 0, 0], 1) === 2 &&
            expectedFlippedBits([1, 2, 3], 0) === 0);

        // (5) containment coverage: exact on the symmetric case, monotone in depth
        const jflat = [0, 0, 0, 0];
        check('J: marginContainmentCoverage on four zero-margin bits is exactly 1/16*(1,2,4,8,16)',
            [0, 1, 2, 3, 4].every((k) => Math.abs(marginContainmentCoverage(jflat, 1, k) - Math.pow(2, k - 4)) < 1e-15),
            [0, 1, 2, 3, 4].map((k) => marginContainmentCoverage(jflat, 1, k)).join(','));
        check('J: containment coverage is k=n -> 1, k=0 -> product of (1-q), and monotone non-decreasing in k',
            marginContainmentCoverage(jflat, 1, 4) === 1 &&
            (() => {
                const rng = mulberry32(81);
                for (let t = 0; t < 40; t++) {
                    const dots = Array.from({ length: 20 }, () => gauss(rng) * 0.8);
                    let prev = -1;
                    for (let k = 0; k <= 20; k++) {
                        const c = marginContainmentCoverage(dots, 0.4, k);
                        if (c < prev - 1e-12) return false;
                        prev = c;
                    }
                }
                return true;
            })());

        // (6) containment depth
        check('J: marginContainmentDepth is exact on the symmetric case (0.5->3, 0.25->2, 0.0625->0)',
            marginContainmentDepth(jflat, { noise: 1, coverage: 0.5 }) === 3 &&
            marginContainmentDepth(jflat, { noise: 1, coverage: 0.25 }) === 2 &&
            marginContainmentDepth(jflat, { noise: 1, coverage: 0.0625 }) === 0,
            [0.5, 0.25, 0.0625].map((c) => marginContainmentDepth(jflat, { noise: 1, coverage: c })).join(','));
        check('J: containment depth is 0 in the noiseless limit and never exceeds maxDepth',
            marginContainmentDepth([0.1, -0.2, 5, -9], { noise: 0, coverage: 0.99 }) === 0 &&
            marginContainmentDepth(jflat, { noise: 1, coverage: 1, maxDepth: 2 }) === 2);

        // (7) recovery coverage: exact on the symmetric case, and the two-argument consistency
        check('J: probeRecoveryCoverage at maxFlips=1 on four zero-margin bits is exactly 1/16*(1,2,3,4,5)',
            [0, 1, 2, 3, 4].every((d) => Math.abs(probeRecoveryCoverage(jflat, { noise: 1, maxFlips: 1, depth: d }) - (d + 1) / 16) < 1e-15),
            [0, 1, 2, 3, 4].map((d) => probeRecoveryCoverage(jflat, { noise: 1, maxFlips: 1, depth: d })).join(','));
        check('J: probeRecoveryCoverage at maxFlips=2 on four zero-margin bits is exactly 1,4,11 over 16 at d=0,2,4',
            Math.abs(probeRecoveryCoverage(jflat, { noise: 1, maxFlips: 2, depth: 0 }) - 1 / 16) < 1e-15 &&
            Math.abs(probeRecoveryCoverage(jflat, { noise: 1, maxFlips: 2, depth: 2 }) - 4 / 16) < 1e-15 &&
            Math.abs(probeRecoveryCoverage(jflat, { noise: 1, maxFlips: 2, depth: 4 }) - 11 / 16) < 1e-15);
        check('J: the single-bit recovery coverage equals P(no flip) + P(one flip inside the probed depth)',
            (() => {
                const rng = mulberry32(82);
                const dots = Array.from({ length: 12 }, () => gauss(rng) * 0.7);
                const q = Array.from(bitFlipProbabilities(dots, 0.5));
                const order = dots.map((d, b) => b).sort((a, b) => Math.abs(dots[a]) - Math.abs(dots[b]));
                for (const d of [0, 3, 7, 12]) {
                    const inside = new Set(order.slice(0, d));
                    let none = 1;
                    let oneInside = 0;
                    for (let b = 0; b < dots.length; b++) none *= 1 - q[b];
                    for (let b = 0; b < dots.length; b++) {
                        if (!inside.has(b)) continue;
                        let p = q[b];
                        for (let j = 0; j < dots.length; j++) if (j !== b) p *= 1 - q[j];
                        oneInside += p;
                    }
                    if (Math.abs(probeRecoveryCoverage(dots, { noise: 0.5, maxFlips: 1, depth: d }) - (none + oneInside)) > 1e-12) return false;
                }
                return true;
            })());
        check('J: recovery coverage with depth = n and maxFlips = n is exactly 1',
            Math.abs(probeRecoveryCoverage(jflat, { noise: 1, maxFlips: 4, depth: 4 }) - 1) < 1e-15);
        check('J: recovery coverage is monotone non-decreasing in maxFlips at a fixed depth',
            (() => {
                const rng = mulberry32(83);
                const dots = Array.from({ length: 16 }, () => gauss(rng) * 0.5);
                let prev = -1;
                for (let mf = 0; mf <= 16; mf++) {
                    const c = probeRecoveryCoverage(dots, { noise: 0.4, maxFlips: mf, depth: 8 });
                    if (c < prev - 1e-12) return false;
                    prev = c;
                }
                return true;
            })());

        // (8) the incremental depth solver agrees with a brute-force scan
        check('J: recoveryDepth matches a brute-force forward scan of probeRecoveryCoverage',
            (() => {
                const rng = mulberry32(84);
                for (let t = 0; t < 120; t++) {
                    const n = 3 + Math.floor(rng() * 20);
                    const dots = Array.from({ length: n }, () => gauss(rng) * (0.2 + rng() * 2));
                    const noise = 0.05 + rng() * 0.8;
                    const maxFlips = 1 + Math.floor(rng() * 4);
                    const coverage = 0.3 + rng() * 0.6;
                    const cap = Math.floor(rng() * (n + 1));
                    const fast = recoveryDepth(dots, { noise, maxFlips, coverage, maxDepth: cap });
                    let slow = cap;
                    for (let d = 0; d <= cap; d++) {
                        if (probeRecoveryCoverage(dots, { noise, maxFlips, depth: d }) >= coverage) { slow = d; break; }
                    }
                    if (fast !== slow) return false;
                }
                return true;
            })());

        // (9) the noise calibration inverts the expected flip count
        check('J: calibrateNoiseFromFlips inverts expectedFlippedBits (round-trip to 1e-6)',
            (() => {
                const rng = mulberry32(85);
                for (const target of [0.25, 0.9, 2.5, 6]) {
                    const dots = Array.from({ length: 24 }, () => gauss(rng) * 0.9);
                    const sigma = calibrateNoiseFromFlips(dots, target);
                    if (!Number.isFinite(sigma)) return false;
                    if (Math.abs(expectedFlippedBits(dots, sigma) - target) > 1e-6) return false;
                }
                return true;
            })());
        check('J: calibrateNoiseFromFlips returns 0 for a zero target and Infinity above the 1/2-per-bit ceiling',
            calibrateNoiseFromFlips([1, 2, 3], 0) === 0 && calibrateNoiseFromFlips([1, 2, 3], 1.5) === Infinity &&
            calibrateNoiseFromFlips([1, 2, 3], 2) === Infinity);

        // (10) Monte Carlo: the theory IS the measured containment / recovery
        {
            const rng = mulberry32(86);
            const dots = Array.from({ length: 24 }, () => gauss(rng) * 0.6);
            const sigma = 0.5;
            const N = 120000;
            const q = Array.from(bitFlipProbabilities(dots, sigma));
            const order = dots.map((d, b) => b).sort((a, b) => Math.abs(dots[a]) - Math.abs(dots[b]));
            for (const cfg of [
                { maxFlips: 1, depth: recoveryDepth(dots, { noise: sigma, maxFlips: 1, coverage: 0.9 }) },
                { maxFlips: 3, depth: recoveryDepth(dots, { noise: sigma, maxFlips: 3, coverage: 0.9, maxDepth: 12 }) },
            ]) {
                const inside = new Uint8Array(dots.length);
                for (let r = 0; r < cfg.depth; r++) inside[order[r]] = 1;
                let rec = 0;
                const r2 = mulberry32(87);
                for (let t = 0; t < N; t++) {
                    let flips = 0;
                    let ok = true;
                    for (let b = 0; b < dots.length; b++) if (r2() < q[b]) { flips++; if (!inside[b]) ok = false; }
                    if (ok && flips <= cfg.maxFlips) rec++;
                }
                const measured = rec / N;
                const theory = probeRecoveryCoverage(dots, { noise: sigma, maxFlips: cfg.maxFlips, depth: cfg.depth });
                check(`J: Monte Carlo matches the exact recovery coverage (maxFlips=${cfg.maxFlips}, depth=${cfg.depth})`,
                    Math.abs(measured - theory) < 0.02, `measured=${measured.toFixed(4)} theory=${theory.toFixed(4)}`);
            }
            // containment at the 0.9 depth
            const dC = marginContainmentDepth(dots, { noise: sigma, coverage: 0.9 });
            const insideC = new Uint8Array(dots.length);
            for (let r = 0; r < dC; r++) insideC[order[r]] = 1;
            let cont = 0;
            const r3 = mulberry32(88);
            for (let t = 0; t < N; t++) {
                let ok = true;
                for (let b = 0; b < dots.length; b++) if (r3() < q[b] && !insideC[b]) ok = false;
                if (ok) cont++;
            }
            const measuredC = cont / N;
            const theoryC = marginContainmentCoverage(dots, sigma, dC);
            check('J: Monte Carlo matches the exact containment coverage at the 0.9 depth',
                Math.abs(measuredC - theoryC) < 0.02 && measuredC >= 0.9 - 0.005,
                `measured=${measuredC.toFixed(4)} theory=${theoryC.toFixed(4)} depth=${dC}`);
        }

        // (11) the budget is query-adaptive: a confident query probes nothing,
        // an ambiguous one probes deep, and the depth grows with the target
        {
            const far = [4, -3, 5, -6, 3.5, -4.5];
            const near = [0.005, -0.004, 0.003, 0.002, -0.006, 0.001];
            const dFar = recoveryDepth(far, { noise: 0.2, maxFlips: 2, coverage: 0.9, maxDepth: 32 });
            const dNear = recoveryDepth(near, { noise: 0.2, maxFlips: 2, coverage: 0.9, maxDepth: 32 });
            check('J: a confident query (all margins far from the hyperplanes) needs depth 0, an ambiguous one probes deep',
                dFar === 0 && dNear > dFar, `far=${dFar} near=${dNear}`);
            check('J: the depth is monotone non-decreasing in the target coverage',
                (() => {
                    const rng = mulberry32(89);
                    const dots = Array.from({ length: 20 }, () => gauss(rng) * 0.4);
                    let prev = -1;
                    for (let c = 0.1; c <= 0.999; c += 0.05) {
                        const d = recoveryDepth(dots, { noise: 0.3, maxFlips: 3, coverage: c, maxDepth: 20 });
                        if (d < prev) return false;
                        prev = d;
                    }
                    return true;
                })());
        }
    } catch (e) {
        check('adaptive-budget block completed', false, e.stack);
    }

    // ---- config --------------------------------------------------------------
    check('config: resolveBitWeightConfig defaults to auto noise / 1 table and clamps maxTables >= 1',
        (() => {
            const r = resolveBitWeightConfig(null);
            return r.noise === 'auto' && r.maxTables === 1 && DEFAULT_BITWEIGHT_CONFIG.noise === 'auto' &&
                resolveBitWeightConfig({ noise: 0.5, maxTables: 0 }).maxTables === 1 &&
                resolveBitWeightConfig({ noise: 0.5 }).noise === 0.5 &&
                resolveBitWeightConfig({ noise: 'bogus' }).noise === 'auto';
        })());

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
