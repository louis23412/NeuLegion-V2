// Bit-reliability theory for the LSH hash family: which hash bits carry signal,
// and how much.
//
// `memory/lsh.js` hashes each prototype's projection onto a set of unit
// hyperplane directions and keeps only the SIGN of the dot product as one bit.
// Charikar (2002) tells us the bit-collision probability of two points separated
// by angle theta: Pr[differ] = theta/pi. This module answers the complementary
// question the Round-14 sweep exposed: how much does a single bit tell us about
// a *noisy* neighbour, and how should that change the hash / the candidate
// ranking?
//
// Model. Fix one hash direction w (unit) and consider a prototype whose
// projection on w is p. A near neighbour perturbs the prototype by isotropic
// noise delta with per-direction variance sigma^2, so its projection is
// p + eps with eps ~ N(0, sigma^2). The stored bit is sign(p); the neighbour's
// bit is sign(p + eps); the bit is "wrong" (flips) when the noise dominates the
// signal and opposes its side. Averaging the flip events over the bivariate
// normal (p, p+eps) with Var(p) = lambda (the data variance along w),
// Var(eps) = sigma^2 and Cov = lambda gives the exact closed form
//
//     rho     = sqrt(lambda / (lambda + sigma^2))         (the signal/noise cosine)
//     P(flip) = arccos(rho) / pi                          (== Charikar's theta/pi)
//
// with limits P(flip) -> 1/2 as lambda -> 0 (a pure-noise bit) and P(flip) -> 0
// as lambda -> infinity (a stable, informative bit). `flipProbability` is
// verified against Monte Carlo in `bitweight.test.js`.
//
// Consequences this module encodes:
//   * A bit is a BINARY SYMMETRIC CHANNEL about the neighbourhood with crossover
//     P(flip). Its information is the channel capacity `bitInformation`
//     = 1 - H2(P(flip)) (H2 = binary entropy), which is 0 at lambda = 0 and -> 1
//     as lambda -> infinity. So a low-variance ("tail") direction carries no
//     information and should be down-weighted (weighted Hamming, arXiv
//     2009.08591) rather than trusted equally (Density Sensitive Hashing, arXiv
//     1205.2930, is the related "hashing should follow the data density" line).
//   * `selectReliableRank` formalises "don't align the tail": a random unit
//     direction captures E[(x.w)^2] = trace(C)/dim variance on average, so a
//     principal component with lambda <= trace/dim is *worse than a random
//     direction* and must not take an aligned bit. This replaces the magic
//     `lowDim/4` constant from Round 14 with a data-driven criterion.
//   * The same model explains why margin-ordered multi-probe is optimal: under
//     this noise model a stored bit flips with probability
//     Phi(-|margin|/sigma) (`flipProbabilityFromMargin`), which is monotone
//     decreasing in |margin|, so probing the smallest-margin bits first (Lv et
//     al., VLDB 2007) IS probing the most-likely-flipped bits first.
//   * Because the per-bit flip probabilities are known for a given query, the
//     probe DEPTH itself can be derived per query instead of fixed: the number
//     of simultaneously flipped bits is Poisson-binomial, and the probability
//     that the whole flipped set lies in the k smallest-margin bits is a product
//     of (1 - P(flip)) over the complement. `marginContainmentDepth` inverts
//     that for a target coverage — the query-adaptive budget of NeuRoute
//     (arXiv 2608.15438) and adaptive bucket probing (arXiv 2604.04603).
//
// The module is pure and deterministic: no I/O, no RNG, no instance state. It is
// imported by `memory/binarypc.js` (`rankPolicy` / the noise floor), which the
// locked `lsh` bag imports behind the default-off `_pcaHashConfig`, so with the
// flag null nothing here runs and the golden fingerprints are unchanged.

export const DEFAULT_BITWEIGHT_CONFIG = Object.freeze({
    noise: 'auto',   // 'auto' | a finite variance | null (=> noiseless)
    maxTables: 1,    // tables per LSH set used when scoring candidates
});

export function resolveBitWeightConfig(config) {
    const cfg = config || {};
    const noise = cfg.noise === 'auto' || cfg.noise === null || Number.isFinite(cfg.noise)
        ? cfg.noise
        : DEFAULT_BITWEIGHT_CONFIG.noise;
    const rawTables = Number(cfg.maxTables);
    const maxTables = Number.isFinite(rawTables) ? Math.max(1, Math.floor(rawTables)) : DEFAULT_BITWEIGHT_CONFIG.maxTables;
    return { noise, maxTables };
}

