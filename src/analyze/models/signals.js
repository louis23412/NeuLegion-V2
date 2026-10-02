// src/analyze/models/signals.js (round-98 split of src/analyze/models.js).
// Seed helper + signalForVariant dispatch.
import path from 'path';
import { mulberry32 } from '../../legion/rng.js';
import { confidenceToPosition } from '../../analysis/walkforward.js';
import { IDENTITY_POSITION_POLICY } from '../roster.js';



// Run core code under a seeded Math.random (the core draws random init and LSH
// probing), exactly like golden/sanity/walk-forward do.
export function withSeed(seed, fn) {
    const real = Math.random;
    Math.random = mulberry32(seed >>> 0);
    try { return fn(); } finally { Math.random = real; }
}

// `signalForVariant(variant)` -> `signalForFold(train, test, view)`.
//
// A signal candidate (`variant.signal`, the causal family from
// `analysis/features.js`) is pure array math on the view. A model variant builds a
// fresh model per fold, fits it on the view, then predicts the test bars.
export const makeSignalForVariant = (factory, { onStats = null, positionPolicy = IDENTITY_POSITION_POLICY } = {}) => (variant) => {
    if (typeof variant.signal === 'function') {
        // A signal candidate emits a signed confidence (its clamped causal z-score).
        // The SAME confidence->position policy maps it to a position (round 26,
        // R26-3); with the identity default this is byte-identical to the pre-R26-3
        // signal path. The raw confidence is cached for `confidenceForFold`.
        let lastConfidence = [];
        const fold = (train, test, view) => {
            lastConfidence = variant.signal(view, test);
            return lastConfidence.map((c) => confidenceToPosition(c, positionPolicy));
        };
        fold.confidenceForFold = () => lastConfidence;
        return fold;
    }
    let lastConfidence = [];
    const fold = (train, test, view) => {
        const model = factory(variant);
        model.fit(train, test, view);
        try {
            const positions = model.predict(test, view);
            lastConfidence = typeof model.rawConfidence === 'function' ? model.rawConfidence() : null;
            return positions;
        } finally {
            // Round 26 (R26-2): hand the caller this fold's model diagnostics
            // before the fit is released. Reporting only — an observer that throws
            // must never fail a fold.
            if (onStats && typeof model.stats === 'function') {
                try { onStats(variant, model.stats()); } catch { /* reporting is best-effort */ }
            }
            // The fold function is the only production caller, and it uses each
            // fitted model exactly once — so this is the right place to release the
            // fit's state (`modelRetention: 'discard'`). Disposal is a no-op when
            // the factory keeps state, and is idempotent.
            if (typeof model.dispose === 'function') model.dispose();
        }
    };
    fold.confidenceForFold = () => lastConfidence;
    return fold;
};

