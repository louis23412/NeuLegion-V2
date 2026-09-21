// Margin-ordered multi-probe LSH — the principled replacement for the naive
// "flip the first N hash bits" probe loop in `_getGlobalLSHCandidates`.
//
// Classic multi-probe LSH (Lv, Josephson, Wang, Charikar & Indyk, VLDB 2007)
// observes that a query's hash bits are NOT equally likely to change for a near
// neighbour: the bits whose hyperplane the query sits *closest* to are the ones
// a small perturbation is most likely to cross. So instead of flipping an
// arbitrary prefix of bits, probe in ascending order of the query's margin
// |dot(queryProj, hyperplane)| — smallest margin first, because those are the
// hyperplanes the neighbour is most likely on the other side of.
//
// This module is pure and deterministic: no I/O, no RNG, no dependency on the
// HiveMind instance. It is the *provable* core of a flag-gated retrieval
// upgrade (see docs/LOCKED.md); it does not touch the locked hot path on its
// own.
//
// Why it works (the lemma the test suite pins): if the neighbour is
//   n = q + delta
// in the (pre-normalisation) projection space, then hash bit b flips exactly
// when the perturbation on that bit dominates the query's margin and opposes
// its side:
//   |delta_b| > |q_b|  and  sign(q_b) != sign(delta_b).
// Hence every flipped bit has |q_b| < max_b'|delta_b'|. A near neighbour is
// therefore found with certainty as soon as the probe budget covers every bit
// whose margin is below the perturbation magnitude — and those are, by
// definition, the lowest-margin bits. Probing them in ascending margin order
// dominates any fixed bit order at the same budget.
//
// References: Lv et al., "Multi-Probe LSH" (VLDB 2007); Charikar, STOC 2002
// (the sign-random-projection family this index uses).
//
// Query-adaptive budget. Lv's probe order is fixed-count: the same number of
// bits for every query. The reliability model in `bitweight.js` makes the
// per-bit flip probability known for a given query (Phi(-|margin|/sigma)), so
// the budget itself can be derived per query — the query-side uncertainty
// signal of NeuRoute (arXiv 2608.15438) and the adaptive bucket probing of
// arXiv 2604.04603. `adaptiveMultiProbeConfig` returns a `{maxFlips, budget}`
// whose depth is the smallest that reaches a target coverage of containing the
// whole flipped set (see `marginContainmentDepth`), and whose `maxFlips` is the
// Poisson-binomial quantile of the flip count. `adaptive` is off by default, so
// with a plain config the hot path is byte-identical.

import {
    bitFlipProbabilities, poissonBinomialQuantile, recoveryDepth,
} from './bitweight.js';

export const DEFAULT_MULTIPROBE_CONFIG = Object.freeze({
    maxFlips: 2,
    budget: 8,
});

// Query-adaptive budget knobs. `adaptive` gates everything (off => the fixed
// config above is used verbatim). `sigma` is the noise scale of the flip model
// in the same units as the query margins; `coverage` is the target probability
// that the flipped set lies inside the probed depth; `maxFlipsCoverage` is the
// quantile used to choose how many bits a single perturbation may flip;
// `maxFlipsCap`/`budgetCap` bound the search.
export const DEFAULT_ADAPTIVE_CONFIG = Object.freeze({
    adaptive: false,
    sigma: 0.25,
    coverage: 0.9,
    maxFlipsCoverage: 0.995,
    maxFlipsCap: 4,
    budgetCap: 64,
});