// Binary entropy H2(q) in bits, with the exact limiting values H2(0) = H2(1) = 0
// and H2(1/2) = 1.
export function binaryEntropy(q) {
    if (!Number.isFinite(q)) return 0;
    if (q <= 0 || q >= 1) return 0;
    return -q * Math.log2(q) - (1 - q) * Math.log2(1 - q);
}

// ---------------------------------------------------------------------------
// Normal CDF (Abramowitz & Stegun 26.2.17 rational approximation for erf, max
// absolute error ~1.5e-7). Kept local so this module has no dependency on the
// analysis battery; `analysis/performance.js` has its own copy for the finance
// path.
// ---------------------------------------------------------------------------
export function erf(x) {
    if (!Number.isFinite(x)) return x > 0 ? 1 : -1;
    if (x === 0) return 0;
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    if (ax > 6) return sign;
    const t = 1 / (1 + 0.3275911 * ax);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
    return sign * y;
}

export function normalCdf(x) {
    if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
    if (x === 0) return 0.5;
    return 0.5 * (1 + erf(x / Math.SQRT2));
}

// ---------------------------------------------------------------------------
// The reliability law.
// ---------------------------------------------------------------------------

// Exact bit-flip probability for a direction whose data variance is `variance`
// under isotropic noise of per-direction variance `noise`:
//     P(flip) = arccos(sqrt(lambda / (lambda + sigma^2))) / pi.
// `variance <= 0` is a pure-noise bit (1/2); `noise <= 0` is the noiseless limit.
export function flipProbability(variance, noise) {
    const v = Number.isFinite(variance) ? Math.max(0, variance) : 0;
    const n = Number.isFinite(noise) ? Math.max(0, noise) : 0;
    if (n <= 0) return v > 0 ? 0 : 0.5;
    if (v <= 0) return 0.5;
    const rho = Math.sqrt(v / (v + n));
    return Math.acos(Math.min(1, rho)) / Math.PI;
}

// The BSC "advantage" 1 - 2*P(flip): 0 for a pure-noise bit, -> 1 for a perfectly
// stable one. This is the natural per-bit Hamming weight (arXiv 2009.08591).
export function reliabilityWeight(variance, noise) {
    const q = flipProbability(variance, noise);
    return Math.min(1, Math.max(0, 1 - 2 * q));
}

// Channel capacity of the bit (bits of information about the neighbourhood):
// 1 - H2(P(flip)). 0 when the bit is pure noise, 1 when it never flips.
export function bitInformation(variance, noise) {
    return 1 - binaryEntropy(flipProbability(variance, noise));
}

// Per-bit flip probability as a function of the query's signed margin on that
// bit: Phi(-|margin|/sigma). Monotone decreasing in |margin|, which is exactly
// why margin-ordered multi-probe (Lv et al. 2007) probes the most-likely-flipped
// bits first. `flipProbability(variance, noise)` is the average of this over a
// signal distributed as N(0, variance) — the two descriptions are the same
// channel.
export function flipProbabilityFromMargin(margin, noise) {
    const m = Number.isFinite(margin) ? Math.abs(margin) : 0;
    const n = Number.isFinite(noise) ? Math.max(0, noise) : 0;
    if (n <= 0) return m > 0 ? 0 : 0.5;
    if (m === 0) return 0.5;
    return normalCdf(-m / n);
}

// ---------------------------------------------------------------------------
// Choosing which directions deserve a hash bit.
// ---------------------------------------------------------------------------

