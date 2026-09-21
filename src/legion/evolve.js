// Low-rank evolution strategies (ES) for member parameters.
//
// Classic ES (Salimans et al., arXiv 1703.03864) estimates a gradient by
// sampling perturbations ε ~ N(0, I) around the current parameters and
// averaging f(θ + σε)·ε / σ. At scale the perturbation set is the expensive
// part, so EGGROLL (arXiv 2609.10980) restricts each perturbation to a random
// low-rank subspace — sample coefficients c ∈ R^r, lift them with a random
// orthonormal basis U ∈ R^{d×r}, and perturb along Uc. The search still covers
// the full space over many generations because U is redrawn per generation.
//
// Why this module is provable. For a quadratic objective
// f(θ) = ½ θᵀHθ the *antithetic* estimate is an exact algebraic function of the
// sampled perturbations: mirroring gives f(θ+σε) − f(θ−σε) = 2σ·(εᵀHθ), so the
// estimate ĝ = S·Hθ where S = (1/P)Σ εᵢεᵢᵀ is the empirical second moment of the
// perturbations. S is a sum of outer products and therefore always positive
// semi-definite, so ĝᵀ∇f = (Hθ)ᵀS(Hθ) ≥ 0: **−ĝ is always a descent direction**
// for a convex quadratic. That, plus a backtracking line search, makes "fitness
// decreases monotonically" a theorem rather than a hope.
//
// Pure: no I/O; randomness comes in through an explicit `rng` (defaults to
// Math.random, and `createRng(seed)` gives a deterministic mulberry32 stream).
// Nothing imports this module yet — it is the additive prerequisite from
// docs/TODO.md item 3 (monotone fitness on a toy convex objective) before any
// trainers are allowed to use it.

export const DEFAULT_ES_CONFIG = Object.freeze({
    sigma: 0.1,          // perturbation scale
    learningRate: 0.1,   // initial backtracking step
    rank: 0,             // 0 = full-rank perturbations; r > 0 = low-rank subspace
    population: 32,      // number of objective evaluations drawn per step
    antithetic: true,    // mirror each perturbation (variance reduction, exact quadratic identity)
    maxBacktracks: 60,   // line-search halvings before giving up
    seed: null,          // null => caller supplies rng / Math.random
});

export function resolveESConfig(config) {
    if (!config) return DEFAULT_ES_CONFIG;
    const base = DEFAULT_ES_CONFIG;
    const num = (v, d) => (Number.isFinite(v) ? v : d);
    const rank = num(config.rank, base.rank);
    const population = num(config.population, base.population);
    return {
        sigma: num(config.sigma, base.sigma),
        learningRate: num(config.learningRate, base.learningRate),
        rank: rank > 0 ? Math.floor(rank) : 0,
        population: Math.max(2, Math.floor(population)),
        antithetic: config.antithetic === undefined ? base.antithetic : !!config.antithetic,
        maxBacktracks: Math.max(1, Math.floor(num(config.maxBacktracks, base.maxBacktracks))),
        seed: Number.isFinite(config.seed) ? config.seed : base.seed,
    };
}

// Deterministic mulberry32 stream. `seed == null` falls back to Math.random.
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
    const out = new Array(dim);
    for (let i = 0; i < dim; i++) out[i] = randomNormal(rng);
    return out;
}

function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

// A random orthonormal basis of an r-dimensional subspace of R^dim, via
// modified Gram-Schmidt. Degenerate draws are retried; if the rng is pathological
// the returned basis may be shorter than requested (never longer, never non-orthonormal).
export function orthonormalBasis(dim, rank, rng) {
    const r = Math.max(0, Math.min(Math.floor(rank), dim));
    const basis = [];
    for (let i = 0; i < r; i++) {
        let vector = null;
        for (let attempt = 0; attempt < 12 && !vector; attempt++) {
            const v = randomVector(dim, rng);
            for (const u of basis) {
                const d = dot(v, u);
                for (let j = 0; j < dim; j++) v[j] -= d * u[j];
            }
            let norm = 0;
            for (let j = 0; j < dim; j++) norm += v[j] * v[j];
            norm = Math.sqrt(norm);
            if (norm > 1e-8) {
                for (let j = 0; j < dim; j++) v[j] /= norm;
                vector = v;
            }
        }
        if (vector) basis.push(vector);
    }
    return basis;
}

// Lift subspace coefficients into R^dim: Σ coeffs[i]·basis[i].
export function projectCoeffs(basis, coeffs) {
    const dim = basis.length > 0 ? basis[0].length : 0;
    const out = new Array(dim).fill(0);
    for (let i = 0; i < basis.length; i++) {
        const c = coeffs[i] || 0;
        const u = basis[i];
        for (let j = 0; j < dim; j++) out[j] += c * u[j];
    }
    return out;
}

// S = (1/P) Σ εᵢεᵢᵀ — the empirical second moment of a perturbation ensemble.
// Always symmetric PSD; the object that makes the quadratic identity exact.
export function empiricalSecondMoment(perturbations) {
    const p = perturbations.length;
    if (p === 0) return [];
    const dim = perturbations[0].length;
    const S = Array.from({ length: dim }, () => new Float64Array(dim));
    for (const eps of perturbations) {
        for (let i = 0; i < dim; i++) {
            const ei = eps[i];
            for (let j = 0; j < dim; j++) S[i][j] += ei * eps[j];
        }
    }
    for (let i = 0; i < dim; i++) for (let j = 0; j < dim; j++) S[i][j] /= p;
    return S;
}