export function resolveAdaptiveConfig(config) {
    const cfg = config || {};
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    return {
        adaptive: !!cfg.adaptive,
        sigma: Math.max(0, num(cfg.sigma, DEFAULT_ADAPTIVE_CONFIG.sigma)),
        coverage: Math.min(1, Math.max(0, num(cfg.coverage, DEFAULT_ADAPTIVE_CONFIG.coverage))),
        maxFlipsCoverage: Math.min(1, Math.max(0, num(cfg.maxFlipsCoverage, DEFAULT_ADAPTIVE_CONFIG.maxFlipsCoverage))),
        maxFlipsCap: Math.max(1, Math.min(8, Math.floor(num(cfg.maxFlipsCap, DEFAULT_ADAPTIVE_CONFIG.maxFlipsCap)))),
        budgetCap: Math.max(1, Math.floor(num(cfg.budgetCap, DEFAULT_ADAPTIVE_CONFIG.budgetCap))),
    };
}

// The per-query probe config. With `adaptive` off this is exactly
// `resolveMultiProbeConfig(config)` (hot path unchanged). With `adaptive` on the
// query margins choose the budget. Two quantities are read off the flip model:
//
//   * `maxFlips` — the (maxFlipsCoverage)-quantile of the number of flipped
//     bits, i.e. how many bits a perturbation must be allowed to touch;
//   * `depth` — the smallest number of smallest-margin bits whose EXHAUSTIVE
//     subset enumeration recovers the neighbour with probability >= `coverage`
//     (`probeRecoveryCoverage`). `depth` is capped so that
//     `budget = #{subsets of depth bits of size <= maxFlips}` stays within
//     `budgetCap`; because the enumeration is exhaustive over exactly those
//     bits, no cost-ordering truncation can drop a required subset, so the
//     returned budget meets the stated recovery probability exactly.
export function adaptiveMultiProbeConfig(dots, config = DEFAULT_MULTIPROBE_CONFIG) {
    const base = resolveMultiProbeConfig(config);
    const a = resolveAdaptiveConfig(config);
    if (!a.adaptive || !dots || dots.length === 0) return base;
    const probs = bitFlipProbabilities(dots, a.sigma);
    const maxFlips = Math.max(1, Math.min(a.maxFlipsCap, poissonBinomialQuantile(probs, a.maxFlipsCoverage)));
    const subsetCount = (d) => {
        let total = 0;
        let choose = 1;
        for (let i = 1; i <= maxFlips && i <= d; i++) {
            choose = (choose * (d - i + 1)) / i;
            total += choose;
        }
        return total;
    };
    let depthCap = 0;
    while (depthCap < dots.length && subsetCount(depthCap + 1) <= a.budgetCap) depthCap++;
    const depth = recoveryDepth(dots, { noise: a.sigma, maxFlips, coverage: a.coverage, maxDepth: depthCap });
    return {
        adaptive: true,
        maxFlips,
        budget: Math.max(1, subsetCount(depth)),
        depth,
        sigma: a.sigma,
        coverage: a.coverage,
        maxFlipsCoverage: a.maxFlipsCoverage,
        maxFlipsCap: a.maxFlipsCap,
        budgetCap: a.budgetCap,
        exhaustive: true,
    };
}

// The config a probe routine should actually use for this query: the adaptive
// one when enabled, else the fixed one. Split out so `rankPerturbations` /
// `multiProbeKeys` stay a one-line change and the default path is bit-identical.
export function resolveEffectiveProbeConfig(dots, config) {
    const a = resolveAdaptiveConfig(config);
    if (a.adaptive) return adaptiveMultiProbeConfig(dots, config);
    return resolveMultiProbeConfig(config);
}

// Adaptive budget for the single-bit margin probe: the smallest probe depth
// whose single-bit recovery coverage (the exact key plus the covered single-bit
// flips) reaches the target. `recoveryDepth` is a single incremental scan.
export function adaptiveSingleBitBudget(dots, config = DEFAULT_ADAPTIVE_CONFIG) {
    const a = resolveAdaptiveConfig({ ...(config || {}), adaptive: true });
    if (!dots || dots.length === 0) return 0;
    return recoveryDepth(dots, { noise: a.sigma, maxFlips: 1, coverage: a.coverage, maxDepth: a.budgetCap });
}

