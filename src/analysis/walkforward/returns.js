// Walk-forward signal/position primitives — split from `analysis/walkforward.js`
// in round 74 (byte-exact move; `walkforward.js` is now the re-export shim).
// Close-to-close returns, the confidence→position map and the fold-causality
// predicate. Self-contained (no imports).


// Close-to-close simple returns. `r[0] = 0` (no return is realised at the first
// bar), so the series is the same length as the closes.
export function barReturns(closes) {
    const out = new Array(closes.length).fill(0);
    for (let t = 1; t < closes.length; t++) out[t] = closes[t] / closes[t - 1] - 1;
    return out;
}

// Close-to-close log returns. `r[0] = 0`.
export function logReturns(closes) {
    const out = new Array(closes.length).fill(0);
    for (let t = 1; t < closes.length; t++) out[t] = Math.log(closes[t] / closes[t - 1]);
    return out;
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// ---- one confidence -> position pipeline (round 26, R26-3 / BUGS.md #34) ----
//
// Both candidate families are mapped to positions through THIS pair of functions,
// in one documented signed-confidence space `c ∈ [-1, 1]`:
//
//   controller:  c = (prob − 50) / 50                 (`confidenceFromProb`)
//   signal:      c = clamp(z / saturation, −1, 1)     (`analysis/features.js`)
//
// and then the SAME policy maps `c` to a position:
//
//   |c| ≤ deadZone  ->  0                             (abstain: no edge worth trading)
//   else            ->  sign(c) · (|c| − deadZone)/(1 − deadZone) · scale
//
// Before R26-3 the controller carried a dead zone and the signal family did not,
// so a turnover/participation comparison across the two families confounded the
// mapping with the signal. The policy is a run-level parameter (the A/B uses
// `CONTROLLER_POSITION_POLICY`) and the raw `c` is journaled, so a policy sweep is
// pure post-processing (`restateFoldsAtPolicy`).
//
// Properties: sign-preserving, bounded by `scale`, exactly 0 on the dead-zone band
// and for a non-finite confidence.
export function confidenceToPosition(confidence, { deadZone = 0, scale = 1 } = {}) {
    const raw = Number(confidence);
    if (!Number.isFinite(raw)) return 0;
    const c = clamp(raw, -1, 1);
    const dz = clamp(deadZone, 0, 0.999);
    const a = Math.abs(c);
    if (a <= dz) return 0;
    const mag = (a - dz) / (1 - dz);
    return Math.sign(c) * mag * scale;
}

// The controller's raw `prob` in [0, 100] as a signed confidence in [-1, 1].
export function confidenceFromProb(prob) {
    return clamp(Number(prob), 0, 100) / 50 - 1;
}

// A *holding / hysteresis* policy layer (round 26, R26-5) on top of the one
// confidence→position mapping. `confidenceToPosition` is pointwise, so it cannot
// express a no-trade band that depends on the *current* position — which is what a
// proportional trading cost makes optimal (Constantinides 1986; Davis & Norman 1990;
// Gârleanu & Pedersen 2013): enter at `|c| ≥ enter`, and do not leave until
// `|c| ≤ exit` (with `exit < enter`), optionally only after a minimum holding
// period. With no holding parameters this is exactly `confidences.map(confidenceToPosition)`,
// so every default path stays byte-identical.
export function positionSeriesFromConfidence(confidences, policy = {}) {
    const { deadZone = 0, scale = 1 } = policy;
    const enter = policy.enter;
    const exit = policy.exit;
    const rawHold = policy.minHold;
    const hold = Number.isFinite(rawHold) && rawHold > 0 ? Math.floor(rawHold) : 0;
    const holding = Number.isFinite(enter) || Number.isFinite(exit) || hold > 0;
    if (!holding) return confidences.map((c) => confidenceToPosition(c, { deadZone, scale }));
    const enterT = clamp(Number.isFinite(enter) ? enter : (Number.isFinite(deadZone) ? deadZone : 0), 0, 1);
    const exitT = clamp(Number.isFinite(exit) ? exit : 0, 0, enterT);
    const out = new Array(confidences.length).fill(0);
    let pos = 0;
    let held = 0;
    for (let i = 0; i < confidences.length; i++) {
        const c = Number(confidences[i]);
        const mag = Number.isFinite(c) ? Math.min(1, Math.abs(c)) : 0;
        const dir = c > 0 ? 1 : c < 0 ? -1 : 0;
        // The band is indexed by the dead zone too: a signal that would map to 0
        // under `{deadZone, scale}` is a 0-magnitude signal here.
        const effMag = mag <= clamp(deadZone, 0, 0.999) ? 0 : (mag - clamp(deadZone, 0, 0.999)) / (1 - clamp(deadZone, 0, 0.999));
        if (pos === 0) {
            if (dir !== 0 && effMag >= enterT) { pos = dir * scale; held = 0; }
        } else if (held >= hold) {
            if (dir === -pos && effMag >= enterT) { pos = dir * scale; held = 0; }
            else if (effMag <= exitT) { pos = 0; }
        }
        out[i] = pos;
        held += 1;
    }
    return out;
}

// Map a model confidence `prob` in [0, 100] to a position in [-scale, +scale].
//
// The controller path through the one pipeline above — kept as the public name the
// analysis layer and its tests already use. Properties (proved in
// analysis.test.js): odd about prob = 50, monotone non-decreasing for
// direction = 1, bounded by scale, exactly 0 on the dead-zone band, and clamped
// for out-of-range `prob`.
export function probToPosition(prob, { direction = 1, deadZone = 0, scale = 1 } = {}) {
    return Math.sign(direction || 1) * confidenceToPosition(confidenceFromProb(prob), { deadZone, scale });
}

// A fold is *causal* when every training index strictly precedes every test
// index — the condition a walk-forward deployment needs (purged K-fold may train
// on the future side of a test block, which is fine for a fixed signal but not
// for an online model).
export function isCausalFold(fold) {
    if (!fold || !Array.isArray(fold.train) || !Array.isArray(fold.test) || !fold.test.length) return false;
    const firstTest = Math.min(...fold.test);
    return fold.train.every((i) => i < firstTest);
}

// Aggregate a list of per-fold metric objects. `key` selects the metric (default
// net Sharpe). Ignores non-finite values so a degenerate fold cannot poison the