// ES gradient estimate. With `antithetic` each pair ε, −ε contributes
// (f(θ+σε) − f(θ−σε))·ε / (2Pσ). For a quadratic this equals exactly S·Hθ.
export function esGradientEstimate(objective, params, config, rng, basis = null) {
    const cfg = resolveESConfig(config);
    const rngFn = rng || createRng(cfg.seed);
    const dim = params.length;
    const grad = new Array(dim).fill(0);
    const perturbations = [];

    const drawEpsilon = () => {
        if (basis && basis.length > 0) return projectCoeffs(basis, randomVector(basis.length, rngFn));
        return randomVector(dim, rngFn);
    };

    const plus = new Array(dim);
    const minus = new Array(dim);
    let evaluations = 0;

    if (cfg.antithetic) {
        const pairs = Math.max(1, Math.floor(cfg.population / 2));
        for (let p = 0; p < pairs; p++) {
            const eps = drawEpsilon();
            perturbations.push(eps);
            for (let j = 0; j < dim; j++) {
                plus[j] = params[j] + cfg.sigma * eps[j];
                minus[j] = params[j] - cfg.sigma * eps[j];
            }
            const w = objective(plus) - objective(minus);
            for (let j = 0; j < dim; j++) grad[j] += w * eps[j];
            evaluations += 2;
        }
        const normalizer = cfg.sigma * evaluations;
        for (let j = 0; j < dim; j++) grad[j] /= normalizer;
    } else {
        const samples = Math.max(1, Math.floor(cfg.population));
        for (let p = 0; p < samples; p++) {
            const eps = drawEpsilon();
            perturbations.push(eps);
            for (let j = 0; j < dim; j++) plus[j] = params[j] + cfg.sigma * eps[j];
            const f = objective(plus);
            for (let j = 0; j < dim; j++) grad[j] += f * eps[j];
            evaluations += 1;
        }
        const normalizer = cfg.sigma * evaluations;
        for (let j = 0; j < dim; j++) grad[j] /= normalizer;
    }

    return { gradient: grad, evaluations, perturbations, pairs: perturbations.length };
}

// Backtracking line search along −direction: halve the step until f strictly
// decreases (or the budget runs out). A descent direction guarantees success
// for a sufficiently small step, so this only needs `f1 < f0`.
export function backtrackingLineSearch(objective, params, direction, config) {
    const cfg = resolveESConfig(config);
    const f0 = objective(params);
    const dim = params.length;
    const candidate = new Array(dim);
    let t = cfg.learningRate;
    for (let k = 0; k < cfg.maxBacktracks; k++) {
        for (let j = 0; j < dim; j++) candidate[j] = params[j] - t * direction[j];
        const f1 = objective(candidate);
        if (Number.isFinite(f1) && f1 < f0) {
            return { step: t, params: candidate.slice(), fitness: f1, decreased: true, backtracks: k };
        }
        t *= 0.5;
    }
    return { step: 0, params: params.slice(), fitness: f0, decreased: false, backtracks: cfg.maxBacktracks };
}

// One ES generation: estimate the gradient in the (optionally low-rank)
// subspace, then take a line-searched step. `basis` may be supplied (a fixed
// subspace) or left null (a fresh random subspace per call when rank > 0).
export function lowRankESStep(objective, params, config, rng, basis = null) {
    const cfg = resolveESConfig(config);
    const rngFn = rng || createRng(cfg.seed);
    const localBasis = basis || (cfg.rank > 0
        ? orthonormalBasis(params.length, Math.min(cfg.rank, params.length), rngFn)
        : null);

    const estimate = esGradientEstimate(objective, params, cfg, rngFn, localBasis);
    const grad = estimate.gradient;
    let gradNormSq = 0;
    for (const g of grad) gradNormSq += g * g;

    if (!(gradNormSq > 0)) {
        return {
            params: params.slice(), fitness: objective(params), step: 0, decreased: false,
            gradient: grad, evaluations: estimate.evaluations, basis: localBasis,
        };
    }

    const search = backtrackingLineSearch(objective, params, grad, cfg);
    return {
        params: search.params, fitness: search.fitness, step: search.step, decreased: search.decreased,
        gradient: grad, evaluations: estimate.evaluations, basis: localBasis,
    };
}

// Run `generations` ES steps. When rank > 0 a fresh random subspace is drawn
// each generation, so the search covers the full space over time (EGGROLL).
export function runEvolution(objective, initialParams, config, generations = 1, rng = null) {
    const cfg = resolveESConfig(config);
    const rngFn = rng || createRng(cfg.seed);
    let params = initialParams.slice();
    let fitness = objective(params);
    const history = [fitness];
    let evaluations = 0;

    for (let g = 0; g < generations; g++) {
        const basis = cfg.rank > 0
            ? orthonormalBasis(params.length, Math.min(cfg.rank, params.length), rngFn)
            : null;
        const step = lowRankESStep(objective, params, cfg, rngFn, basis);
        params = step.params;
        fitness = step.fitness;
        evaluations += step.evaluations;
        history.push(fitness);
    }

    return { params, fitness, history, evaluations, config: cfg };
}