export function resolveMultiProbeConfig(config) {
    const cfg = config || {};
    const rawFlips = Number(cfg.maxFlips);
    const rawBudget = Number(cfg.budget);
    const maxFlips = Number.isFinite(rawFlips) ? Math.max(1, Math.min(8, Math.floor(rawFlips))) : DEFAULT_MULTIPROBE_CONFIG.maxFlips;
    const budget = Number.isFinite(rawBudget) ? Math.max(1, Math.floor(rawBudget)) : DEFAULT_MULTIPROBE_CONFIG.budget;
    return { maxFlips, budget };
}

// Ascending margin order: bit indices sorted by |dots[b]|, ties broken by index
// so the permutation is total and stable. Returns a fresh array of indices.
export function marginOrder(dots, limit = Infinity) {
    const n = dots.length;
    const idx = new Array(n);
    for (let b = 0; b < n; b++) idx[b] = b;
    const mag = (b) => {
        const v = dots[b];
        return Number.isFinite(v) ? Math.abs(v) : 0;
    };
    idx.sort((a, b) => {
        const da = mag(a);
        const db = mag(b);
        if (da !== db) return da - db;
        return a - b;
    });
    const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : n;
    return cap >= n ? idx : idx.slice(0, cap);
}

// Rank of each bit in the ascending margin order (rank[b] = how many bits must
// be probed before b in the single-bit scheme).
export function marginRanks(dots) {
    const order = marginOrder(dots);
    const rank = new Array(dots.length).fill(0);
    for (let r = 0; r < order.length; r++) rank[order[r]] = r;
    return rank;
}

export function perturbationCost(dots, bits) {
    let sum = 0;
    for (const b of bits) {
        const v = dots[b];
        sum += Number.isFinite(v) ? Math.abs(v) : 0;
    }
    return sum;
}

// Enumerate perturbations of up to `maxFlips` bits, ranked by total margin cost
// (then by fewer flips, then by early margin-rank so the order is total). The
// candidate bits are the `maxFlips * budget` smallest-margin bits: a superset of
// the cheapest `budget` perturbations, since any perturbation containing a bit
// outside that set costs at least as much as one containing only in-set bits.
//
// `config.exhaustive` (set by the adaptive path) instead takes the candidate set
// to be exactly the top-`config.depth` bits and enumerates every subset of size
// <= maxFlips, so the result is complete over that depth — the property the
// adaptive recovery guarantee needs. The very same enumeration is still cost-
// sorted, so the default path is unchanged.
export function rankPerturbations(dots, config = DEFAULT_MULTIPROBE_CONFIG) {
    const cfg = resolveEffectiveProbeConfig(dots, config);
    const { maxFlips, budget } = cfg;
    const n = dots.length;
    if (n === 0) return [];
    const order = marginOrder(dots);
    const rank = new Array(n);
    for (let r = 0; r < order.length; r++) rank[order[r]] = r;
    const candidateBits = cfg.exhaustive
        ? order.slice(0, Math.min(n, Math.max(0, Math.floor(cfg.depth || 0))))
        : order.slice(0, Math.min(n, maxFlips * Math.max(budget, 1)));

    const found = [];
    const maxFlipsEff = Math.min(maxFlips, candidateBits.length);
    const chosen = [];
    const recurse = (start) => {
        if (chosen.length > 0) {
            found.push({ bits: chosen.slice(), cost: perturbationCost(dots, chosen) });
        }
        if (chosen.length >= maxFlipsEff) return;
        for (let i = start; i < candidateBits.length; i++) {
            chosen.push(candidateBits[i]);
            recurse(i + 1);
            chosen.pop();
        }
    };
    recurse(0);

    found.sort((a, b) => {
        if (a.cost !== b.cost) return a.cost - b.cost;
        if (a.bits.length !== b.bits.length) return a.bits.length - b.bits.length;
        const ra = rank[a.bits[0]];
        const rb = rank[b.bits[0]];
        if (ra !== rb) return ra - rb;
        for (let i = 0; i < Math.min(a.bits.length, b.bits.length); i++) {
            const ai = rank[a.bits[i]];
            const bi = rank[b.bits[i]];
            if (ai !== bi) return ai - bi;
        }
        return 0;
    });

    return found.slice(0, budget);
}

