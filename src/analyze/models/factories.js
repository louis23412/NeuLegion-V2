// src/analyze/models/factories.js (round-98 split of src/analyze/models.js).
// HiveMind + benchmark model factories.
import fs from 'fs';
import path from 'path';
import { hashString } from '../../legion/rng.js';
import { makeBenchmarkForecaster } from '../../analysis/benchmark.js';
import { FEATURE_LEN } from '../roster.js';
import { featureVector } from './features.js';
import { withSeed } from './signals.js';



// Everything the core needs from a model: fit(train, test, returns) then
// predict(test, returns) -> positions. This is the shape `signalForVariant`
// must return per variant.
//
// Contract (round 23): `fit(train, test, view)` and `predict(test, view)` read the
// model's data from the VIEW object (`view.returns` here), never from a closed-over
// array — that is what lets the audit perturb the model's actual input.
// `modelRetention` (round 24): 'keep' leaves every fit's state directory behind
// (the old behaviour, and what forensics needs); 'discard' closes the fit's
// database and deletes its directory the moment its prediction has been consumed,
// so a run cannot bloat storage. `runAnalysis` defaults to 'discard'.
export const makeHiveMindModelFactory = ({
    HiveMind, stateDir, seed = 1, len = FEATURE_LEN, leaky = false, modelRetention = 'keep',
    // Round 26 (R26-13): common random numbers. When true the per-fold seed is
    // VARIANT-INDEPENDENT (`seed + testStart*977`), so every variant is fitted and
    // predicted on the same random draws and the variance of the *difference*
    // between variants falls (Glasserman & Yao 1992) — the quantity a promotion
    // decision uses. When false the historical per-variant seed is restored.
    commonRandomNumbers = true,
}) => {
    let fitCounter = 0;
    return (variant) => {
        let hm = null;
        let predictSeed = 0;
        let lastConfidence = [];
        let dir = null;
        let reclaimed = false;
        const reclaim = () => {
            if (reclaimed || modelRetention !== 'discard' || !dir) return { closed: false, removed: false };
            reclaimed = true;
            let closed = false;
            try {
                const db = hm && hm._db;
                if (db && typeof db.close === 'function') { db.close(); closed = true; }
            } catch { /* a failed close must never fail the run */ }
            let removed = false;
            try {
                if (typeof fs.rmSync === 'function') { fs.rmSync(dir, { recursive: true, force: true }); removed = true; }
            } catch { /* a failed delete must never fail the run */ }
            return { closed, removed };
        };
        const variantSeed = (seed * 131 + (hashString(variant.id) % 100000)) >>> 0;
        return {
            fit(train, test, view) {
                const returns = view.returns;
                const testStart = Math.min(...test);
                const foldSeed = ((commonRandomNumbers ? seed : variantSeed) + testStart * 977) >>> 0;
                // A unique directory per fit so no fit resumes another's state.
                dir = path.join(stateDir, `${variant.id}-${fitCounter++}`);
                const bars = train.filter((t) => t + 1 < testStart);
                const labels = bars.map((t) => ((returns[t + 1] ?? 0) > 0 ? 1 : 0));
                withSeed(foldSeed, () => {
                    hm = new HiveMind(dir, 3, len, `AN-${variant.id}`, true);
                    if (variant.configure) variant.configure(hm);
                    for (let i = 0; i < bars.length; i++) hm.train(featureVector(returns, bars[i], { len, leaky }), labels[i]);
                    if (variant.afterFit) variant.afterFit(hm);
                });
                predictSeed = (foldSeed + 7777) >>> 0;
            },
            predict(test, view) {
                const returns = view.returns;
                // `(prob - 0.5) * 2` is already a signed confidence in [-1, 1], so the
                // bare model needs no policy (confidence === position).
                const confidences = withSeed(predictSeed, () => test.map((t) => (hm.predict(featureVector(returns, t, { len, leaky })) - 0.5) * 2));
                lastConfidence = confidences;
                return confidences;
            },
            rawConfidence: () => lastConfidence,
            // Explicit, idempotent disposal. Called by `makeSignalForVariant` after
            // predict, so an in-memory model can still be re-predicted by tests.
            dispose: () => reclaim(),
            stats: () => ({ trained: hm ? 1 : 0, retention: modelRetention, reclaimed }),
        };
    };
};

// P1 (round 29 → 30): the benchmark model factory. It returns the SAME per-fold
// model interface the HiveMind factories do (`fit/predict/rawConfidence/stats/
// dispose`), so it drops into `makeSignalForVariant` and `evaluateAB` unchanged —
// which is what puts the benchmark on the same folds, labels, features, audit,
// gate, cost ladder and forecast block as every other arm. The forecaster is a
// pure `analysis/benchmark.js` model (base rate / ridge / MLP); the features are
// the existing causal `featureVector`, and the labels are `sign(ret[t+1])`, i.e.
// exactly what `forecastPairs` scores. The per-fold seed follows the same
// `(seed + testStart*977)` common-random-numbers rule as the bare path, so a
// benchmark run is deterministic and CRN-consistent.
export const makeBenchmarkModelFactory = ({ seed = 1, len = FEATURE_LEN } = {}) => (variant) => {
    const kind = variant && variant.benchmark;
    const baseOptions = { ...(variant && variant.benchmarkOptions) };
    let forecaster = null;
    let model = null;
    let lastConfidence = [];
    return {
        fit(train, test, view) {
            const returns = view.returns;
            const testStart = Math.min(...test);
            const foldSeed = (seed + testStart * 977) >>> 0;
            const bars = train.filter((t) => t + 1 < testStart);
            const X = bars.map((t) => featureVector(returns, t, { len, leaky: false }));
            const y = bars.map((t) => ((returns[t + 1] ?? 0) > 0 ? 1 : 0));
            const opts = { ...baseOptions };
            if (kind === 'mlp' && !Number.isFinite(opts.seed)) opts.seed = foldSeed;
            forecaster = makeBenchmarkForecaster(kind, opts);
            model = X.length ? forecaster.fit(X, y) : null;
        },
        predict(test, view) {
            const returns = view.returns;
            if (!model || !forecaster) { lastConfidence = test.map(() => 0); return lastConfidence; }
            lastConfidence = test.map((t) => {
                const p = forecaster.predictProb(model, featureVector(returns, t, { len, leaky: false }));
                // `(p - 0.5) * 2` is a signed confidence in [-1, 1] (the bare path's
                // convention), so `confidence === position` with the identity policy.
                return (p - 0.5) * 2;
            });
            return lastConfidence;
        },
        rawConfidence: () => lastConfidence,
        dispose: () => { model = null; },
        stats: () => ({ trained: model ? 1 : 0, retention: 'none', benchmark: kind }),
    };
};
