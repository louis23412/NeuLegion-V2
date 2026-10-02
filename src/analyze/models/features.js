// src/analyze/models/features.js (round-98 split of src/analyze/models.js).
// featureVector (model input row).
import { FEATURE_LEN } from '../roster.js';





// ---------------------------------------------------------------------------
// Feature vector + model factory (the online model the A/B drives)
// ---------------------------------------------------------------------------

// A causal feature vector: a trailing window of past returns, the current bar's
// sign, and (with `leaky`) a slot filled from returns[t+1] — the accidental
// lookahead the audit must catch.
export function featureVector(returns, t, { len = FEATURE_LEN, leaky = false } = {}) {
    const f = new Array(len).fill(0);
    for (let k = 0; k < len - 2; k++) {
        const idx = t - 1 - k;
        f[k] = idx >= 0 ? (returns[idx] ?? 0) * 100 : 0;
    }
    f[len - 2] = Math.sign(returns[t] ?? 0);
    f[len - 1] = leaky ? (returns[t + 1] ?? 0) * 1000 : 0;
    return f;
}
