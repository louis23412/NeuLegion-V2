// Homeostatic plasticity for per-member learning rates.
//
// The incumbent `_updateAdaptiveLearningRates` is a *rank-based* controller: it
// compares each member's composite score against a percentile of the ensemble
// and nudges the learning rate up or down. Rank-based control is blind to a
// common-mode shift — if every member becomes twice as active, the ranking is
// unchanged and the controller does nothing.
//
// Biological homeostasis (synaptic scaling; Turrigiano) regulates *absolute*
// activity toward a set-point rather than a ranking, and the same idea appears
// in continual-learning work as an outlier/plasticity controller (arXiv
// 2609.13771, "Homeostatic Continual Learning"). `homeostaticScale` is that
// controller in its simplest provable form: a bounded, monotone, error-driven
// multiplier with an exact fixed point at the target activity.
//
// Pure: no I/O, no RNG.

export const DEFAULT_HOMEOSTASIS_CONFIG = Object.freeze({
    target: 1,        // desired activity (output magnitude) for a member
    gain: 0.5,        // proportional gain
    minScale: 0.5,    // clamp on the per-step multiplier
    maxScale: 1.5,
    momentum: 0.5,    // EMA weight when smoothing the activity signal
});

export function resolveHomeostasisConfig(config) {
    if (!config) return DEFAULT_HOMEOSTASIS_CONFIG;
    const base = DEFAULT_HOMEOSTASIS_CONFIG;
    const num = (v, d) => (Number.isFinite(v) ? v : d);
    return {
        target: num(config.target, base.target),
        gain: num(config.gain, base.gain),
        minScale: num(config.minScale, base.minScale),
        maxScale: num(config.maxScale, base.maxScale),
        momentum: num(config.momentum, base.momentum),
    };
}

// Stability condition for the unclamped proportional controller: iterating
// lr <- lr * (1 + gain*(target - k*lr)) has contraction factor |1 - gain*target|
// around the fixed point target/k, so it converges iff 0 < gain*target < 2.
export function isStableConfig(config = null) {
    const cfg = resolveHomeostasisConfig(config);
    const rate = cfg.gain * cfg.target;
    return rate > 0 && rate < 2;
}

// Multiplier applied to a member's learning rate given its (current) activity.
// activity == target -> exactly 1. Over-active -> < 1. Under-active -> > 1.
export function homeostaticScale(activity, config = null) {
    const cfg = resolveHomeostasisConfig(config);
    const a = Number.isFinite(activity) ? activity : cfg.target;
    const raw = 1 + cfg.gain * (cfg.target - a);
    if (raw < cfg.minScale) return cfg.minScale;
    if (raw > cfg.maxScale) return cfg.maxScale;
    return raw;
}

export function homeostaticLearningRates(learningRates, activities, config = null) {
    const cfg = resolveHomeostasisConfig(config);
    return learningRates.map((lr, i) => lr * homeostaticScale(activities[i], cfg));
}

// EMA of |value|: the smoothed activity signal a member is regulated against.
export function updateActivity(previous, value, config = null) {
    const cfg = resolveHomeostasisConfig(config);
    const prev = Number.isFinite(previous) ? previous : 0;
    if (!Number.isFinite(value)) return prev;
    return (1 - cfg.momentum) * prev + cfg.momentum * Math.abs(value);
}

export function rootMeanSquare(values) {
    let sum = 0, n = 0;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (Number.isFinite(v)) { sum += v * v; n++; }
    }
    return n > 0 ? Math.sqrt(sum / n) : 0;
}

// Sum of squared deviation from the set-point: the quantity homeostasis drives
// down, and the natural metric for comparing controllers.
export function deviationEnergy(activities, config = null) {
    const cfg = resolveHomeostasisConfig(config);
    let energy = 0;
    for (let i = 0; i < activities.length; i++) {
        const a = activities[i];
        if (Number.isFinite(a)) { const d = a - cfg.target; energy += d * d; }
    }
    return energy;
}
