// src/analysis/features/position.js (round-102 split of src/analysis/features.js).
// The position pipeline: bounds, causal z-score, per-candidate positions.
export const DEFAULT_POSITION = Object.freeze({ saturation: 2, zWindow: 32, minObs: 8 });

// Bounded position from a z-score: saturates at +/-1 at `saturation` standard
// deviations, is exactly 0 for a non-finite input, and never leaves [-1, 1].
export function clampPosition(z, { saturation = DEFAULT_POSITION.saturation } = {}) {
    if (!Number.isFinite(z) || !(saturation > 0)) return 0;
    const p = z / saturation;
    return p < -1 ? -1 : p > 1 ? 1 : p;
}

// ---- the causal z-score pipeline ------------------------------------------

// Causal z-score of a point-in-time feature. `fn(series, i, params)` must read
// only indices <= i. Returns 0 (abstain) when the window is not yet populated,
// when fewer than `minObs` finite observations exist, or when the std is 0.
export function causalZScore(fn, series, t, {
    window = 32, zWindow = DEFAULT_POSITION.zWindow, minObs = DEFAULT_POSITION.minObs, params = null,
} = {}) {
    const args = { window, ...(params || {}) };
    const raw = fn(series, t, args);
    if (!Number.isFinite(raw)) return 0;
    const vals = [];
    for (let i = Math.max(0, t - zWindow + 1); i <= t; i++) {
        const v = fn(series, i, args);
        if (Number.isFinite(v)) vals.push(v);
    }
    if (vals.length < minObs) return 0;
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    let acc = 0;
    for (const v of vals) acc += (v - m) * (v - m);
    const std = Math.sqrt(acc / (vals.length - 1));
    const scale = Math.max(1, Math.abs(m));
    if (!(std > 1e-12 * scale)) return 0;
    return (raw - m) / std;
}

// The position one candidate takes at bar `t`.
export function positionAt(candidate, series, t) {
    const z = causalZScore(candidate.fn, series, t, {
        window: candidate.window,
        zWindow: candidate.zWindow == null ? DEFAULT_POSITION.zWindow : candidate.zWindow,
        minObs: candidate.minObs == null ? DEFAULT_POSITION.minObs : candidate.minObs,
        params: candidate.params || null,
    });
    return clampPosition(z, { saturation: candidate.saturation == null ? DEFAULT_POSITION.saturation : candidate.saturation });
}

// The `signal(view, test)` a candidate contributes to the A/B. Missing series
// (e.g. a returns-only view has no closes) make the feature abstain, never throw.
export const signalForCandidate = (candidate) => (view, test) => {
    const series = {
        closes: view && view.closes ? view.closes : null,
        returns: view && view.returns ? view.returns : null,
        volumes: view && view.volumes ? view.volumes : null,
        // The cross-section, when the driver supplies one (see
        // `crossSectionalReversal`). Null on a single-stream view/no-panel run, in
        // which case a cross-sectional candidate abstains rather than throwing.
        panel: view && view.panel ? view.panel : null,
    };
    return test.map((t) => positionAt(candidate, series, t));
};

