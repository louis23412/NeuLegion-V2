// src/analyze/models/controllers.js (round-98 split of src/analyze/models.js).
// Controller model factory (the shipped evaluation model).
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../../legion/config.js';
import { mulberry32, hashString } from '../../legion/rng.js';
import { confidenceToPosition, confidenceFromProb } from '../../analysis/walkforward.js';
import { FEATURE_LEN, CONTROLLER_POSITION_POLICY, IDENTITY_POSITION_POLICY, CONTROLLER_MODEL } from '../roster.js';
import { labelDiagnostics } from './stats.js';
import { withSeed } from './signals.js';



// The controller-backed model factory (ROADMAP round 23, N0): the A/B's model is
// the SHIPPED one — a real `HiveMindController` fed the real candle series, with
// its 10-indicator feature vector, trade bookkeeping and closed-trade training —
// instead of a bare `HiveMind` on a 6-element return vector.
//
// Per fold it streams bars `0 .. testStart-1` **through the same window shape
// production uses** (`legion/workers.js` passes `state.cache.slice(-cacheSize)`,
// i.e. the last `cacheSize` candles; the controller trims its own candle table to
// `cacheSize`), so the per-call input is always
// `candles.slice(max(0, i - cacheSize), i)` — contiguous and advancing. Feeding the
// whole growing prefix instead (as the driver did before round 26) re-inserts the
// trimmed history on every call and hands `_updateOpenTrades` bars older than the
// trade's entry, which mislabels the training stream (`BUGS.md` #33). Purge
// exclusions are still not honoured — a streaming model cannot skip bars — which
// is documented. The test bars are evaluated **prequentially**: the position at bar
// t is read from `getSignal(candles.slice(max(0, t + 1 - cacheSize), t + 1))`, so it
// only ever uses information available at t, and the realised return is t -> t+1.
// The audit (`analysis/world.js`) certifies exactly that property.
//
// Model flags: `variant.configure` is applied to the controller (so
// `_sampleWeightConfig` lands where the controller reads it) AND to the
// pre-created underlying `HiveMind` (where the mind-level flags —
// `_surpriseGateEnabled`, `_homeostasisEnabled`, `_multiProbeConfig`,
// `_pcaHashConfig`, `_queryModConfig` — are read). `variant.afterFit` runs on the
// mind (the pca-hash hyperplane refresh). Pre-creating `_hivemind` is what makes
// a mind-level flag reachable before the first `getSignal`.
export const makeControllerModelFactory = ({
    HiveMind, HiveMindController, stateDir, seed = 1,
    cacheSize = CONTROLLER_MODEL.cacheSize, ensembleSize = CONTROLLER_MODEL.ensembleSize,
    tier = CONTROLLER_MODEL.tier, warmup = CONTROLLER_MODEL.warmup,
    positionPolicy = CONTROLLER_POSITION_POLICY,
    modelRetention = 'keep',
    saveInterval = 1,
    labelPolicy = 'optimistic',
    labelHorizonBars = null,
    // R28 (BUGS.md #58 / P1c): an explicit span horizon for the causal sample-weight
    // ring. When null the variant falls back to the label horizon (if it has a real
    // vertical barrier) and then to the CAUSAL MEASURED estimate.
    sampleWeightHorizon = null,
    // Round 26 (R26-13): see `makeHiveMindModelFactory`.
    commonRandomNumbers = true,
    priceObj = {
        atrFactor: CONFIG.baseAtr, stopFactor: CONFIG.baseStop,
        minPriceMovement: CONFIG.minPriceMove, maxPriceMovement: CONFIG.maxPriceMove,
    },
} = {}) => {
    let fitCounter = 0;
    return (variant) => {
        let ctl = null;
        let mind = null;
        let predictSeed = 0;
        // The raw pre-policy signed confidence per test bar (round 26, R26-3), so the
        // driver can journal it and restate the report at another policy.
        let lastConfidence = [];
        let warmErrors = 0;
        let folds = 0;
        let undertrained = false;
        // Readiness (round 26, R26-2 / BUGS.md #35). The old gate was
        // `testStart >= warmup` (40) while the default split's first test bar is
        // >= trainSize (60), so it could never fire — a false certificate. The
        // model's own readiness signal is whether it trained at all; a fold whose
        // controller never trained abstains (its `prob` would be the -1 sentinel
        // anyway, but this makes the reason explicit and testable).
        let ready = false;
        let dir = null;
        let reclaimed = false;
        // 'discard' closes the fit's SQLite handle and removes its state directory.
        // Both files of a fit live under `dir` (the controller's `hivemind_controller-*.db`
        // and the mind's `hivemind_state-*.db`); the mind opens its connection per
        // save/load rather than holding one, so the controller handle is the only
        // one to close. Every step is best-effort: a failed close or delete must
        // never fail the run.
        const reclaim = () => {
            if (reclaimed || modelRetention !== 'discard' || !dir) return { closed: false, removed: false };
            reclaimed = true;
            let closed = false;
            for (const model of [ctl, mind]) {
                try {
                    const db = model && model._db;
                    if (db && typeof db.close === 'function') { db.close(); closed = true; }
                } catch { /* ignore */ }
            }
            let removed = false;
            try {
                if (typeof fs.rmSync === 'function') { fs.rmSync(dir, { recursive: true, force: true }); removed = true; }
            } catch { /* ignore */ }
            return { closed, removed };
        };
        // R26-12: with `modelRetention: 'keep'` and a non-finite save interval the
        // ensemble state is never written during the run, so a kept fit directory
        // would hold no state at all. Flush it once at disposal. Under `discard` the
        // directory is deleted immediately afterwards, so the write would be pure
        // waste and is skipped. Off the arithmetic path either way.
        const flushKeptState = () => {
            if (modelRetention !== 'keep' || Number.isFinite(saveInterval) || !ctl) return;
            try { if (typeof ctl.flushState === 'function') ctl.flushState(); } catch { /* best effort */ }
        };
        const variantSeed = (seed * 131 + (hashString(variant.id) % 100000)) >>> 0;
        return {
            fit(train, test, view) {
                const candles = view.candles || [];
                const testStart = Math.min(...test);
                const foldSeed = ((commonRandomNumbers ? seed : variantSeed) + testStart * 977) >>> 0;
                dir = path.join(stateDir, `${variant.id}-${fitCounter++}`);
                folds++;
                // A fold with too little history abstains (documented; reads only
                // the past, so it cannot leak).
                undertrained = !(testStart >= warmup);
                withSeed(foldSeed, () => {
                    ctl = new HiveMindController(`AN-${variant.id}`, dir, cacheSize, ensembleSize, 'positive', tier, priceObj, true);
                    // R26-12: the A/B never reads the checkpoint back, so it does
                    // not pay for it (default via runAnalysis is Infinity; the
                    // factory default of 1 keeps the direct-call behaviour and the
                    // golden fingerprints unchanged).
                    ctl._saveInterval = saveInterval;
                    // Round 26 (R26-11): the run-level label policy. Set BEFORE the
                    // variant's configure, so a label variant can override it. The
                    // default 'optimistic' is the shipped behaviour (bit-identical).
                    ctl._labelPolicy = labelPolicy;
                    ctl._labelHorizonBars = Number.isFinite(labelHorizonBars) ? labelHorizonBars : null;
                    // R28 (BUGS.md #58): the explicit sample-weight span horizon
                    // (null = the variant decides: label horizon, else measured).
                    ctl._sampleWeightHorizon = Number.isFinite(sampleWeightHorizon) && sampleWeightHorizon > 0
                        ? Math.floor(sampleWeightHorizon)
                        : null;
                    if (variant.configure) variant.configure(ctl);
                    // Pre-create the mind so mind-level flags are reachable.
                    mind = new HiveMind(dir, ensembleSize, ctl._inputSize, `AN-${variant.id}`, true);
                    ctl._hivemind = mind;
                    if (variant.configure) variant.configure(mind);
                    for (let i = 1; i <= testStart; i++) {
                        try { ctl.getSignal(candles.slice(Math.max(0, i - cacheSize), i), 1); } catch { warmErrors++; }
                    }
                    if (variant.afterFit) variant.afterFit(mind);
                });
                // Readiness is decided once the fit is complete: a controller that
                // closed no trade never trained, and every test bar abstains.
                ready = !!(ctl && ctl._globalAccuracy && Number.isFinite(ctl._globalAccuracy.trainingSteps) && ctl._globalAccuracy.trainingSteps > 0);
                predictSeed = (foldSeed + 7777) >>> 0;
            },
            predict(test, view) {
                if (!ready) { lastConfidence = test.map(() => 0); return test.map(() => 0); }
                const candles = view.candles || [];
                return withSeed(predictSeed, () => {
                    // The raw signed confidence per bar, then ONE policy maps it to a
                    // position (round 26, R26-3). `confidenceToPosition(confidenceFromProb(p))`
                    // is byte-identical to the old `probToPosition(p, policy)`.
                    const confidences = test.map((t) => {
                        let prob = 50;
                        try {
                            const s = ctl.getSignal(candles.slice(Math.max(0, t + 1 - cacheSize), t + 1), 1);
                            // `prob === -1` is the documented "untrained" sentinel: abstain.
                            if (s && Number.isFinite(s.prob) && s.prob >= 0) prob = s.prob;
                        } catch { /* a failed decision abstains, never throws */ }
                        return confidenceFromProb(prob);
                    });
                    lastConfidence = confidences;
                    return confidences.map((c) => confidenceToPosition(c, positionPolicy));
                });
            },
            // The raw pre-policy confidence for the last `predict`, or [] before it.
            rawConfidence: () => lastConfidence,
            dispose: () => { flushKeptState(); return reclaim(); },
            // One fold's model diagnostics (round 26, R26-2): the readiness flag,
            // the label-lifecycle split, the base rate and the skill scores, plus
            // the `raw` counters a cross-fold accumulator pools.
            stats: () => ({
                warmErrors, folds, undertrained, ready,
                retention: modelRetention, reclaimed,
                // R27-4b/R27-3 diagnostics: the cache-bounded holding cap and the
                // causal-window sample-weight raw counters (null when the mechanism
                // is off, which is the default and every golden fingerprint).
                heldBarsCap: (Number.isFinite(cacheSize) && cacheSize > 1) ? cacheSize - 1 : null,
                sampleWeightsRaw: (ctl && ctl._sampleWeightStats)
                    ? { ...ctl._sampleWeightStats }
                    : null,
                ...labelDiagnostics(ctl ? ctl._globalAccuracy : {}),
            }),
        };
    };
};
