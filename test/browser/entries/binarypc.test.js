// Data-aware binary principal components — proof suite for
// `src/hivemind/memory/binarypc.js`.
//
// Grounding: BinaryPC (arXiv 2608.04405), training-free hashing via binary
// principal components, extending Charikar's random-hyperplane SimHash (2002).
// The claim the lock registry needs is Eckart-Young optimality: the top-B
// principal components minimise the reconstruction error among all B-dimensional
// subspaces, so a PCA-aligned code dominates a random code for a fixed bit budget
// on any non-isotropic covariance. The suite splits the guarantees so a failure
// names the tier:
//
//   A. LINEAR ALGEBRA EXACTNESS  means, covariance, dot/norm (hand vectors).
//   B. POWER ITERATION           exact top eigenpair on a diagonal matrix, the
//                                zero-matrix guard, seeded determinism.
//   C. PRINCIPAL COMPONENTS      exact eigenvalues on a diagonal covariance,
//                                orthonormality, the trace decomposition.
//   D. DATA-AWARE DOMINANCE      the top PC recovers a planted direction; the
//                                PCA subspace beats every random subspace on
//                                reconstruction error; error falls with bits.
//   E. HASH TABLES               orthonormal tables inside the PC subspace,
//                                seeded determinism, degenerate-input guards.
//   F. CODE + CONFIG             the sign code, and config resolution/clamping.
//   G. alignedHashTables         the oversubscribed-budget LSH-wiring variant.
//   H. TABLE VARIANCES + RANK    the reported per-direction data variances, and
//                                the data-driven `rankPolicy` (bitweight.js).
//
// Pure module: no `{ ensureSql, stateDir }` needed, but it accepts the options
// object for symmetry with the other entries.

