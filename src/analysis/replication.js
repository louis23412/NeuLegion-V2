// Seed replication, common random numbers, and the honest summary of a noisy
// per-run metric (round 26, R26-13).
//
// The literature is unambiguous that a single-seed ordering is not a ranking:
// seed-to-seed variation routinely exceeds the variation attributed to the
// compared factor (Bouthillier et al., ICML 2019; Henderson et al., arXiv
// 1709.06560). The fix has three parts, and all three are implemented here as
// pure statistics:
//
//   1. MEDIAN/robust level rather than the mean alone — the **interquartile mean**
//      (IQM) discards the best and worst quarters and is the summary Agarwal et al.
//      (arXiv 2108.13264) recommend for noisy per-run metrics;
//   2. a **stratified bootstrap** CI, resampling WITHIN each seed stratum so the
//      interval reflects both the seed spread and the fold spread;
//   3. a **variance decomposition** that says what fraction of the spread is seed
//      noise rather than fold noise — without it a "seed-robust" claim is a guess.
//
// `pairedVarianceRatio` is the CRN criterion: with common random numbers the
// variance of the *difference* between two variants should fall (Glasserman &
// Yao 1992) — and the difference is exactly what a promotion decision uses.
//
// Pure: no I/O. The bootstrap is seeded, so every number here is reproducible.

import { mulberry32 } from '../legion/rng.js';
import { mean } from './performance.js';

// The interquartile mean: sort, drop the lowest and highest quarters, average the
// middle. With fewer than four values there is no middle to speak of, so it falls
// back to the plain mean (stated, not silent).
export function interquartileMean(values) {
    const v = (Array.isArray(values) ? values : []).filter((x) => Number.isFinite(x));
    if (!v.length) return NaN;
    if (v.length < 4) return mean(v);
    const sorted = [...v].sort((a, b) => a - b);
    const k = Math.floor(v.length / 4);
    const middle = sorted.slice(k, v.length - k);
    return mean(middle);
}

// A stratified bootstrap CI over `strata` (one array per seed). Each replicate
// resamples WITHIN every stratum with replacement (preserving the stratum sizes),
// concatenates, and evaluates `statistic`; the interval is the empirical
// `[alpha/2, 1-alpha/2]` quantile. Deterministic for a given `seed`.
export function stratifiedBootstrapCI({ strata, statistic = mean, nBoot = 2000, alpha = 0.05, seed = 12345 } = {}) {
    const groups = (Array.isArray(strata) ? strata : []).map((s) => (Array.isArray(s) ? s.filter((x) => Number.isFinite(x)) : [])).filter((s) => s.length);
    if (groups.length < 1) return { available: false, reason: 'no finite observations to bootstrap' };
    const rng = mulberry32(seed >>> 0);
    const draws = [];
    for (let b = 0; b < nBoot; b++) {
        const sample = [];
        for (const g of groups) {
            for (let i = 0; i < g.length; i++) sample.push(g[Math.floor(rng() * g.length)]);
        }
        const s = statistic(sample);
        if (Number.isFinite(s)) draws.push(s);
    }
    if (!draws.length) return { available: false, reason: 'every bootstrap replicate was non-finite' };
    draws.sort((a, b) => a - b);
    const q = (p) => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(p * draws.length)))];
    return {
        available: true,
        nBoot,
        alpha,
        points: draws.length,
        lo: q(alpha / 2),
        hi: q(1 - alpha / 2),
        median: q(0.5),
    };
}

// One-way variance decomposition of a per-(seed, fold) panel. Total variance about
// the grand mean splits into the between-seed component, the within-seed
// (between-fold) component, and — when a cell repeats (e.g. a stream dimension) —
// the residual. Returned as fractions of the total, because the question is
// "how much of the spread is seed noise?".
export function varianceComponents({ cells } = {}) {
    const rows = (Array.isArray(cells) ? cells : []).filter((c) => c && Number.isFinite(c.value) && c.seed != null);
    if (rows.length < 2) return { available: false, reason: 'fewer than two observations' };
    const grand = mean(rows.map((c) => c.value));
    const total = mean(rows.map((c) => (c.value - grand) ** 2));
    const bySeed = new Map();
    for (const r of rows) {
        if (!bySeed.has(r.seed)) bySeed.set(r.seed, []);
        bySeed.get(r.seed).push(r.value);
    }
    const seedMeans = [...bySeed.values()].map((v) => mean(v));
    // Between-seed: the weighted variance of the seed means.
    let between = 0;
    for (const v of bySeed.values()) between += v.length * (mean(v) - grand) ** 2;
    between /= rows.length;
    // Within-seed: the mean within-seed variance (between folds, plus residual when a
    // cell repeats). Split out the residual as the mean squared deviation of each
    // observation from its own (seed, fold) cell if the panel carries a `fold`.
    const cells2 = new Map();
    for (const r of rows) {
        if (r.fold == null) continue;
        const key = `${r.seed}|${r.fold}`;
        if (!cells2.has(key)) cells2.set(key, []);
        cells2.get(key).push(r.value);
    }
    let residual = 0;
    if (cells2.size && cells2.size < rows.length) {
        let num = 0;
        for (const v of cells2.values()) {
            const m = mean(v);
            for (const x of v) num += (x - m) ** 2;
        }
        residual = num / rows.length;
    }
    const within = Math.max(0, total - between - residual);
    return {
        available: true,
        n: rows.length,
        seeds: bySeed.size,
        grandMean: grand,
        totalVariance: total,
        seedVariance: between,
        foldVariance: within,
        residualVariance: residual,
        seedFraction: total > 0 ? between / total : null,
        foldFraction: total > 0 ? within / total : null,
        residualFraction: total > 0 ? residual / total : null,
    };
}

