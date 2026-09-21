// Surprise-gated memory writes for the semantic prototype bank.
//
// Grounding: Behrouz et al., "Titans: Learning to Memorize at Test Time"
// (arXiv 2501.00663). Titans' memory module is written by the *surprise* of an
// observation -- the gradient of the associative-memory loss against the
// current memory content -- rather than by every observation equally. A
// predictable input (one the memory already reconstructs) produces almost no
// write; a surprising input writes strongly. A momentum-smoothed surprise is
// used so a *sustained* surprise writes more than an isolated spike.
//
// Mapping onto NeuLegion: `_updateSemanticProtos` already measures, for every
// candidate prototype, the best kernel similarity `bestSim` to the existing
// bank. That is exactly "how well does my memory already predict this
// observation", so `1 - bestSim` is the write's surprise and
// `surpriseGate(surprise)` is the factor that scales how strongly the
// observation is written (merge strength / new-prototype size).
//
// Everything here is pure and deterministic. The gate is *disabled* by default
// (`HiveMind._surpriseGateEnabled = false`), where the hot path multiplies by
// exactly 1.0 -- an IEEE-754 no-op -- so the golden fingerprints are unchanged.
// `surpriseGate(s, {floor: 1}) === 1` for every `s`, which is what makes the
// "gate off" path provably bit-identical to "gate on with floor 1" (see
// test/browser/entries/surprise.test.js section B).

export const DEFAULT_SURPRISE_CONFIG = Object.freeze({
    // Write strength for a perfectly predictable observation (surprise 0).
    // Surprise 1 writes at full strength (1.0). A floor > 0 keeps a small amount
    // of plasticity for familiar inputs so the bank can still drift.
    floor: 0.1,
    // Exponent applied to the surprise signal before it is mapped to
    // [floor, 1]. 1 is linear; > 1 suppresses mild surprise harder.
    sharpness: 1,
    // Momentum-smoothing decay for the optional smoothed-surprise mode
    // (`momentumWeight > 0`). 0.9 = a ~10-step half-life.
    momentumDecay: 0.9,
    // 0 = gate on the raw per-observation surprise (deterministic, default);
    // 1 = gate purely on the smoothed momentum.
    momentumWeight: 0,
});

// Clamp to [0, 1]; NaN -> 0 (a missing observation is "no surprise" for safety).
export function clamp01(x) {
    if (Number.isNaN(x)) return 0;
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return x;
}

// How surprising an observation is, given how similar it is to the closest
// thing the memory already holds. Similarity 1 (already known) -> 0 surprise.
export function surpriseFromSimilarity(similarity) {
    return clamp01(1 - similarity);
}

// Map a surprise in [0, 1] to a write-strength multiplier in [floor, 1].
//   * gate(0) === floor, gate(1) === 1
//   * monotone non-decreasing in surprise (for sharpness > 0)
//   * floor === 1  =>  gate === 1 for every surprise (the exact off switch)
export function surpriseGate(surprise, config) {
    const cfg = config || DEFAULT_SURPRISE_CONFIG;
    const floor = clamp01(cfg.floor ?? DEFAULT_SURPRISE_CONFIG.floor);
    const sharpness = cfg.sharpness ?? DEFAULT_SURPRISE_CONFIG.sharpness;
    const s = clamp01(surprise);
    if (floor >= 1) return 1;
    if (sharpness === 1) return floor + (1 - floor) * s;
    return floor + (1 - floor) * Math.pow(s, sharpness);
}

export function surpriseGateFromSimilarity(similarity, config) {
    return surpriseGate(surpriseFromSimilarity(similarity), config);
}

// Momentum accumulator for the smoothed-surprise mode. With decay d, a constant
// surprise s converges to s, and an isolated spike decays geometrically by d.
export function updateSurpriseMomentum(prevMomentum, surprise, config) {
    const cfg = config || DEFAULT_SURPRISE_CONFIG;
    const decay = clamp01(cfg.momentumDecay ?? DEFAULT_SURPRISE_CONFIG.momentumDecay);
    const prev = clamp01(prevMomentum);
    const s = clamp01(surprise);
    return decay * prev + (1 - decay) * s;
}

// Blend raw and momentum-smoothed surprise. momentumWeight = 0 reproduces the
// raw surprise exactly (so the default hot path is deterministic and state-free).
export function smoothedSurprise(surprise, momentum, config) {
    const cfg = config || DEFAULT_SURPRISE_CONFIG;
    const weight = clamp01(cfg.momentumWeight ?? DEFAULT_SURPRISE_CONFIG.momentumWeight);
    if (weight === 0) return clamp01(surprise);
    return clamp01((1 - weight) * clamp01(surprise) + weight * clamp01(momentum));
}