import {
    DEFAULT_BINARYPC_CONFIG,
    resolveBinaryPCConfig,
    createRng,
    meanVector,
    centerRows,
    covarianceMatrix,
    dot,
    norm,
    powerIteration,
    principalComponents,
    explainedVariance,
    randomOrthonormalBasis,
    pcaHashTables,
    alignedHashTables,
    randomHashTables,
    binaryCode,
    quantizationError,
} from '../../../src/hivemind/memory/binarypc.js';

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

    // ---- A. linear algebra exactness ----------------------------------------
    const aRows = [[1, 2], [3, 4], [5, 6]];
    const am = meanVector(aRows);
    check('A: meanVector is exact ([1,2],[3,4],[5,6] -> [3,4])', close(am[0], 3) && close(am[1], 4), `${am[0]},${am[1]}`);
    const ac = covarianceMatrix(aRows);
    check('A: covarianceMatrix is the exact population covariance ([[8/3,8/3],[8/3,8/3]])',
        close(ac[0][0], 8 / 3, 1e-12) && close(ac[0][1], 8 / 3, 1e-12) && close(ac[1][0], 8 / 3, 1e-12) && close(ac[1][1], 8 / 3, 1e-12),
        `${ac[0][0]},${ac[0][1]}`);
    check('A: dot and norm are exact (dot=32, norm([3,4])=5)',
        close(dot([1, 2, 3], [4, 5, 6]), 32) && close(norm([3, 4]), 5));
    check('A: centering a row set removes its mean exactly',
        (() => { const c = centerRows(aRows); const mc = meanVector(c); return close(mc[0], 0, 1e-12) && close(mc[1], 0, 1e-12); })());

    // ---- B. power iteration --------------------------------------------------
    const diagM = [[9, 0, 0], [0, 4, 0], [0, 0, 1]];
    const pi = powerIteration(diagM, 3, { rng: createRng(11), iters: 200, tol: 1e-12 });
    check('B: power iteration recovers the dominant eigenpair of diag(9,4,1)',
        close(pi.eigenvalue, 9, 1e-6) && close(Math.abs(pi.vector[0]), 1, 1e-6),
        `lambda=${pi.eigenvalue} v0=${pi.vector[0]}`);
    const pi2 = powerIteration(diagM, 3, { rng: createRng(11), iters: 200, tol: 1e-12 });
    check('B: power iteration is deterministic under a seed',
        pi.vector.every((x, i) => x === pi2.vector[i]) && pi.eigenvalue === pi2.eigenvalue);
    const piZero = powerIteration([[0, 0], [0, 0]], 2, { rng: createRng(3) });
    check('B: a zero matrix returns the zero vector with eigenvalue 0 (not NaN)',
        piZero.eigenvalue === 0 && piZero.vector.every((x) => x === 0));

    // ---- C. principal components on a diagonal covariance --------------------
    // Mean-zero rows with covariance exactly diag(3, 4/3, 1/3).
    const cRows = [[3, 0, 0], [-3, 0, 0], [0, 2, 0], [0, -2, 0], [0, 0, 1], [0, 0, -1]];
    const pc = principalComponents(cRows, 3, { seed: 5 });
    check('C: eigenvalues are the exact diagonal covariance, ordered descending',
        close(pc.components[0].eigenvalue, 3, 1e-6) && close(pc.components[1].eigenvalue, 4 / 3, 1e-6) && close(pc.components[2].eigenvalue, 1 / 3, 1e-6),
        pc.components.map((c) => c.eigenvalue.toFixed(4)).join(','));
    check('C: components are orthonormal',
        pc.components.every((c) => close(norm(c.vector), 1, 1e-9)) &&
        pc.components.every((c, i) => pc.components.every((d, j) => i >= j || Math.abs(dot(c.vector, d.vector)) < 1e-9)));
    check('C: total variance is the trace (14/3) and the eigenvalues sum to it',
        close(pc.totalVariance, 14 / 3, 1e-12) &&
        close(pc.components.reduce((s, c) => s + c.eigenvalue, 0), pc.totalVariance, 1e-9));
    check('C: explainedVariance is non-increasing and sums to 1',
        (() => { const ev = explainedVariance(pc.components, pc.totalVariance); return ev[0] > ev[1] && ev[1] > ev[2] && close(ev.reduce((s, x) => s + x, 0), 1, 1e-9); })());

    // ---- D. data-aware dominance (the Eckart-Young claim) --------------------
    const dim = 8;
    const rng = mulberry32(20260919);
    const u = (() => { const v = Array.from({ length: dim }, (_, i) => (i % 2 === 0 ? 1 : -1)); const n = norm(v); return v.map((x) => x / n); })();
    const rows = [];
    for (let i = 0; i < 400; i++) {
        const a = gauss(rng) * 2.0;
        const row = new Float64Array(dim);
        for (let d = 0; d < dim; d++) row[d] = a * u[d] + gauss(rng) * 0.2;
        rows.push(row);
    }
    const data = principalComponents(rows, 3, { seed: 99 });
    const pc1 = data.components[0].vector;
    const align = Math.abs(dot(pc1, u));
    check('D: the top principal component recovers the planted direction (|cos| > 0.999)', align > 0.999, `|cos|=${align}`);

    const bits = 3;
    const pcaTables = pcaHashTables(rows, { bits, numTables: 1, seed: 7 });
    const pcaErr = quantizationError(rows, pcaTables.tables[0]);
    const rrng = mulberry32(4242);
    const randomErrs = [];
    for (let t = 0; t < 20; t++) randomErrs.push(quantizationError(rows, randomHashTables(dim, bits, 1, rrng).tables[0]));
    const meanRandom = randomErrs.reduce((s, e) => s + e, 0) / randomErrs.length;
    check('D: the PCA-aligned subspace beats EVERY random subspace on reconstruction error (Eckart-Young)',
        randomErrs.every((e) => e >= pcaErr - 1e-9) && meanRandom > pcaErr,
        `pca=${pcaErr.toFixed(4)} meanRandom=${meanRandom.toFixed(4)}`);
    check('D: the dominance margin is large on the planted data (> 2x)',
        meanRandom > pcaErr * 2, `ratio=${(meanRandom / pcaErr).toFixed(2)}`);
    check('D: PCA reconstruction error is non-increasing in the number of bits',
        (() => {
            const errs = [1, 2, 3, 4].map((b) => quantizationError(rows, pcaHashTables(rows, { bits: b, numTables: 1, seed: 7 }).tables[0]));
            return errs.every((e, i) => i === 0 || e <= errs[i - 1] + 1e-9);
        })());

    // ---- E. hash tables ------------------------------------------------------
    const multi = pcaHashTables(rows, { bits, numTables: 4, seed: 7 });
    check('E: pcaHashTables returns the requested shape of orthonormal tables',
        multi.tables.length === 4 && multi.tables.every((t) => t.length === bits && t.every((v) => close(norm(v), 1, 1e-9))) &&
        multi.tables.every((t) => t.every((v, i) => t.every((w, j) => i >= j || Math.abs(dot(v, w)) < 1e-9))));
    check('E: every table direction lies inside the top-bits principal subspace',
        (() => {
            const pcs = multi.components;
            return multi.tables.every((t) => t.every((v) => {
                const residual = new Float64Array(dim);
                for (let i = 0; i < dim; i++) residual[i] = v[i];
                for (const pcv of pcs) { const c = dot(v, pcv); for (let i = 0; i < dim; i++) residual[i] -= c * pcv[i]; }
                return norm(residual) < 1e-9;
            }));
        })());
    const multi2 = pcaHashTables(rows, { bits, numTables: 4, seed: 7 });
    check('E: pcaHashTables is deterministic under a seed',
        multi.tables.every((t, ti) => t.every((v, i) => v.every((x, d) => x === multi2.tables[ti][i][d]))));
    check('E: distinct tables are genuinely different rotations',
        multi.tables[0].some((v, i) => Math.abs(dot(v, multi.tables[1][i])) < 0.999),
        `|dot|=${Math.abs(dot(multi.tables[0][0], multi.tables[1][0])).toFixed(4)}`);
    let eThrew = 0;
    try { pcaHashTables(rows, { bits: dim + 1 }); } catch { eThrew++; }
    try { pcaHashTables(Array.from({ length: 10 }, () => new Float64Array(4)), { bits: 2 }); } catch { eThrew++; }
    check('E: bits > dim and zero-variance data both throw (2 cases)', eThrew === 2, `threw=${eThrew}`);
    const rob = randomOrthonormalBasis(6, 6, mulberry32(1));
    check('E: randomOrthonormalBasis is orthonormal and caps rank at the dimension',
        rob.length === 6 && rob.every((v) => close(norm(v), 1, 1e-9)) && randomOrthonormalBasis(3, 9, mulberry32(2)).length === 3);

    // ---- F. code + config ----------------------------------------------------
    check('F: binaryCode uses the sign convention (dot > 0 -> 1)',
        (() => { const c = binaryCode([1, -1], [[1, 0], [0, 1]]); return c[0] === 1 && c[1] === 0; })());
    check('F: identical rows produce identical codes',
        (() => { const x = new Float64Array([0.2, -0.3, 0.5]); const t = multi.tables[0]; return binaryCode(x, t).join(',') === binaryCode(x, t).join(','); })());
    const rc = resolveBinaryPCConfig({ bits: 0, numTables: 0, iters: 0, seed: 12 });
    check('F: resolveBinaryPCConfig clamps bits/numTables/iters to >= 1 and passes the seed',
        rc.bits === 1 && rc.numTables === 1 && rc.iters === 1 && rc.seed === 12 && DEFAULT_BINARYPC_CONFIG.bits === 8);

    // ---- G. alignedHashTables (the LSH-wiring variant, oversubscribed budgets) ----
    const spanResidual = (v, pcs) => {
        const r = new Float64Array(v.length);
        for (let i = 0; i < v.length; i++) r[i] = v[i];
        for (const pc of pcs) { const c = dot(r, pc); for (let i = 0; i < r.length; i++) r[i] -= c * pc[i]; }
        return norm(r);
    };
    const unitAll = (table) => table.every((v) => close(norm(v), 1, 1e-9));

    const alignSmall = alignedHashTables(rows, { bits: 3, numTables: 1, seed: 7 });
    const pcSmall = pcaHashTables(rows, { bits: 3, numTables: 1, seed: 7 });
    check('G: with bits <= dim and enough rows it IS pcaHashTables (rank = bits)',
        alignSmall.rank === 3 && alignSmall.tables[0].every((v, i) => v.every((x, d) => x === pcSmall.tables[0][i][d])));

    const over = alignedHashTables(rows, { bits: dim + 4, numTables: 2, seed: 9 });
    check('G: an oversubscribed budget returns exactly `bits` unit-norm directions per table',
        over.rank === dim && over.tables.length === 2 &&
        over.tables.every((t) => t.length === dim + 4 && unitAll(t)), `rank=${over.rank}`);
    check('G: the aligned prefix is orthonormal and lies inside the PC subspace',
        (() => {
            const t = over.tables[0];
            const firstOrtho = t.slice(0, dim).every((v, i) => t.slice(0, dim).every((w, j) => i >= j || Math.abs(dot(v, w)) < 1e-9));
            const pcs = over.components;
            const inSubspace = t.slice(0, dim).every((v) => spanResidual(v, pcs) < 1e-9);
            return firstOrtho && inSubspace;
        })());
    const over2 = alignedHashTables(rows, { bits: dim + 4, numTables: 2, seed: 9 });
    check('G: alignedHashTables is deterministic under a seed',
        over.tables.every((t, ti) => t.every((v, i) => v.every((x, d) => x === over2.tables[ti][i][d]))));

    const capped = alignedHashTables(rows, { bits: 8, numTables: 1, seed: 5, maxRank: 2 });
    check('G: maxRank caps the aligned rank and leaves the rest random (all still unit-norm)',
        capped.rank === 2 && capped.tables[0].length === 8 && unitAll(capped.tables[0]) &&
        capped.tables[0].slice(2).some((v) => spanResidual(v, capped.components) > 1e-6),
        `rank=${capped.rank}`);

    const thin = alignedHashTables(Array.from({ length: 3 }, (_, i) => rows[i]), { bits: dim + 4, numTables: 1, seed: 11 });
    check('G: a rank-deficient row set caps the aligned rank at nrows - 1',
        thin.rank === 2 && thin.tables[0].length === dim + 4 && unitAll(thin.tables[0]), `rank=${thin.rank}`);

    let gThrew = 0;
    try { alignedHashTables([]); } catch { gThrew++; }
    try { alignedHashTables([rows[0]]); } catch { gThrew++; }
    try { alignedHashTables(Array.from({ length: 10 }, () => new Float64Array(4)), { bits: 2 }); } catch { gThrew++; }
    check('G: empty rows, a single row and zero-variance data all throw (3 cases)', gThrew === 3, `threw=${gThrew}`);

    // ---- H. table variances + data-driven rank policy ------------------------
    const center = centerRows(rows, dim);
    const bruteVar = (v) => {
        let s = 0;
        for (const x of center) { let c = 0; for (let i = 0; i < dim; i++) c += x[i] * v[i]; s += c * c; }
        return s / center.length;
    };
    check('H: every table reports one finite non-negative variance per direction',
        over.tableVariances.length === over.tables.length &&
        over.tableVariances.every((row, t) => row.length === over.tables[t].length &&
            row.every((v) => Number.isFinite(v) && v >= 0)));
    check('H: the reported variance equals the brute-force data variance along the direction',
        pcaTables.tables[0].every((v, b) => Math.abs(bruteVar(v) - pcaTables.tableVariances[0][b]) < 1e-9),
        `d0=${bruteVar(pcaTables.tables[0][0]).toFixed(6)} reported=${pcaTables.tableVariances[0][0].toFixed(6)}`);
    check('H: the aligned prefix carries above-baseline variance while the random surplus sits at trace/dim',
        capped.tableVariances[0][0] > capped.totalVariance / dim + 1e-9 &&
        Math.abs(capped.tableVariances[0][7] - capped.totalVariance / dim) < 1e-9,
        `aligned=${capped.tableVariances[0][0].toFixed(4)} random=${capped.tableVariances[0][7].toFixed(4)}`);
    const pol = alignedHashTables(rows, { bits: 8, numTables: 1, seed: 5, rankPolicy: 'above-mean' });
    check('H: rankPolicy:above-mean keys off the spectrum — only the planted direction beats the baseline here',
        pol.rank === 1 && pol.tables[0].length === 8 && unitAll(pol.tables[0]),
        `rank=${pol.rank}`);
    const polNoise = alignedHashTables(rows, { bits: 8, numTables: 1, seed: 5, rankPolicy: 'noise' });
    check('H: rankPolicy:noise applies the spectrum-derived noise floor and stays within the budget',
        polNoise.rank >= 1 && polNoise.rank <= 8 && unitAll(polNoise.tables[0]) &&
        polNoise.tableVariances[0].length === 8, `rank=${polNoise.rank}`);
    const pol2 = alignedHashTables(rows, { bits: 8, numTables: 1, seed: 5, rankPolicy: 'above-mean' });
    check('H: rankPolicy is deterministic under a seed',
        pol.tables[0].every((v, i) => v.every((x, d) => x === pol2.tables[0][i][d])) && pol.rank === pol2.rank);
    const cappedPolicy = alignedHashTables(rows, { bits: 8, numTables: 1, seed: 5, rankPolicy: 'noise', maxRank: 3 });
    const cappedPlain = alignedHashTables(rows, { bits: 8, numTables: 1, seed: 5, maxRank: 3 });
    check('H: a rankPolicy rank is still capped by maxRank',
        cappedPolicy.rank === 3);
    check('H: with the same capped rank the policy path is bit-identical to the fixed-rank path (exact component reuse)',
        cappedPolicy.tables[0].every((v, i) => v.every((x, d) => x === cappedPlain.tables[0][i][d])) &&
        cappedPolicy.tableVariances[0].every((v, i) => v === cappedPlain.tableVariances[0][i]));

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