// The full seed distribution of one metric: the robust level, the stratified CI,
// the variance decomposition, and the per-seed values. `perSeed` is
// `[{ seed, values: [perFoldValue, ...] }]`.
export function seedDistribution({ perSeed, statistic = interquartileMean, nBoot = 2000, alpha = 0.05, seed = 12345 } = {}) {
    const groups = (Array.isArray(perSeed) ? perSeed : [])
        .map((s) => ({ seed: s.seed, values: (Array.isArray(s.values) ? s.values : []).filter((x) => Number.isFinite(x)) }))
        .filter((s) => s.values.length);
    if (!groups.length) return { available: false, reason: 'no finite per-seed values' };
    const flat = groups.flatMap((g) => g.values);
    const cells = [];
    for (const g of groups) g.values.forEach((value, fold) => cells.push({ seed: g.seed, fold, value }));
    return {
        available: true,
        seeds: groups.map((g) => g.seed),
        n: flat.length,
        foldsPerSeed: groups.map((g) => g.values.length),
        mean: mean(flat),
        iqm: interquartileMean(flat),
        perSeedMean: groups.map((g) => mean(g.values)),
        perSeedIqm: groups.map((g) => interquartileMean(g.values)),
        // The reported "level" the CI is built around (IQM by default).
        statistic: statistic(flat),
        ci: stratifiedBootstrapCI({ strata: groups.map((g) => g.values), statistic, nBoot, alpha, seed }),
        components: varianceComponents({ cells }),
        reader: 'mean + IQM (Agarwal et al. 2021) over the per-seed per-fold values; ci = stratified bootstrap resampling within each seed stratum (seeded, reproducible); components splits the variance into seed / fold / residual fractions. A single-seed point estimate is not a family decision (Bouthillier et al. 2019).',
    };
}

// The CRN criterion: with common random numbers the variance of the PAIRED
// difference should be below the unpaired one (Glasserman & Yao 1992). Returns the
// ratio (paired/unpaired) and the variance reduction, or `available:false` when
// the samples are too short to say.
export function pairedVarianceRatio({ paired, unpaired } = {}) {
    const p = (Array.isArray(paired) ? paired : []).filter((x) => Number.isFinite(x));
    const u = (Array.isArray(unpaired) ? unpaired : []).filter((x) => Number.isFinite(x));
    if (p.length < 2 || u.length < 2) return { available: false, reason: 'fewer than two differences on one side' };
    const varOf = (v) => { const m = mean(v); return v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1); };
    const vp = varOf(p);
    const vu = varOf(u);
    if (!(vu > 0)) return { available: false, reason: 'the unpaired difference has zero variance' };
    return {
        available: true,
        pairedVariance: vp,
        unpairedVariance: vu,
        varianceRatio: vp / vu,
        varianceReduction: 1 - vp / vu,
        n: { paired: p.length, unpaired: u.length },
    };
}

// Render a compact seed-replication block for the human summary.
export function formatSeedReplication({ label, dist, alpha = 0.05 } = {}) {
    if (!dist || !dist.available) return `${label || 'seeds'}: unavailable (${dist ? dist.reason : 'none'})`;
    const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
    const ci = dist.ci && dist.ci.available ? `[${f(dist.ci.lo)}, ${f(dist.ci.hi)}]` : 'n/a';
    const comp = dist.components && dist.components.available
        ? ` | seed-fraction=${f(dist.components.seedFraction)} fold-fraction=${f(dist.components.foldFraction)}`
        : '';
    return `${label || 'seeds'}: n=${dist.n} over ${dist.seeds.length} seeds mean=${f(dist.mean)} ` +
        `IQM=${f(dist.iqm)} ${(1 - alpha) * 100}%CI=${ci}${comp}`;
}
