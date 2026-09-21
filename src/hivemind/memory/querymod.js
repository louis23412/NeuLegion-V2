// Dynamic query modification for binary LSH (Claydon, Connor & Dearle,
// arXiv 2605.23807) — the query-side companion to the data-aware hash.
//
// Binary LSH (Charikar 2002) hashes a query q to a bit word h(q) and retrieves
// the bucket of prototypes sharing that word. Two distinct failure modes limit
// recall: (a) the query's word is in a *sparse* bucket, so the true neighbours
// live in neighbouring buckets (multi-probe attacks this, see memory/multiprobe
// and memory/bitweight), and (b) the query *itself* is a poor representative of
// its own neighbourhood — every hash bit is a margin sign, and a query that no
// member of its k-nearest-neighbour set agrees with on ANY direction hashes to
// a bucket that contains none of them. Dynamic query modification attacks (b):
// it replaces the query at query time with the l2-normalised CENTROID
// <c> of the neighbours found so far, and continues the search with <c>.
//
// Why the centroid is the right representative (the paper's Theorems 1-2 and
// Appendix C), each of which this module makes exact and testable:
//
//   * Theorem 1 (maximality). For a finite set S of unit vectors, the unit
//     vector maximising sum_{x in S} (x . u) is exactly u = <c>, the normalised
//     centroid of S. Proof: sum_{x in S} (x . u) = (sum_{x in S} x) . u <=
//     ||sum x|| by Cauchy-Schwarz, with equality iff u is parallel to sum x.
//     `dotProductSum(<c>, S)` therefore equals `||sum_{x in S} x||` exactly.
//
//   * Theorem 2 (average collision probability). Charikar's law gives
//     Pr[h(a) = h(b)] = 1 - arccos(a.b)/pi for unit a, b, so the average
//     collision probability of a representative u against S is
//     ACP(u, S) = 1 - mean_x arccos(x.u)/pi. With the first-order Maclaurin
//     expansion arccos(z) = pi/2 - z + O(z^3), ACP(u, S) ~= 1/2 +
//     dotProductSum(u, S)/(k pi), which Theorem 1 says is maximised at u = <c>:
//     the centroid maximises the first-order ACP exactly.
//
//   * Appendix C.1 (minimal average covariance): <c> is also the unit vector
//     minimising the average residual covariance
//     (1/k^2) sum_i sum_j [ x_i.x_j - (x_i.u)(x_j.u) ]. The second term is
//     ((sum_i x_i.u)/k)^2, so minimising the covariance is exactly maximising
//     |sum_i x_i.u| — the same objective as Theorem 1, hence again <c>.
//
//   * Hash-failure elimination (Section 6.4). Because <c> is parallel to
//     sum_{x in S} x, for any hyperplane w the centroid's bit is
//     sign(sum_x (x.w)); whenever that sum is non-zero at least one x has the
//     same sign, so the centroid COLLIDES with at least one member of S on
//     EVERY direction. A raw query q has no such guarantee — Appendix A of the
//     paper exhibits hash-failure cases where q collides with no member at all.
//     This module makes both statements exact (`centroidCollidesWithSet` is
//     always true, `queryCollidesWithSet` is not) and the test suite proves the
//     first and exhibits the second.
//
// The module is pure and deterministic: no I/O, no RNG, no instance state. It
// is imported by the locked `lsh` bag behind the default-off `_queryModConfig`,
// so with the flag null nothing here runs and the golden fingerprints are
// unchanged.
//
// References: Claydon, Connor & Dearle, "Dynamic Query Modification for Binary
// Locality Sensitive Hashing" (arXiv 2605.23807); Charikar, STOC 2002 (the
// sign-random-projection collision law); Lv et al., VLDB 2007 (multi-probe,
// the complementary index-side recall fix); Rocchio (1971) / pseudo-relevance
// feedback, the information-retrieval ancestor of "move the query toward the
// centroid of the results you found".

export const DEFAULT_QUERYMOD_CONFIG = Object.freeze({
    alpha: 1,          // 0 = query unchanged, 1 = pure centroid, between = RoCchio-style blend
    topK: 16,          // candidates (closest to the query) whose centroid is taken; 0 = all
    rounds: 1,         // query-modification rounds (each round re-hashes and re-probes)
    maxFlips: 2,       // multi-bit probe budget for the MODIFIED query (an empty bucket is common)
    probeBudget: 8,    // number of perturbations probed around the modified query's word
});

