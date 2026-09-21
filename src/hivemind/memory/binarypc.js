// Data-aware binary principal components for the LSH hash family.
//
// `memory/lsh.js` hashes prototype projections with *data-independent* random
// hyperplanes (SimHash, Charikar 2002): bit b = 1[w_b . x > 0] with w_b ~ N(0,I).
// That is unbiased and needs no training, but for a *fixed* bit budget it spends
// bits on directions the data barely varies in. BinaryPC (arXiv 2608.04405) —
// the training-free, data-aware hashing line — instead uses the *principal
// components of the data* as the hash directions, so the same number of bits
// carries strictly more of the data's variance.
//
// The provable claim is Eckart–Young optimality: among all B-dimensional
// subspaces, the one spanned by the top-B principal components MINIMISES the mean
// squared reconstruction error E||x - P x||^2. A random B-subspace has (a.s.) a
// larger orthogonal-complement variance, so `pcaHashTables` dominates
// `randomHashTables` on `quantizationError` for every non-isotropic covariance
// and ties only when the covariance is isotropic. That is the guarantee this
// module is pinned by (test/browser/entries/binarypc.test.js).
//
// This module is additive and pure. It is the "PCA-aligned hyperplanes" step
// from docs/TODO.md item 2, on top of the already-wired margin multi-probe, and
// it is now wired behind the default-off `_pcaHashConfig` (see lsh.js). Each
// table also reports the exact data variance along every returned direction
// (`tableVariances`) so `memory/bitweight.js` can rank candidates by
// reliability-weighted Hamming; `rankPolicy` lets `alignedHashTables` choose its
// own aligned rank from the spectrum instead of the magic `lowDim/4` constant.
import { selectReliableRank, estimateNoiseVariance } from './bitweight.js';

export const DEFAULT_BINARYPC_CONFIG = Object.freeze({
    bits: 8,          // hash bits (= principal components) per table
    numTables: 1,     // independent tables (rotated copies of the PCA subspace)
    iters: 128,       // power-iteration steps per component
    tol: 1e-12,       // convergence tolerance on the eigenvector movement
    seed: null,       // null => Math.random (non-deterministic)
});

export function resolveBinaryPCConfig(config) {
    if (!config) return DEFAULT_BINARYPC_CONFIG;
    const base = DEFAULT_BINARYPC_CONFIG;
    const num = (v, d) => (Number.isFinite(v) ? v : d);
    return {
        bits: Math.max(1, Math.floor(num(config.bits, base.bits))),
        numTables: Math.max(1, Math.floor(num(config.numTables, base.numTables))),
        iters: Math.max(1, Math.floor(num(config.iters, base.iters))),
        tol: Math.max(0, num(config.tol, base.tol)),
        seed: Number.isFinite(config.seed) ? config.seed : base.seed,
    };
}

