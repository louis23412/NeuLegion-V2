// Sample-uniqueness weighting for training.
//
// When labels span a horizon, neighbouring observations share information, so
// the nominal sample size overstates the evidence. Lopez de Prado, "Advances in
// Financial Machine Learning", ch. 4, weights each observation by its *average
// uniqueness* — the mean of 1/concurrency over its label span — so that the
// weighted objective's effective sample size equals the number of independent
// observations the labels actually carry.
//
// This is the training-side primitive. It is deliberately self-contained: the
// hot path must never import from `src/analysis/` (analysis modules have to stay
// off the locked path), so the ch.4 uniqueness formula is re-implemented here in
// its training-weight form. `sample_weights.test.js` cross-checks it against
// `analysis/uniqueness.js` on shared fixtures so the two can never silently
// diverge.
//
// Pure: no I/O, no RNG.

// `normalization`:
//   'none'  -> the raw average uniqueness, in (0, 1].
//   'mean1' -> rescaled so the mean weight is exactly 1 (keeps the effective
//              learning rate unchanged while redistributing credit).
//   'sum1'  -> rescaled so the weights sum to exactly 1 (a convex combination).
// `minWeight` / `maxWeight` bound the weights before normalisation; the default
// only floors them (a unique label is never worth more than a constant
// `maxWeight` only if the caller asks for it).
export const DEFAULT_WEIGHT_CONFIG = Object.freeze({
    normalization: 'mean1',
    minWeight: 0,
    maxWeight: Infinity,
    horizonBars: 1,
});

function resolveWeightConfig(config) {
    if (!config) return DEFAULT_WEIGHT_CONFIG;
    const base = DEFAULT_WEIGHT_CONFIG;
    const cfg = {
        normalization: config.normalization ?? base.normalization,
        minWeight: Number.isFinite(config.minWeight) ? config.minWeight : base.minWeight,
        maxWeight: config.maxWeight === undefined ? base.maxWeight
            : (Number.isFinite(config.maxWeight) ? config.maxWeight : base.maxWeight),
        horizonBars: Number.isFinite(config.horizonBars) ? config.horizonBars : base.horizonBars,
    };
    return cfg;
}

// labelSpans: array of [start, end] inclusive per observation.
// Returns the average uniqueness of each span in (0, 1]: for a span it is the
// mean over its inclusive bars of 1 / (number of spans covering that bar).
export function overlapUniqueness(labelSpans) {
    const n = labelSpans.length;
    if (!n) return [];
    let maxEnd = 0;
    for (let i = 0; i < n; i++) {
        const s = labelSpans[i][0], e = labelSpans[i][1];
        if (e > maxEnd) maxEnd = e;
        if (s > maxEnd) maxEnd = s;
    }
    const concurrency = new Float64Array(maxEnd + 1);
    for (let i = 0; i < n; i++) {
        const s = labelSpans[i][0], e = labelSpans[i][1];
        for (let t = s; t <= e; t++) concurrency[t] += 1;
    }
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
        const s = labelSpans[i][0], e = labelSpans[i][1];
        let acc = 0;
        for (let t = s; t <= e; t++) acc += 1 / concurrency[t];
        out[i] = acc / (e - s + 1);
    }
    return out;
}

export function clampWeights(weights, minWeight = 0, maxWeight = Infinity) {
    const lo = Number.isFinite(minWeight) ? minWeight : 0;
    const hi = Number.isFinite(maxWeight) ? maxWeight : Infinity;
    return weights.map((w) => (w < lo ? lo : (w > hi ? hi : w)));
}

export function normalizeWeights(weights, normalization = 'mean1') {
    const n = weights.length;
    if (!n) return [];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += weights[i];
    if (!(sum > 0)) return weights.map(() => 1);
    if (normalization === 'mean1') {
        const k = n / sum;
        return weights.map((w) => w * k);
    }
    if (normalization === 'sum1') {
        const k = 1 / sum;
        return weights.map((w) => w * k);
    }
    return weights.slice();
}