export function resolveQueryModConfig(config) {
    const cfg = config || {};
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    return {
        alpha: Math.min(1, Math.max(0, num(cfg.alpha, DEFAULT_QUERYMOD_CONFIG.alpha))),
        topK: Math.max(0, Math.floor(num(cfg.topK, DEFAULT_QUERYMOD_CONFIG.topK))),
        rounds: Math.max(1, Math.floor(num(cfg.rounds, DEFAULT_QUERYMOD_CONFIG.rounds))),
        maxFlips: Math.max(1, Math.min(8, Math.floor(num(cfg.maxFlips, DEFAULT_QUERYMOD_CONFIG.maxFlips)))),
        probeBudget: Math.max(0, Math.floor(num(cfg.probeBudget, DEFAULT_QUERYMOD_CONFIG.probeBudget))),
    };
}

// ---------------------------------------------------------------------------
// Vector primitives. Inputs may be Array / Float32Array / Float64Array; every
// function is defensive about non-finite entries and mismatched lengths.
// ---------------------------------------------------------------------------

function isVector(v) {
    return !!v && (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length > 0;
}

function usableVectors(vectors) {
    const out = [];
    if (!vectors) return out;
    for (const v of vectors) if (isVector(v)) out.push(v);
    return out;
}

export function dot(a, b) {
    const n = Math.min(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += a[i] * b[i];
    return sum;
}

export function norm(v) {
    let sum = 0;
    for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
    return Math.sqrt(sum);
}

// Cosine similarity in [-1, 1]; 0 for a degenerate (zero-norm or mismatched)
// pair. Every projection in the LSH projection space is unit norm, so this is
// normally just the dot product.
export function cosine(a, b) {
    if (!isVector(a) || !isVector(b) || a.length !== b.length) return 0;
    const na = norm(a);
    const nb = norm(b);
    if (!(na > 0) || !(nb > 0)) return 0;
    return Math.min(1, Math.max(-1, dot(a, b) / (na * nb)));
}

// Unit vector in the direction of `v`, or null when v is missing/zero/non-finite.
export function normalize(v) {
    if (!isVector(v)) return null;
    const n = norm(v);
    if (!(n > 0)) return null;
    const out = new Float64Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
    return out;
}

// Arithmetic mean of a set of equal-length vectors (drops malformed entries);
// null when nothing usable remains.
export function meanVector(vectors) {
    const list = usableVectors(vectors);
    if (list.length === 0) return null;
    const d = list[0].length;
    const out = new Float64Array(d);
    let used = 0;
    for (const v of list) {
        if (v.length !== d) continue;
        let ok = true;
        for (let i = 0; i < d; i++) {
            if (!Number.isFinite(v[i])) { ok = false; break; }
        }
        if (!ok) continue;
        for (let i = 0; i < d; i++) out[i] += v[i];
        used++;
    }
    if (used === 0) return null;
    for (let i = 0; i < d; i++) out[i] /= used;
    return out;
}

// <c>: the l2-normalised centroid of the set — the paper's modified query. Null
// for an empty set or a zero mean (antipodal inputs).
export function normalizedCentroid(vectors) {
    return normalize(meanVector(vectors));
}

// ---------------------------------------------------------------------------
// The objective functions the theorems are about.
// ---------------------------------------------------------------------------

// sum_{x in S} (x . u) — Theorem 1's objective, exactly maximised at u = <c>.
export function dotProductSum(u, vectors) {
    if (!isVector(u)) return 0;
    let sum = 0;
    for (const x of usableVectors(vectors)) sum += dot(u, x);
    return sum;
}

// Charikar's collision law for unit vectors: Pr[h(a) = h(b)] = 1 - arccos(a.b)/pi.
// `cos` is the (unit) inner product; clamped, and the degenerate value 1 (a
// point with itself) gives exactly 1.
export function collisionProbabilityFromCos(cos) {
    const c = Number.isFinite(cos) ? Math.min(1, Math.max(-1, cos)) : 1;
    return 1 - Math.acos(c) / Math.PI;
}

export function collisionProbability(u, x) {
    return collisionProbabilityFromCos(cosine(u, x));
}

// ACP(u, S) = mean_{x in S} Pr[h(u) = h(x)] — the paper's measure of how
// likely a representative u is to hash with the neighbourhood.
export function averageCollisionProbability(u, vectors) {
    const list = usableVectors(vectors);
    if (list.length === 0 || !isVector(u)) return 0;
    let sum = 0;
    for (const x of list) sum += collisionProbabilityFromCos(cosine(u, x));
    return sum / list.length;
}

// The first-order Maclaurin approximation ACP(u, S) ~= 1/2 +
// dotProductSum(u, S)/(k pi), exactly maximised at u = <c> by Theorem 1.
export function firstOrderCollisionProbability(u, vectors) {
    const list = usableVectors(vectors);
    if (list.length === 0) return 0.5;
    return 0.5 + dotProductSum(u, list) / (list.length * Math.PI);
}

// Average residual covariance (paper Appendix C.1):
//   (1/k^2) sum_i sum_j [ x_i.x_j - (x_i.u)(x_j.u) ].
// Exactly minimised at u = <c> (the first term is constant in u and the second
// equals ((sum_i x_i.u)/k)^2).
export function averageCovariance(u, vectors) {
    const list = usableVectors(vectors);
    if (list.length === 0 || !isVector(u)) return 0;
    const k = list.length;
    let total = 0;
    for (let i = 0; i < k; i++) {
        const ui = dot(list[i], u);
        for (let j = 0; j < k; j++) {
            total += dot(list[i], list[j]) - ui * dot(list[j], u);
        }
    }
    return total / (k * k);
}

// ---------------------------------------------------------------------------
// Hash-bit collision (the Section 6.4 "hash failure" property).
// ---------------------------------------------------------------------------

// One hash bit: the sign convention of `_computeLSHHashesLow` (bit set iff the
// dot product is strictly positive).
export function signBit(value) {
    return value > 0 ? 1 : 0;
}

export function hashBits(v, directions) {
    const out = new Uint8Array(directions ? directions.length : 0);
    for (let b = 0; b < out.length; b++) out[b] = signBit(dot(v, directions[b]));
    return out;
}

// Does `u` share its hyperplane-sign with at least one member of S?
export function collidesWithSet(u, vectors, direction) {
    if (!isVector(u) || !isVector(direction)) return false;
    const bit = signBit(dot(u, direction));
    for (const x of usableVectors(vectors)) if (signBit(dot(x, direction)) === bit) return true;
    return false;
}

// The centroid ALWAYS collides with at least one member, on every direction
// (the exact proof of the paper's Section 6.4 observation). False only for an
// empty/degenerate set.
export function centroidCollidesWithSet(vectors, direction) {
    const c = normalizedCentroid(vectors);
    if (!c) return false;
    return collidesWithSet(c, vectors, direction);
}

// How many of `directions` the representative `u` collides on (with >= 1 member
// of S). The centroid scores a full sweep; a query does not.
export function collisionCoverage(u, vectors, directions) {
    let count = 0;
    for (const w of usableVectors(directions)) if (collidesWithSet(u, vectors, w)) count++;
    return count;
}

// ---------------------------------------------------------------------------
// Building the modified query.
// ---------------------------------------------------------------------------

// The candidates closest to `query` (largest cosine), ties broken by input
// order so the selection is total and deterministic. `topK <= 0` keeps all.
export function selectCandidates(query, candidates, topK = 0) {
    const list = usableVectors(candidates);
    const k = Number.isFinite(topK) ? Math.max(0, Math.floor(topK)) : 0;
    if (k === 0 || list.length <= k) return list;
    const scored = list.map((v, i) => ({ v, i, s: cosine(query, v) }));
    scored.sort((a, b) => (a.s !== b.s ? b.s - a.s : a.i - b.i));
    return scored.slice(0, k).map((e) => e.v);
}

// RoCchio-style blend: normalize((1 - alpha) query + alpha centroid). alpha = 0
// is a no-op; alpha = 1 is the pure centroid. Null when the blend degenerates.
export function blendVectors(a, b, alpha) {
    if (!isVector(a) || !isVector(b) || a.length !== b.length) return null;
    const t = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = (1 - t) * a[i] + t * b[i];
    return normalize(out);
}

// The modified query for one round: move `query` toward the (top-K) centroid of
// the candidates found so far. Returns the query UNCHANGED (same reference) when
// nothing can be done — alpha 0, no usable candidates, or a degenerate centroid
// — so the caller can treat reference-equality as "no modification".
export function modifiedQuery(query, candidates, config = DEFAULT_QUERYMOD_CONFIG) {
    if (!isVector(query)) return query;
    const cfg = resolveQueryModConfig(config);
    if (cfg.alpha === 0) return query;
    const chosen = selectCandidates(query, candidates, cfg.topK);
    if (chosen.length === 0) return query;
    const centroid = normalizedCentroid(chosen);
    if (!centroid) return query;
    const blended = blendVectors(query, centroid, cfg.alpha);
    if (!blended) return query;
    return blended;
}

// Diagnostic: the exact ACP gain of the modified query over the query it
// replaced, against the same candidate set. Non-negative in expectation.
export function queryModificationGain(query, candidates, config = DEFAULT_QUERYMOD_CONFIG) {
    const modified = modifiedQuery(query, candidates, config);
    return averageCollisionProbability(modified, candidates) - averageCollisionProbability(query, candidates);
}