// Noise-variance estimate from the eigenvalue spectrum. `sub-mean` (the default)
// averages the eigenvalues below the random-direction baseline trace/dim — the
// noise-dominated tail — which is where the noise floor actually lives. `min`
// takes the smallest eigenvalue, and `median-tail` the median of the sub-mean
// part. Always finite and non-negative.
export function estimateNoiseVariance(eigenvalues, { policy = 'sub-mean', totalVariance = null, dim = null } = {}) {
    const vals = Array.isArray(eigenvalues) || ArrayBuffer.isView(eigenvalues)
        ? Array.from(eigenvalues).filter((v) => Number.isFinite(v) && v > 0)
        : [];
    if (vals.length === 0) return 0;
    if (policy === 'min') return Math.min(...vals);
    const mean = Number.isFinite(totalVariance) && Number.isFinite(dim) && dim > 0
        ? totalVariance / dim
        : vals.reduce((s, v) => s + v, 0) / vals.length;
    const tail = vals.filter((v) => v < mean);
    const pick = tail.length > 0 ? tail : [Math.min(...vals)];
    if (policy === 'median-tail') {
        const sorted = pick.slice().sort((a, b) => a - b);
        const mid = sorted.length >> 1;
        return sorted.length % 2 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
    }
    return pick.reduce((s, v) => s + v, 0) / pick.length;
}

// How many leading principal directions deserve an aligned hash bit.
//
//   'above-mean' (default): count eigenvalues strictly above the random-direction
//     baseline trace/dim. Provable criterion: a random unit direction captures
//     E[(x.w)^2] = trace(C)/dim variance in expectation, so any PC at or below
//     the baseline is no better than a random direction and aligning to it only
//     spends a bit on the noise-dominated tail.
//   'noise': count eigenvalues above `factor * noise`.
//
// Always returns at least 1 (a hash needs a direction) and never more than the
// number of eigenvalues supplied.
export function selectReliableRank(eigenvalues, { policy = 'above-mean', totalVariance = null, dim = null, noise = null, factor = 1 } = {}) {
    const vals = Array.isArray(eigenvalues) || ArrayBuffer.isView(eigenvalues) ? Array.from(eigenvalues) : [];
    if (vals.length === 0) return 1;
    if (policy === 'noise') {
        const scale = Number.isFinite(noise) ? Math.max(0, noise) * (Number.isFinite(factor) ? Math.max(0, factor) : 1) : 0;
        if (scale <= 0) return vals.length;
        let count = 0;
        for (const v of vals) if (Number.isFinite(v) && v > scale) count++;
        return Math.max(1, Math.min(vals.length, count));
    }
    const mean = Number.isFinite(totalVariance) && Number.isFinite(dim) && dim > 0
        ? totalVariance / dim
        : vals.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0) / vals.length;
    let count = 0;
    for (const v of vals) if (Number.isFinite(v) && v > mean) count++;
    return Math.max(1, Math.min(vals.length, count));
}

// Per-bit reliability weights from an array of per-direction data variances:
// weights[b] = 1 - 2*P(flip). With uniform variances the weights are uniform, so
// the weighted-Hamming ranking below collapses to plain Hamming — the weighting
// only bites once the directions differ in reliability (i.e. once the hash is
// data-aligned).
export function reliabilityWeights(variances, { noise = 'auto' } = {}) {
    const vals = Array.from(variances, (v) => (Number.isFinite(v) ? Math.max(0, v) : 0));
    const sigma2 = noise === 'auto' ? estimateNoiseVariance(vals) : noise;
    return Float64Array.from(vals, (v) => reliabilityWeight(v, sigma2));
}

// ---------------------------------------------------------------------------
// Query-adaptive probe budgeting (NeuRoute arXiv 2608.15438; adaptive bucket
// probing arXiv 2604.04603).
// ---------------------------------------------------------------------------
//
// Lv et al. probe in margin order, but with a FIXED budget: the same number of
// bits for every query. Two lines of recent work say the budget should follow
// the query. NeuRoute (arXiv 2608.15438) uses the query's own logits as an
// uncertainty signal and only perturbs the bits it is least sure about, while
// "Cardinality Estimation ... with Adaptive Bucket Probing" (arXiv 2604.04603)
// adaptively explores neighbouring buckets "accounting for distance thresholds
// of varying magnitudes". The flip law above makes that computable: under the
// isotropic-noise model each hash bit flips independently with probability
// q_b = Phi(-|margin_b|/sigma), so
//
//   * the number of simultaneously flipped bits K is Poisson-binomial over the
//     {q_b} (`poissonBinomialPmf` / `poissonBinomialQuantile`), which bounds how
//     many bits a perturbation must be allowed to touch at once, and
//   * the probability that the WHOLE flipped set is contained in the k
//     smallest-margin bits is the exact product
//         coverage(k) = prod_{b not in top-k} (1 - q_b)
//     (`marginContainmentCoverage`), because containment fails iff some
//     remaining bit flips. That product is monotone non-decreasing in k, so the
//     smallest k reaching a target coverage (`marginContainmentDepth`) is the
//     provably sufficient probe depth for THIS query.
//
// Two properties make this the right primitive. It is query-adaptive: a query
// far from every hyperplane (all margins large) needs depth 0 — the exact key
// already meets the target probability — while a query sitting on many
// hyperplanes needs a deep probe. And in the noiseless limit (sigma -> 0) every
// q_b -> 0, so the depth is 0 for any query: no probing at all, exactly what the
// flip lemma says (no perturbation, no bit flips). `expectedFlippedBits` is the
// model's mean of K, a cheap scalar a caller can log or threshold on.