// Deterministic mulberry32 stream; `seed == null` falls back to Math.random.
export function createRng(seed) {
    if (!Number.isFinite(seed)) return () => Math.random();
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Box-Muller standard normal from a uniform rng.
export function randomNormal(rng) {
    const u = Math.max(rng(), 1e-12);
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function randomVector(dim, rng) {
    const out = new Float64Array(dim);
    for (let i = 0; i < dim; i++) out[i] = randomNormal(rng);
    return out;
}

export function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

export function norm(a) {
    return Math.sqrt(dot(a, a));
}

// Column means of a row-major data matrix.
export function meanVector(rows, dim = rows[0].length) {
    const m = new Float64Array(dim);
    for (const row of rows) for (let i = 0; i < dim; i++) m[i] += row[i];
    for (let i = 0; i < dim; i++) m[i] /= rows.length;
    return m;
}

// Mean-centred copy of the rows (PCA needs the origin at the mean).
export function centerRows(rows, dim = rows[0].length) {
    const m = meanVector(rows, dim);
    return rows.map((row) => {
        const out = new Float64Array(dim);
        for (let i = 0; i < dim; i++) out[i] = row[i] - m[i];
        return out;
    });
}

// Population covariance (sum of outer products / n) — symmetric, PSD.
export function covarianceMatrix(rows, dim = rows[0].length) {
    const centered = centerRows(rows, dim);
    const n = centered.length;
    const M = Array.from({ length: dim }, () => new Float64Array(dim));
    for (const x of centered) {
        for (let i = 0; i < dim; i++) {
            const xi = x[i];
            if (xi === 0) continue;
            const row = M[i];
            for (let j = i; j < dim; j++) row[j] += xi * x[j];
        }
    }
    for (let i = 0; i < dim; i++) {
        for (let j = i; j < dim; j++) {
            const v = M[i][j] / n;
            M[i][j] = v;
            if (j !== i) M[j][i] = v;
        }
    }
    return M;
}

export function matVec(M, v, dim = v.length) {
    const out = new Float64Array(dim);
    for (let i = 0; i < dim; i++) {
        const row = M[i];
        let s = 0;
        for (let j = 0; j < dim; j++) s += row[j] * v[j];
        out[i] = s;
    }
    return out;
}

// Top eigenpair of a symmetric PSD matrix by power iteration from a random
// (seeded) start. Convergence is measured on the EIGENVECTOR movement, not the
// Rayleigh quotient (which converges quadratically and would stop the iteration
// while the vector is still ~1e-5 off). The returned eigenvalue is the Rayleigh
// quotient v^T M v; a zero matrix returns the zero vector with eigenvalue 0.
export function powerIteration(M, dim = M.length, { rng = Math.random, iters = DEFAULT_BINARYPC_CONFIG.iters, tol = DEFAULT_BINARYPC_CONFIG.tol } = {}) {
    let v = randomVector(dim, rng);
    let nv = norm(v);
    if (!(nv > 0)) return { vector: new Float64Array(dim), eigenvalue: 0 };
    for (let i = 0; i < dim; i++) v[i] /= nv;
    for (let it = 0; it < iters; it++) {
        const w = matVec(M, v, dim);
        const nw = norm(w);
        if (!(nw > 0)) return { vector: new Float64Array(dim), eigenvalue: 0 };
        let moved = 0;
        for (let i = 0; i < dim; i++) {
            w[i] /= nw;
            const dv = w[i] - v[i];
            moved += dv * dv;
        }
        v = w;
        if (Math.sqrt(moved) <= tol) break;
    }
    return { vector: v, eigenvalue: dot(v, matVec(M, v, dim)) };
}

// The top `count` principal components, ordered by descending eigenvalue, via
// power iteration + hotelling deflation (M <- M - lambda v v^T). A final
// Gram-Schmidt pass makes the basis exactly orthonormal and re-reads each
// eigenvalue as the Rayleigh quotient against the ORIGINAL covariance, so a
// basis direction can never carry a small overlap with an earlier one. Returns
// the orthonormal component vectors, their eigenvalues, and the total variance
// (the trace of the covariance).
export function principalComponents(rows, count, { seed = null, iters = DEFAULT_BINARYPC_CONFIG.iters, tol = DEFAULT_BINARYPC_CONFIG.tol } = {}) {
    if (!Array.isArray(rows) || rows.length < 1) throw new Error('binarypc: need at least one row');
    const dim = rows[0].length;
    if (!(dim >= 1)) throw new Error('binarypc: rows must be non-empty vectors');
    const k = Math.min(Math.max(1, Math.floor(count)), dim);
    const C = covarianceMatrix(rows, dim);
    let totalVariance = 0;
    for (let i = 0; i < dim; i++) totalVariance += C[i][i];

    // Hotelling deflation runs on a working copy so the original covariance
    // survives for the final Rayleigh-quotient read.
    const M = C.map((row) => Float64Array.from(row));
    const rng = createRng(seed);
    const components = [];
    for (let c = 0; c < k; c++) {
        const { vector, eigenvalue } = powerIteration(M, dim, { rng, iters, tol });
        components.push({ vector, eigenvalue });
        for (let i = 0; i < dim; i++) {
            const scaled = eigenvalue * vector[i];
            if (scaled === 0) continue;
            const row = M[i];
            for (let j = 0; j < dim; j++) row[j] -= scaled * vector[j];
        }
    }

    for (let c = 0; c < components.length; c++) {
        const v = components[c].vector;
        for (let d = 0; d < c; d++) {
            const overlap = dot(v, components[d].vector);
            const prev = components[d].vector;
            for (let i = 0; i < dim; i++) v[i] -= overlap * prev[i];
        }
        const n = norm(v);
        if (n > 0) for (let i = 0; i < dim; i++) v[i] /= n;
        components[c] = { vector: v, eigenvalue: dot(v, matVec(C, v, dim)) };
    }
    return { components, totalVariance, dim };
}

// Fraction of total variance carried by each component (in order).
export function explainedVariance(components, totalVariance) {
    return components.map((c) => (totalVariance > 0 ? c.eigenvalue / totalVariance : 0));
}

// A random orthonormal set of `rank` directions in R^dim (modified
// Gram-Schmidt). Used both as the random-hashing baseline and to rotate a PCA
// subspace into independent tables.
export function randomOrthonormalBasis(dim, rank, rng = Math.random) {
    const r = Math.max(0, Math.min(Math.floor(rank), dim));
    const basis = [];
    for (let i = 0; i < r; i++) {
        let vector = null;
        for (let attempt = 0; attempt < 16 && !vector; attempt++) {
            const w = randomVector(dim, rng);
            for (const u of basis) {
                const d = dot(w, u);
                for (let j = 0; j < dim; j++) w[j] -= d * u[j];
            }
            const n = norm(w);
            if (n > 1e-9) {
                for (let j = 0; j < dim; j++) w[j] /= n;
                vector = w;
            }
        }
        if (vector) basis.push(vector);
    }
    return basis;
}

// PCA-aligned hash tables. The top-`bits` components are computed once; each
// table then applies a seeded random rotation *within* that principal subspace,
// so every table is a different orthonormal set of data-aligned directions.
export function pcaHashTables(rows, { bits = 8, numTables = 1, seed = null, iters = DEFAULT_BINARYPC_CONFIG.iters, tol = DEFAULT_BINARYPC_CONFIG.tol } = {}) {
    const dim = rows[0].length;
    const B = Math.min(Math.floor(bits), dim);
    if (B < 1) throw new Error('binarypc: bits must be >= 1');
    if (Math.floor(bits) > dim) throw new Error('binarypc: bits exceeds the data dimension');
    const { components, totalVariance } = principalComponents(rows, B, { seed, iters, tol });
    if (!(totalVariance > 0)) throw new Error('binarypc: data has zero variance');
    const pcs = components.map((c) => c.vector);

    const rng = createRng(Number.isFinite(seed) ? seed + 1 : null);
    const tables = [];
    const tableVariances = [];
    for (let t = 0; t < numTables; t++) {
        const rotation = randomOrthonormalBasis(B, B, rng);
        const table = [];
        const varRow = new Float64Array(B);
        for (let b = 0; b < B; b++) {
            const v = new Float64Array(dim);
            let variance = 0;
            for (let j = 0; j < B; j++) {
                const coeff = rotation[b][j];
                // The rotation is orthonormal and the PCs are eigen-directions, so
                // the data variance along the rotated direction is exactly the
                // eigenvalue-weighted sum of the squared coefficients (no need to
                // re-project the rows).
                variance += coeff * coeff * components[j].eigenvalue;
                const pc = pcs[j];
                for (let i = 0; i < dim; i++) v[i] += coeff * pc[i];
            }
            varRow[b] = variance;
            table.push(v);
        }
        tableVariances.push(varRow);
        tables.push(table);
    }
    return { tables, tableVariances, components: pcs, eigenvalues: components.map((c) => c.eigenvalue), totalVariance, bits: B, dim };
}

// The general data-aware hash used by the LSH wiring. `pcaHashTables` requires
// `bits <= dim`; the live index does not (the production hash is typically
// ~2x wider than the projection dimension), so this variant handles an
// oversubscribed budget:
//
//   rank = min(bits, dim, nrows - 1, maxRank)
//
// is how many directions the DATA can actually supply: an `n`-row data matrix
// spans at most `n - 1` variance directions, so a rank-deficient covariance can
// never fake a principal component. The top-`rank` components are computed once
// and each table applies a seeded rotation within that subspace; the remaining
// `bits - rank` directions are drawn at random (unit-norm, like the SimHash
// baseline). Beyond `rank` a bit carries no new information — it is redundant in
// the random generator too — so only the first `rank` bits are data-aligned.
//
// `maxRank` (default Infinity) caps the aligned rank deliberately: aligning
// *every* direction dedicates bits to the low-variance tail, where a noisy query
// is dominated by noise, which can cost near-duplicate recall (measured — see
// lsh.test.js section I). A small `maxRank` aligns only the high-variance
// directions and leaves the tail to random mixing, which mixes the whole
// spectrum into each bit. When `bits <= dim <= nrows - 1` and `maxRank >= bits`
// this is exactly `pcaHashTables`, and the alignment covers the whole budget.
//
// `rankPolicy` (default null) replaces the fixed `maxRank` cap with a data-driven
// rank from `memory/bitweight.js#selectReliableRank` ('above-mean' = only PCs
// above the random-direction baseline trace/dim, 'noise' = only PCs above a noise
// floor). It is capped by the same min(bits, dim, nrows-1, maxRank) bound, so it
// can only ever shrink the aligned set. Each table's exact per-direction data
// variances are returned as `tableVariances`.
export function alignedHashTables(rows, { bits = 8, numTables = 1, seed = null, iters = DEFAULT_BINARYPC_CONFIG.iters, tol = DEFAULT_BINARYPC_CONFIG.tol, maxRank = Infinity, rankPolicy = null } = {}) {
    if (!Array.isArray(rows) || rows.length < 1) throw new Error('binarypc: need at least one row');
    const dim = rows[0].length;
    if (!(dim >= 1)) throw new Error('binarypc: rows must be non-empty vectors');
    const B = Math.max(1, Math.floor(bits));
    const cap = Number.isFinite(maxRank) ? Math.max(1, Math.floor(maxRank)) : Infinity;
    const hardCap = Math.max(1, Math.min(B, dim, rows.length - 1));

    // `rankPolicy` needs the spectrum, so compute the (capped) components once and
    // reuse them for the tables — no second power-iteration pass. Without a policy
    // the original lazy path is kept untouched.
    let precomputed = null;
    let rank = Math.min(hardCap, cap);
    if (rankPolicy) {
        precomputed = principalComponents(rows, hardCap, { seed, iters, tol });
        if (!(precomputed.totalVariance > 0)) throw new Error('binarypc: data has zero variance');
        const eigenvalues = precomputed.components.map((c) => c.eigenvalue);
        // The 'noise' policy needs a floor; estimate it from the spectrum itself
        // (the sub-mean tail, where the noise dominates) when the caller has not
        // supplied one.
        const noise = rankPolicy === 'noise'
            ? estimateNoiseVariance(eigenvalues, { totalVariance: precomputed.totalVariance, dim })
            : null;
        const policyRank = selectReliableRank(eigenvalues, {
            policy: rankPolicy,
            totalVariance: precomputed.totalVariance,
            dim,
            noise,
        });
        rank = Math.max(1, Math.min(hardCap, cap, Math.floor(policyRank)));
    }

    if (B <= dim && rank === B) {
        const res = pcaHashTables(rows, { bits: B, numTables, seed, iters, tol });
        return { ...res, rank };
    }
    const { components, totalVariance } = precomputed
        ? { components: precomputed.components.slice(0, rank), totalVariance: precomputed.totalVariance }
        : principalComponents(rows, rank, { seed, iters, tol });
    if (!(totalVariance > 0)) throw new Error('binarypc: data has zero variance');
    const pcs = components.map((c) => c.vector);
    const randomVariance = totalVariance / dim;
    const rng = createRng(Number.isFinite(seed) ? seed + 1 : null);
    const tables = [];
    const tableVariances = [];
    for (let t = 0; t < numTables; t++) {
        const rotation = randomOrthonormalBasis(rank, rank, rng);
        const table = [];
        const varRow = new Float64Array(B);
        for (let b = 0; b < rank; b++) {
            const v = new Float64Array(dim);
            let variance = 0;
            for (let j = 0; j < rank; j++) {
                const coeff = rotation[b][j];
                variance += coeff * coeff * components[j].eigenvalue;
                const pc = pcs[j];
                for (let i = 0; i < dim; i++) v[i] += coeff * pc[i];
            }
            varRow[b] = variance;
            table.push(v);
        }
        for (let b = rank; b < B; b++) {
            const v = randomVector(dim, rng);
            const nv = norm(v) || 1;
            for (let i = 0; i < dim; i++) v[i] /= nv;
            // A random unit direction captures trace/dim variance in expectation;
            // the surplus is not data-aligned, so its expected variance is the
            // right reliability estimate.
            varRow[b] = randomVariance;
            table.push(v);
        }
        tableVariances.push(varRow);
        tables.push(table);
    }
    return { tables, tableVariances, components: pcs, eigenvalues: components.map((c) => c.eigenvalue), totalVariance, bits: B, dim, rank };
}

// The data-independent SimHash baseline: `numTables` orthonormal sets of `bits`
// random directions — the same shape as `pcaHashTables`, for a fair comparison.
export function randomHashTables(dim, bits, numTables, rng = Math.random) {
    const B = Math.max(1, Math.min(Math.floor(bits), dim));
    const tables = [];
    for (let t = 0; t < numTables; t++) tables.push(randomOrthonormalBasis(dim, B, rng));
    return { tables, bits: B, dim };
}

// Sign code of a vector under a set of hyperplanes (the LSH key bits).
export function binaryCode(x, hyperplanes) {
    const out = new Uint8Array(hyperplanes.length);
    for (let b = 0; b < hyperplanes.length; b++) out[b] = dot(x, hyperplanes[b]) > 0 ? 1 : 0;
    return out;
}

// Mean squared reconstruction error after projecting the (centred) data onto the
// subspace spanned by `hyperplanes`. When the hyperplanes are orthonormal this
// is exactly the orthogonal-complement variance, which PCA minimises.
export function quantizationError(rows, hyperplanes) {
    const dim = rows[0].length;
    const centered = centerRows(rows, dim);
    let total = 0;
    for (const x of centered) {
        const recon = new Float64Array(dim);
        for (const w of hyperplanes) {
            const c = dot(x, w);
            for (let i = 0; i < dim; i++) recon[i] += c * w[i];
        }
        let e = 0;
        for (let i = 0; i < dim; i++) {
            const d = x[i] - recon[i];
            e += d * d;
        }
        total += e;
    }
    return total / centered.length;
}