// XOR a key with the masks for `bits`. Works for both plain-number keys
// (bits <= 32) and BigInt keys (the wide-hash fallback).
export function applyFlips(key, bits, bitMasks) {
    let out = key;
    for (const b of bits) out = out ^ bitMasks[b];
    return out;
}

// The ranked probe sequence for one table: the exact key first, then the
// perturbed keys in ascending margin cost, de-duplicated.
export function multiProbeKeys(key, dots, bitMasks, config = DEFAULT_MULTIPROBE_CONFIG) {
    const perturbations = rankPerturbations(dots, config);
    const seen = new Set([key]);
    const out = [key];
    for (const p of perturbations) {
        const k = applyFlips(key, p.bits, bitMasks);
        const id = typeof k === 'bigint' ? `b${k.toString()}` : k;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(k);
    }
    return out;
}

// Just the flips of the `budget` smallest-margin single bits — Lv's single-bit
// mode, the direct upgrade over the naive prefix flip used on the hot path.
export function marginSingleBitKeys(key, dots, bitMasks, budget) {
    const k = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : dots.length;
    const order = marginOrder(dots, k);
    const out = [key];
    const seen = new Set([key]);
    for (const b of order) {
        const flip = key ^ bitMasks[b];
        const id = typeof flip === 'bigint' ? `b${flip.toString()}` : flip;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(flip);
    }
    return out;
}

// The query-adaptive single-bit mode: the budget is read off the query's own
// margins (the containment depth for the config's target coverage), so a query
// that already sits far from every hyperplane probes nothing beyond the exact
// key while an ambiguous query probes deeper. See `adaptiveSingleBitBudget`.
export function adaptiveSingleBitKeys(key, dots, bitMasks, config = DEFAULT_ADAPTIVE_CONFIG) {
    return marginSingleBitKeys(key, dots, bitMasks, adaptiveSingleBitBudget(dots, config));
}

// The historical baseline: flip bits 0..budget-1 regardless of the query. Kept
// so the test suite can measure the recall gain against the behaviour it
// replaces.
export function prefixSingleBitKeys(key, bitMasks, budget) {
    const n = bitMasks.length;
    const k = Number.isFinite(budget) ? Math.max(0, Math.min(n, Math.floor(budget))) : n;
    const out = [key];
    for (let b = 0; b < k; b++) out.push(key ^ bitMasks[b]);
    return out;
}

// Which bits a perturbed neighbour flips, given the query margins `qDots` and
// the neighbour margins `nDots` (both = projection . hyperplane, same sign
// convention as the hash). Exact, deterministic.
export function flippedBits(qDots, nDots) {
    const out = [];
    const n = qDots.length;
    for (let b = 0; b < n; b++) {
        const q = qDots[b];
        const p = nDots[b];
        if ((q > 0) !== (p > 0)) out.push(b);
    }
    return out;
}

// The bound that makes margin order optimal: for a neighbour q + delta, every
// flipped bit has |q_b| < |delta_b| <= max|delta|. Returns the number of bits
// whose margin is below a perturbation magnitude, i.e. the smallest budget that
// is guaranteed to cover the whole flipped set.
export function marginCoverBudget(dots, perturbationMagnitude) {
    const bound = Number.isFinite(perturbationMagnitude) ? Math.abs(perturbationMagnitude) : Infinity;
    if (!Number.isFinite(bound)) return dots.length;
    let count = 0;
    for (const v of dots) {
        const m = Number.isFinite(v) ? Math.abs(v) : 0;
        if (m < bound) count++;
    }
    return count;
}