// Effective sample size of a weight vector: (Σw)² / Σw². Uniform weights over n
// samples give exactly n; a skewed vector gives less, which is the whole point of
// uniqueness weighting.
export function weightEffectiveSampleSize(weights) {
    let sum = 0, sumSq = 0;
    for (let i = 0; i < weights.length; i++) {
        const w = weights[i];
        sum += w;
        sumSq += w * w;
    }
    if (!(sumSq > 0)) return 0;
    return (sum * sum) / sumSq;
}

export function weightedMean(values, weights) {
    let num = 0, den = 0;
    for (let i = 0; i < values.length; i++) {
        const w = weights[i];
        if (!Number.isFinite(w) || !Number.isFinite(values[i])) continue;
        num += w * values[i];
        den += w;
    }
    return den > 0 ? num / den : NaN;
}

// The full pipeline used by callers: average uniqueness -> clamp -> normalise.
export function sampleWeights(labelSpans, config = null) {
    const cfg = resolveWeightConfig(config);
    const uniqueness = overlapUniqueness(labelSpans);
    if (!uniqueness.length) return [];
    return normalizeWeights(clampWeights(uniqueness, cfg.minWeight, cfg.maxWeight), cfg.normalization);
}

// Batch convenience for the streaming controller: trades carry an entry bar
// index (or timestamp-derived index); each label occupies `horizonBars` bars
// from its entry, so two trades whose entries are closer than the horizon
// overlap and share credit.
export function spanWeightsFromEntries(entries, config = null) {
    const cfg = resolveWeightConfig(config);
    const n = entries.length;
    if (!n) return [];
    const horizon = Math.max(1, Math.floor(cfg.horizonBars));
    const spans = new Array(n);
    for (let i = 0; i < n; i++) {
        const raw = Math.round(entries[i]);
        const start = Number.isFinite(raw) ? raw : 0;
        spans[i] = [start, start + horizon - 1];
    }
    return sampleWeights(spans, cfg);
}

// Causal streaming-window weight (round 27, R27-3). The controller keeps a ring
// of the last `windowBars` OBSERVED label spans; a new label's weight is its
// average uniqueness measured against that ring PLUS itself, mean-1 normalised
// over the whole window so the mean weight stays 1 (the effective learning rate
// is unchanged). Pure: no I/O, no RNG, no mutation of `windowSpans`.
//
// `windowSpans` / `newSpan` are `[startBar, endBar]` inclusive spans in a shared
// bar-index space. The spans are rebased before the concurrency sweep so the
// internal `Float64Array` stays O(windowBars + horizon) regardless of how far the
// bar clock has advanced. Returns the new label's normalised weight, the window's
// Kish effective sample size (`ess`) and size (`n`), and the raw window vector —
// so an all-ones result (the non-overlapping/inert case) is visible.
export function causalWindowWeight(windowSpans, newSpan, config = null) {
    const cfg = resolveWeightConfig(config);
    const spans = [];
    if (Array.isArray(windowSpans)) {
        for (const s of windowSpans) {
            if (Array.isArray(s) && Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] >= s[0]) {
                spans.push([s[0], s[1]]);
            }
        }
    }
    const usable = Array.isArray(newSpan) && Number.isFinite(newSpan[0]) && Number.isFinite(newSpan[1]) && newSpan[1] >= newSpan[0];
    if (!usable) {
        return { weight: 1, ess: spans.length, n: spans.length, windowUniqueness: null, normalized: null };
    }
    spans.push([newSpan[0], newSpan[1]]);
    let minStart = Infinity;
    for (const s of spans) if (s[0] < minStart) minStart = s[0];
    const rebased = spans.map(([s, e]) => [s - minStart, e - minStart]);
    const uniqueness = overlapUniqueness(rebased);
    const normalized = normalizeWeights(clampWeights(uniqueness, cfg.minWeight, cfg.maxWeight), cfg.normalization);
    const n = normalized.length;
    return {
        weight: normalized[n - 1],
        ess: weightEffectiveSampleSize(normalized),
        n,
        windowUniqueness: uniqueness,
        normalized,
    };
}
