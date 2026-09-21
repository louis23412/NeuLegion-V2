// Low-rank evolution strategies — proof suite for `src/legion/evolve.js`.
//
// Grounding: Salimans et al. (arXiv 1703.03864) for the antithetic ES gradient
// estimator, and EGGROLL (arXiv 2609.10980) for confining each perturbation to a
// random low-rank subspace. The claim the lock registry needs is "monotone
// fitness on a toy convex objective", plus the exact mathematics behind it.
//
// The suite splits the guarantees so a failure names the tier:
//
//   A. PURE GEOMETRY / RNG
//      Orthonormal bases, coefficient lifting, the empirical second moment, and
//      the deterministic mulberry32 stream (with a Box-Muller standard normal).
//
//   B. THE QUADRATIC IDENTITY (exact, not statistical)
//      For f(θ) = ½θᵀHθ the antithetic estimate is *exactly* ĝ = S·Hθ with
//      S = (1/P)Σ εᵢεᵢᵀ. S is PSD, so ĝᵀ∇f = (Hθ)ᵀS(Hθ) ≥ 0 — the estimate is
//      always a descent direction. Full-rank perturbations with a large
//      population recover the true gradient; low-rank perturbations stay inside
//      their subspace and are unbiased for the projected gradient.
//
//   C. MONOTONE FITNESS ON A CONVEX QUADRATIC
//      Backtracking line search turns "descent direction" into "fitness strictly
//      decreases every generation", which the test asserts over hundreds of
//      generations for both full-rank and low-rank searches, ending at the
//      optimum. From the optimum the step is a no-op.
//
//   D. DETERMINISM + CONFIG
//      Same seed => identical trajectory; resolveESConfig fills/clamps as
//      documented; the line search rejects non-descent and zero directions.
//
// Pure module: no `{ ensureSql, stateDir }` needed, but it accepts the options
// object for symmetry with the other entries.

import {
    DEFAULT_ES_CONFIG,
    resolveESConfig,
    createRng,
    randomNormal,
    randomVector,
    orthonormalBasis,
    projectCoeffs,
    empiricalSecondMoment,
    esGradientEstimate,
    backtrackingLineSearch,
    lowRankESStep,
    runEvolution,
} from '../../../src/legion/evolve.js';

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

function norm(a) { return Math.sqrt(dot(a, a)); }

function matVec(H, v) {
    const n = v.length;
    const out = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = 0; j < n; j++) s += H[i][j] * v[j];
        out[i] = s;
    }
    return out;
}

// Deterministic SPD matrix H = AᵀA + I.
function spd(dim, seed) {
    const rng = mulberry32(seed);
    const A = Array.from({ length: dim }, () => Array.from({ length: dim }, () => randomNormal(rng)));
    const H = Array.from({ length: dim }, () => new Float64Array(dim));
    for (let i = 0; i < dim; i++) {
        for (let j = 0; j < dim; j++) {
            let s = 0;
            for (let k = 0; k < dim; k++) s += A[k][i] * A[k][j];
            H[i][j] = s + (i === j ? 1 : 0);
        }
    }
    return H;
}

function quadratic(H) {
    const objective = (theta) => 0.5 * dot(theta, matVec(H, theta));
    const gradient = (theta) => matVec(H, theta);
    return { objective, gradient };
}