// Per-bit flip probability of a query against a set of hash directions:
// q_b = Phi(-|dots[b]| / sigma). `dots` are the query's signed projections (its
// margins), one per bit; the raw sign pattern is the hash.
export function bitFlipProbabilities(dots, noise) {
    const n = dots ? dots.length : 0;
    const out = new Float64Array(n);
    for (let b = 0; b < n; b++) out[b] = flipProbabilityFromMargin(dots[b], noise);
    return out;
}

// Exact Poisson-binomial pmf of K = sum of independent Bernoulli(probs[i]):
// pmf[k] = P(exactly k of the events occur). O(n^2) dynamic programming, no
// approximation; the returned array has length n+1 and sums to 1.
export function poissonBinomialPmf(probs) {
    const p = Array.from(probs || [], (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0));
    const n = p.length;
    const pmf = new Float64Array(n + 1);
    pmf[0] = 1;
    for (let i = 0; i < n; i++) {
        const q = p[i];
        for (let k = i + 1; k >= 1; k--) pmf[k] = pmf[k] * (1 - q) + pmf[k - 1] * q;
        pmf[0] *= 1 - q;
    }
    return pmf;
}

// Smallest k with P(K <= k) >= coverage, i.e. the coverage-quantile of the
// Poisson-binomial count — "how many bits should a perturbation be willing to
// flip at once" for this query. 0 when even zero flips already meet the target.
export function poissonBinomialQuantile(probs, coverage = 0.9) {
    const pmf = poissonBinomialPmf(probs);
    const n = pmf.length - 1;
    const c = Number.isFinite(coverage) ? Math.min(1, Math.max(0, coverage)) : 0.9;
    if (n <= 0 || c <= 0) return 0;
    if (c >= 1) return n;
    let acc = 0;
    for (let k = 0; k <= n; k++) {
        acc += pmf[k];
        if (acc >= c - 1e-12) return k;
    }
    return n;
}

// Model mean number of flipped bits, sum(q_b) — the exact mean of K (linearity
// of expectation, no independence needed). Diagnostic.
export function expectedFlippedBits(dots, noise) {
    const n = dots ? dots.length : 0;
    let sum = 0;
    for (let b = 0; b < n; b++) sum += flipProbabilityFromMargin(dots[b], noise);
    return sum;
}

// Exact probability (under independent directions) that every flipped bit lies
// within the k smallest-margin bits:
//     coverage(k) = prod_{b not in top-k} (1 - q_b).
// Containment fails iff some remaining bit flips; q_b is smallest on the
// remaining (largest-margin) bits, so coverage is monotone non-decreasing in k
// and exactly 1 at k = n.
export function marginContainmentCoverage(dots, noise, k) {
    const n = dots ? dots.length : 0;
    if (n === 0) return 1;
    const depth = Number.isFinite(k) ? Math.max(0, Math.min(n, Math.floor(k))) : 0;
    if (depth >= n) return 1;
    const inside = new Uint8Array(n);
    if (depth > 0) {
        const idx = new Array(n);
        for (let b = 0; b < n; b++) idx[b] = b;
        const mag = (b) => { const v = dots[b]; return Number.isFinite(v) ? Math.abs(v) : 0; };
        idx.sort((a, b) => { const da = mag(a); const db = mag(b); return da !== db ? da - db : a - b; });
        for (let r = 0; r < depth; r++) inside[idx[r]] = 1;
    }
    let cov = 1;
    for (let b = 0; b < n; b++) if (!inside[b]) cov *= 1 - flipProbabilityFromMargin(dots[b], noise);
    return Math.min(1, Math.max(0, cov));
}

// Smallest probe depth k whose containment coverage reaches `coverage`,
// saturated at `maxDepth`. Coverage is monotone in k so a bisection is exact;
// 0 means the exact key alone already meets the target (a query far from every
// hyperplane), and the noiseless limit always returns 0.
export function marginContainmentDepth(dots, { noise = 0, coverage = 0.9, maxDepth = Infinity } = {}) {
    const n = dots ? dots.length : 0;
    if (n === 0) return 0;
    const cap = Number.isFinite(maxDepth) ? Math.max(0, Math.min(n, Math.floor(maxDepth))) : n;
    if (cap === 0) return 0;
    const c = Number.isFinite(coverage) ? Math.min(1, Math.max(0, coverage)) : 0.9;
    if (marginContainmentCoverage(dots, noise, cap) < c) return cap;
    let lo = 0;
    let hi = cap;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (marginContainmentCoverage(dots, noise, mid) >= c) hi = mid; else lo = mid + 1;
    }
    return lo;
}

// Exact probability that a probe sequence RECOVERS a noisy neighbour under the
// independence model. A margin-ordered sequence that probes the top-`depth`
// bits enumerates every subset of them of size <= `maxFlips`, so it recovers
// the neighbour iff (a) no bit outside the top-`depth` flips — probability
// `marginContainmentCoverage` — AND (b) at most `maxFlips` of the inside bits
// flip. Conditioning on (a) leaves the inside flip count Poisson-binomial, so
//
//   P(recover) = [ prod_{b not in top-depth} (1 - q_b) ] * P(K_inside <= maxFlips)
//
// which is exact (no union bound) and reduces to the single-bit mode at
// `maxFlips = 1`. `depth = 0` with `maxFlips >= 0` is the probability that the
// exact key alone already matches, i.e. P(no bit flips at all).
export function probeRecoveryCoverage(dots, { noise = 0, maxFlips = 1, depth = 0 } = {}) {
    const n = dots ? dots.length : 0;
    if (n === 0) return 1;
    const d = Number.isFinite(depth) ? Math.max(0, Math.min(n, Math.floor(depth))) : 0;
    const mf = Math.max(0, Math.floor(Number.isFinite(maxFlips) ? maxFlips : 1));
    const inside = new Uint8Array(n);
    if (d > 0) {
        const idx = new Array(n);
        for (let b = 0; b < n; b++) idx[b] = b;
        const mag = (b) => { const v = dots[b]; return Number.isFinite(v) ? Math.abs(v) : 0; };
        idx.sort((a, b) => { const da = mag(a); const db = mag(b); return da !== db ? da - db : a - b; });
        for (let r = 0; r < d; r++) inside[idx[r]] = 1;
    }
    let factor = 1;
    const insideProbs = [];
    for (let b = 0; b < n; b++) {
        const q = flipProbabilityFromMargin(dots[b], noise);
        if (inside[b]) insideProbs.push(q);
        else factor *= 1 - q;
    }
    const pmf = poissonBinomialPmf(insideProbs);
    let cdf = 0;
    for (let k = 0; k <= mf && k < pmf.length; k++) cdf += pmf[k];
    return Math.min(1, Math.max(0, factor * cdf));
}