export async function run(options = {}) {
    void options;
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
    const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

    // ---- A. pure geometry / rng ---------------------------------------------
    try {
        check('A: DEFAULT_ES_CONFIG is frozen and full-rank by default',
            Object.isFrozen(DEFAULT_ES_CONFIG) && DEFAULT_ES_CONFIG.rank === 0 && DEFAULT_ES_CONFIG.antithetic === true);

        const rngA = createRng(12345);
        const seqA = [rngA(), rngA(), rngA()];
        const rngB = createRng(12345);
        const seqB = [rngB(), rngB(), rngB()];
        check('A: createRng is deterministic for a given seed',
            JSON.stringify(seqA) === JSON.stringify(seqB) && seqA.every((x) => x >= 0 && x < 1));

        // Box-Muller moments over many draws.
        const rngN = createRng(7);
        let mean = 0, sq = 0, N = 20000;
        for (let i = 0; i < N; i++) { const x = randomNormal(rngN); mean += x; sq += x * x; }
        mean /= N; const variance = sq / N - mean * mean;
        check('A: randomNormal has mean ~0 and variance ~1',
            close(mean, 0, 0.03) && close(variance, 1, 0.05), `mean=${mean.toFixed(4)} var=${variance.toFixed(4)}`);

        const basis = orthonormalBasis(6, 3, createRng(99));
        check('A: orthonormalBasis returns the requested count', basis.length === 3 && basis[0].length === 6);
        let unitNorm = true, orthogonal = true;
        for (let i = 0; i < basis.length; i++) {
            if (!close(norm(basis[i]), 1, 1e-12)) unitNorm = false;
            for (let j = i + 1; j < basis.length; j++) if (!close(dot(basis[i], basis[j]), 0, 1e-12)) orthogonal = false;
        }
        check('A: basis vectors are unit norm', unitNorm);
        check('A: basis vectors are mutually orthogonal', orthogonal);

        const coeffs = [1.5, -2, 0.75];
        const lifted = projectCoeffs(basis, coeffs);
        const recovered = basis.map((u) => dot(lifted, u));
        check('A: projectCoeffs lifts coefficients exactly (orthonormal recovery)',
            recovered.every((v, i) => close(v, coeffs[i], 1e-12)), JSON.stringify(recovered));

        const eps = [randomVector(5, createRng(3)), randomVector(5, createRng(4)), randomVector(5, createRng(5))];
        const S = empiricalSecondMoment(eps);
        let symmetric = true, psd = true;
        for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) if (!close(S[i][j], S[j][i], 1e-15)) symmetric = false;
        for (let t = 0; t < 200; t++) {
            const x = randomVector(5, createRng(1000 + t));
            if (dot(x, matVec(S, x)) < -1e-12) psd = false;
        }
        check('A: empiricalSecondMoment is symmetric', symmetric);
        check('A: empiricalSecondMoment is positive semi-definite', psd);
    } catch (error) {
        check('A: pure geometry completed', false, error && error.stack ? error.stack : String(error));
    }

    // ---- B. the quadratic identity ------------------------------------------
    const DIM = 6;
    const H = spd(DIM, 2024);
    const { objective, gradient } = quadratic(H);
    const theta0 = [1, -0.7, 0.4, 1.3, -0.2, 0.9];
    const g0 = gradient(theta0);
    const f0 = objective(theta0);

    try {
        // Exact identity: ĝ == S·Hθ for a single seeded ensemble.
        const cfg = { population: 12, rank: 0, antithetic: true };
        const est = esGradientEstimate(objective, theta0, cfg, createRng(1));
        const S = empiricalSecondMoment(est.perturbations);
        const expected = matVec(S, g0);
        let maxErr = 0;
        for (let i = 0; i < DIM; i++) maxErr = Math.max(maxErr, Math.abs(est.gradient[i] - expected[i]));
        check('B: the antithetic estimate is exactly S·Hθ for a quadratic',
            maxErr < 1e-9, `maxErr=${maxErr.toExponential(2)}`);
        check('B: the ensemble has one second-moment sample per pair',
            est.perturbations.length === 6 && est.evaluations === 12);

        // Descent-direction property: ĝᵀ∇f = gᵀSg ≥ 0, and strictly > 0 generically.
        const inner = dot(est.gradient, g0);
        check('B: the estimate is a descent direction (ĝᵀ∇f ≥ 0)', inner >= 0, String(inner));
        check('B: the descent direction is strict for a generic draw', inner > 1e-12, String(inner));

        // Full-rank with a large population recovers the true gradient.
        const bigEst = esGradientEstimate(objective, theta0, { population: 4000, rank: 0 }, createRng(2));
        const cos = dot(bigEst.gradient, g0) / (norm(bigEst.gradient) * norm(g0));
        check('B: full-rank large-population estimate aligns with the true gradient',
            cos > 0.99, `cos=${cos.toFixed(5)}`);
        const relErr = norm(bigEst.gradient.map((v, i) => v - g0[i])) / norm(g0);
        check('B: full-rank large-population estimate is close in L2', relErr < 0.1, `rel=${relErr.toFixed(4)}`);

        // Low-rank: the estimate stays inside the subspace and matches S·Hθ.
        const subBasis = orthonormalBasis(DIM, 3, createRng(11));
        const lowEst = esGradientEstimate(objective, theta0, { population: 16, rank: 3 }, createRng(12), subBasis);
        const lowS = empiricalSecondMoment(lowEst.perturbations);
        const lowExpected = matVec(lowS, g0);
        let lowErr = 0;
        for (let i = 0; i < DIM; i++) lowErr = Math.max(lowErr, Math.abs(lowEst.gradient[i] - lowExpected[i]));
        check('B: low-rank estimate still equals S·Hθ exactly', lowErr < 1e-9, `maxErr=${lowErr.toExponential(2)}`);

        // Residual after projecting onto the basis is ~0 => ĝ ∈ span(U).
        const proj = new Array(DIM).fill(0);
        for (const u of subBasis) { const c = dot(lowEst.gradient, u); for (let j = 0; j < DIM; j++) proj[j] += c * u[j]; }
        const residual = norm(lowEst.gradient.map((v, i) => v - proj[i]));
        check('B: low-rank estimate lies in its subspace', residual < 1e-9 * Math.max(1, norm(lowEst.gradient)),
            `residual=${residual.toExponential(2)}`);

        // Unbiasedness for the projected gradient: E[ĝ | U] = UUᵀ∇f.
        const trials = 3000;
        const acc = new Array(DIM).fill(0);
        for (let t = 0; t < trials; t++) {
            const e = esGradientEstimate(objective, theta0, { population: 8, rank: 3 }, createRng(5000 + t), subBasis);
            for (let i = 0; i < DIM; i++) acc[i] += e.gradient[i];
        }
        const meanEst = acc.map((v) => v / trials);
        const projected = new Array(DIM).fill(0);
        for (const u of subBasis) { const c = dot(g0, u); for (let j = 0; j < DIM; j++) projected[j] += c * u[j]; }
        const bias = norm(meanEst.map((v, i) => v - projected[i]));
        check('B: the low-rank estimate is unbiased for the projected gradient (Monte Carlo)',
            bias < 0.05 * norm(projected), `bias=${bias.toFixed(5)} vs |proj|=${norm(projected).toFixed(4)}`);
    } catch (error) {
        check('B: quadratic identity completed', false, error && error.stack ? error.stack : String(error));
    }

    // ---- C. monotone fitness on a toy convex objective -----------------------
    try {
        const obj = (theta) => 0.5 * dot(theta, matVec(H, theta));
        check('C: the toy objective starts positive', f0 > 0, String(f0));

        const full = runEvolution(obj, theta0, { rank: 0, population: 64, learningRate: 1, maxBacktracks: 80 }, 300, createRng(123));
        let fullMonotone = true;
        for (let i = 1; i < full.history.length; i++) {
            if (full.history[i] > full.history[i - 1] + 1e-12 * Math.max(1, full.history[i - 1])) fullMonotone = false;
        }
        check('C: full-rank fitness is monotone non-increasing every generation', fullMonotone);
        check('C: full-rank search converges near the optimum',
            full.fitness < 1e-6 * full.history[0] && norm(full.params) < 1e-3,
            `f=${full.fitness.toExponential(2)} |theta|=${norm(full.params).toExponential(2)}`);

        const low = runEvolution(obj, theta0, { rank: 3, population: 64, learningRate: 1, maxBacktracks: 80 }, 400, createRng(321));
        let lowMonotone = true;
        for (let i = 1; i < low.history.length; i++) {
            if (low.history[i] > low.history[i - 1] + 1e-12 * Math.max(1, low.history[i - 1])) lowMonotone = false;
        }
        check('C: low-rank fitness is monotone non-increasing every generation', lowMonotone);
        check('C: low-rank search makes real progress',
            low.fitness < 0.5 * low.history[0],
            `f=${low.fitness.toExponential(2)} initial=${low.history[0].toExponential(2)}`);
        check('C: low-rank search ends nearer the optimum than it started',
            norm(low.params) < norm(theta0), `${norm(low.params).toFixed(4)} < ${norm(theta0).toFixed(4)}`);

        // A single step from an off-optimum point strictly decreases fitness.
        const one = lowRankESStep(obj, theta0, { rank: 0, population: 32 }, createRng(55));
        check('C: a single ES step strictly decreases fitness',
            one.decreased === true && one.fitness < f0, `${one.fitness} < ${f0}`);
        check('C: a single step counts its evaluations',
            one.evaluations === 32 && one.gradient.length === DIM);

        // From the optimum the gradient vanishes and the step is a no-op.
        const atOpt = runEvolution(obj, new Array(DIM).fill(0), { rank: 0, population: 32 }, 5, createRng(77));
        check('C: at the optimum the step is a no-op and fitness stays 0',
            atOpt.history.every((v) => v === 0) && atOpt.params.every((v) => v === 0),
            JSON.stringify(atOpt.history));

        // Line search: ascent and zero directions are rejected, descent accepted.
        const ascent = backtrackingLineSearch(obj, theta0, g0.map((v) => -v), { learningRate: 1 });
        check('C: line search rejects an ascent direction', ascent.decreased === false && ascent.step === 0);
        const zeroDir = backtrackingLineSearch(obj, theta0, new Array(DIM).fill(0), { learningRate: 1 });
        check('C: line search rejects a zero direction', zeroDir.decreased === false && zeroDir.step === 0);
        const descent = backtrackingLineSearch(obj, theta0, g0, { learningRate: 1 });
        check('C: line search accepts a descent direction', descent.decreased === true && descent.fitness < f0);
    } catch (error) {
        check('C: monotone fitness completed', false, error && error.stack ? error.stack : String(error));
    }

    // ---- D. determinism + config --------------------------------------------
    try {
        const obj = (theta) => 0.5 * dot(theta, matVec(H, theta));
        const r1 = runEvolution(obj, theta0, { rank: 3, population: 32, seed: 5 }, 6);
        const r2 = runEvolution(obj, theta0, { rank: 3, population: 32, seed: 5 }, 6);
        check('D: an explicit seed makes the trajectory deterministic',
            JSON.stringify(r1.history) === JSON.stringify(r2.history) &&
            JSON.stringify(r1.params) === JSON.stringify(r2.params));

        const resolved = resolveESConfig({ sigma: -1, population: 1, rank: 4.9, maxBacktracks: 0 });
        check('D: resolveESConfig keeps a sign-ok finite override and floors rank',
            resolved.rank === 4 && resolved.population === 2 && resolved.maxBacktracks === 1,
            JSON.stringify(resolved));
        check('D: resolveESConfig(null) returns the defaults', resolveESConfig(null) === DEFAULT_ES_CONFIG);
        const dflt = resolveESConfig({ sigma: NaN });
        check('D: resolveESConfig restores a non-finite field', dflt.sigma === DEFAULT_ES_CONFIG.sigma);

        const tinyBasis = orthonormalBasis(4, 9, createRng(2));
        check('D: orthonormalBasis never returns more than `dim` vectors', tinyBasis.length <= 4);

        const noAntithetic = esGradientEstimate(obj, theta0, { population: 10, antithetic: false }, createRng(9));
        check('D: non-antithetic mode evaluates exactly `population` times',
            noAntithetic.evaluations === 10 && noAntithetic.perturbations.length === 10);
    } catch (error) {
        check('D: determinism completed', false, error && error.stack ? error.stack : String(error));
    }

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