// Smallest probe depth whose recovery coverage (`probeRecoveryCoverage`)
// reaches `coverage`, saturated at `maxDepth`. Computed in ONE incremental pass
// — sort the bits by |margin| once, keep a suffix product of (1 - q) for the
// containment factor, and grow the Poisson-binomial pmf of the inside count one
// Bernoulli at a time — so the whole scan is O(n^2) rather than O(n^3). The
// coverage term is not proven monotone in depth, so this is a forward scan
// returning the FIRST depth that meets the target (always well-defined; `cap`
// if none do).
export function recoveryDepth(dots, { noise = 0, maxFlips = 1, coverage = 0.9, maxDepth = Infinity } = {}) {
    const n = dots ? dots.length : 0;
    if (n === 0) return 0;
    const cap = Number.isFinite(maxDepth) ? Math.max(0, Math.min(n, Math.floor(maxDepth))) : n;
    const mf = Math.max(0, Math.floor(Number.isFinite(maxFlips) ? maxFlips : 1));
    const c = Number.isFinite(coverage) ? Math.min(1, Math.max(0, coverage)) : 0.9;
    const idx = new Array(n);
    for (let b = 0; b < n; b++) idx[b] = b;
    const mag = (b) => { const v = dots[b]; return Number.isFinite(v) ? Math.abs(v) : 0; };
    idx.sort((a, b) => { const da = mag(a); const db = mag(b); return da !== db ? da - db : a - b; });
    const qs = new Float64Array(n);
    for (let r = 0; r < n; r++) qs[r] = flipProbabilityFromMargin(dots[idx[r]], noise);
    const suffix = new Float64Array(n + 1);
    suffix[n] = 1;
    for (let r = n - 1; r >= 0; r--) suffix[r] = suffix[r + 1] * (1 - qs[r]);
    const pmf = new Float64Array(n + 1);
    pmf[0] = 1;
    for (let d = 0; d <= cap; d++) {
        let cdf = 0;
        for (let k = 0; k <= mf && k <= d; k++) cdf += pmf[k];
        if (suffix[d] * cdf >= c) return d;
        if (d < n) {
            const q = qs[d];
            for (let k = d + 1; k >= 1; k--) pmf[k] = pmf[k] * (1 - q) + pmf[k - 1] * q;
            pmf[0] *= 1 - q;
        }
    }
    return cap;
}

// Invert `expectedFlippedBits` for the noise scale: the sigma at which the flip
// model's mean flip count equals `targetExpectedFlips`. Strictly increasing in
// sigma (up to the 1/2 ceiling a pure-noise bit reaches as sigma -> infinity),
// so a bisection is exact. This is how a caller calibrates the model's noise
// scale from an observed mean Hamming distance between a query and its true
// neighbour — the query-side logit signal NeuRoute (arXiv 2608.15438) also
// derives from data rather than hard-coding.
export function calibrateNoiseFromFlips(dots, targetExpectedFlips) {
    const n = dots ? dots.length : 0;
    if (n === 0) return 0;
    const ceiling = 0.5 * n;
    let target = Number.isFinite(targetExpectedFlips) ? Number(targetExpectedFlips) : 0;
    if (target <= 0) return 0;
    if (target >= ceiling) return Infinity;
    const f = (s) => expectedFlippedBits(dots, s);
    let lo = 0;
    let hi = 1;
    let guard = 0;
    while (f(hi) < target && guard++ < 400) hi *= 2;
    for (let i = 0; i < 100; i++) {
        const mid = 0.5 * (lo + hi);
        if (f(mid) < target) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
}

// ---------------------------------------------------------------------------
// Weighted-Hamming scoring (arXiv 2009.08591).
// ---------------------------------------------------------------------------

// Weighted Hamming distance between two 0/1 code vectors. Symmetric,
// non-negative, zero exactly on equality, and equal to the plain Hamming
// distance when every weight is 1.
export function weightedHamming(codesA, codesB, weights) {
    const n = Math.min(codesA.length, codesB.length, weights.length);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        if (codesA[i] !== codesB[i]) sum += weights[i];
    }
    return sum;
}

// The same distance directly on the PACKED hash words the index stores (plain
// numbers when bits <= 32, BigInt otherwise), using the precomputed `bitMasks`
// from `_getLshBitMasks`. Avoids unpacking the word into a code array on the hot
// path.
export function weightedKeyDistance(wordA, wordB, weights, bitMasks) {
    const n = Math.min(weights.length, bitMasks.length);
    const big = typeof wordA === 'bigint' || typeof wordB === 'bigint';
    const zero = big ? 0n : 0;
    const a = big ? BigInt(wordA) : wordA;
    const b = big ? BigInt(wordB) : wordB;
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const mask = big ? BigInt(bitMasks[i]) : bitMasks[i];
        if (((a & mask) !== zero) !== ((b & mask) !== zero)) sum += weights[i];
    }
    return sum;
}

// Expand a packed hash word into a 0/1 Uint8Array (used by the tests to check
// `weightedKeyDistance` against the unpacked definition, and by any caller that
// needs the code form).
export function unpackWord(word, bits, bitMasks) {
    const out = new Uint8Array(bits);
    const big = typeof word === 'bigint';
    const zero = big ? 0n : 0;
    for (let b = 0; b < bits; b++) {
        const mask = big ? BigInt(bitMasks[b]) : bitMasks[b];
        out[b] = (word & mask) !== zero ? 1 : 0;
    }
    return out;
}
