// A/B model factories — feature vector, controller/benchmark factories, signal wiring (round-83 split).
// Uses node fs/path only for factory state-dir cleanup (same as the single file); re-exported by the shim.
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../legion/config.js';
import { mulberry32, hashString } from '../legion/rng.js';
import { confidenceToPosition, confidenceFromProb } from '../analysis/walkforward.js';
import { makeBenchmarkForecaster } from '../analysis/benchmark.js';
import { FEATURE_LEN, CONTROLLER_POSITION_POLICY, IDENTITY_POSITION_POLICY, CONTROLLER_MODEL } from './roster.js';



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

// Label-lifecycle + skill diagnostics for one controller's `_globalAccuracy`
// (round 26, R26-2 / `BUGS.md` #37). Pure, side-effect-free, module-private.
//
// A model's raw accuracy is unreadable without its reference point: at the
// shipped factors the stop is half as far as the take-profit, so the label base
// rate is ≈27 % TP and "always predict stop" reads as 73 % accurate. So the
// diagnostics are *referenced* to the base rate with proper scores:
//
//   baseRate       fraction of scored trades resolved at the take-profit
//   brier          mean Brier score of the entry confidence (lower is better)
//   brierBaseline  the base-rate forecast's Brier score, p̄(1−p̄)
//   brierSkill     1 − brier/brierBaseline. Proper (Gneiting & Raftery 2007), so
//                  hedging to the base rate cannot earn skill; > 0 is a real edge
//   accuracy       directional hit rate, wins/total
//   chanceAccuracy the base-rate forecast's accuracy, max(baseRate, 1−baseRate)
//   accuracySkill  accuracy − chanceAccuracy (Heidke-style chance correction)
//   status         'not-trained' | 'base-rate' | 'skilful' (three states, not two)
//
// `raw` carries the un-derived counters so a cross-fold accumulator can pool the
// sample and recompute the rates over it, instead of averaging per-fold rates.
const labelDiagnostics = (ga = {}) => {
    const num = (v) => (Number.isFinite(v) ? v : 0);
    const trainingSteps = num(ga.trainingSteps);
    const takeProfit = num(ga.resolvedTakeProfit);
    const stopLoss = num(ga.resolvedStopLoss);
    const resolvedTotal = takeProfit + stopLoss;
    const baseRate = resolvedTotal > 0 ? takeProfit / resolvedTotal : null;
    const brierCount = num(ga.brierCount);
    const brier = brierCount > 0 ? num(ga.brierSum) / brierCount : null;
    const brierBaseline = baseRate == null ? null : baseRate * (1 - baseRate);
    const brierSkill = (brier != null && brierBaseline != null && brierBaseline > 0)
        ? 1 - brier / brierBaseline
        : null;
    const scored = num(ga.total);
    const accuracy = scored > 0 ? num(ga.wins) / scored : null;
    const chanceAccuracy = baseRate == null ? null : Math.max(baseRate, 1 - baseRate);
    const accuracySkill = (accuracy != null && chanceAccuracy != null) ? accuracy - chanceAccuracy : null;
    const status = trainingSteps > 0
        ? ((brierSkill != null && brierSkill > 0) ? 'skilful' : 'base-rate')
        : 'not-trained';
    // Label lifecycle (round 26, R26-11): the time-barrier count and the
    // entry-to-close holding distribution, so the label policy is measurable.
    const heldCount = num(ga.heldBarsCount);
    const heldSum = num(ga.heldBarsSum);
    const heldMax = num(ga.heldBarsMax);
    return {
        trainingSteps,
        quarantinedRows: num(ga.quarantinedRows),
        droppedCandles: num(ga.droppedCandles),
        openTradeWriteErrors: num(ga.openTradeWriteErrors),
        resolved: { takeProfit, stopLoss, total: resolvedTotal },
        resolvedTimeBarrier: num(ga.resolvedTimeBarrier),
        heldBars: { count: heldCount, sum: heldSum, max: heldMax, mean: heldCount > 0 ? heldSum / heldCount : null },
        baseRate, brier, brierBaseline, brierSkill,
        accuracy, chanceAccuracy, accuracySkill,
        status,
        raw: {
            trainingSteps,
            quarantinedRows: num(ga.quarantinedRows),
            droppedCandles: num(ga.droppedCandles),
            openTradeWriteErrors: num(ga.openTradeWriteErrors),
            takeProfit, stopLoss,
            brierSum: num(ga.brierSum), brierCount,
            wins: num(ga.wins), scored,
            resolvedTimeBarrier: num(ga.resolvedTimeBarrier),
            heldBarsSum: heldSum, heldBarsCount: heldCount, heldBarsMax: heldMax,
        },
    };
};

// Cross-fold accumulator for a variant's model diagnostics (round 26, R26-2;
// renamed/re-scoped in round 27, R27-5). `trainingStepsList` retains each fold's
// training-step count so the report can print a real min/median/max distribution
// rather than a single pooled scalar.
export const emptyModelAccumulator = (minTrainingSteps = 1) => ({
    folds: 0, notTrainedFolds: 0, shallowHistoryFolds: 0, underTrainedFolds: 0, warmErrors: 0,
    minTrainingSteps: Number.isFinite(minTrainingSteps) ? minTrainingSteps : 1,
    trainingStepsList: [],
    heldBarsCap: null,
    sampleWeightsRaw: { count: 0, min: Infinity, max: -Infinity, sum: 0, rawSum: 0, essSum: 0, nSum: 0, horizonBars: null, measureHorizon: false },
    raw: {
        trainingSteps: 0, quarantinedRows: 0, droppedCandles: 0, openTradeWriteErrors: 0,
        takeProfit: 0, stopLoss: 0, brierSum: 0, brierCount: 0, wins: 0, scored: 0,
        resolvedTimeBarrier: 0, heldBarsSum: 0, heldBarsCount: 0, heldBarsMax: 0,
    },
});

export const mergeModelStats = (acc, s) => {
    if (!acc || !s) return acc;
    acc.folds += 1;
    acc.warmErrors += Number.isFinite(s.warmErrors) ? s.warmErrors : 0;
    // R27-5: `s.undertrained` is `testStart < warmup` — the OLD always-zero
    // certificate. It is now reported under its true name (`shallowHistoryFolds`),
    // and `underTrainedFolds` is a statistic that CAN fire: a fold whose model
    // trained, but on fewer than `minTrainingSteps` rows.
    if (s.undertrained) acc.shallowHistoryFolds += 1;
    const ts = Number.isFinite(s.trainingSteps) ? s.trainingSteps : null;
    if (ts == null) {
        acc.notTrainedFolds += 1;
    } else {
        acc.trainingStepsList.push(ts);
        if (!(ts > 0)) acc.notTrainedFolds += 1;
        else if (ts < acc.minTrainingSteps) acc.underTrainedFolds += 1;
    }
    if (Number.isFinite(s.heldBarsCap)) acc.heldBarsCap = s.heldBarsCap;
    const sw = s.sampleWeightsRaw;
    if (sw && Number.isFinite(sw.count) && sw.count > 0) {
        acc.sampleWeightsRaw.count += sw.count;
        acc.sampleWeightsRaw.sum += sw.sum;
        if (Number.isFinite(sw.rawSum)) acc.sampleWeightsRaw.rawSum += sw.rawSum;
        acc.sampleWeightsRaw.essSum += sw.essSum;
        acc.sampleWeightsRaw.nSum += sw.nSum;
        if (Number.isFinite(sw.min)) acc.sampleWeightsRaw.min = Math.min(acc.sampleWeightsRaw.min, sw.min);
        if (Number.isFinite(sw.max)) acc.sampleWeightsRaw.max = Math.max(acc.sampleWeightsRaw.max, sw.max);
        // R28 (BUGS.md #58): the assumed span horizon is a CONFIGURATION, so the
        // last-seen value is the run's; `measureHorizon` is sticky (any fold that
        // used the causal estimate marks the run as measured).
        if (Number.isFinite(sw.horizonBars)) acc.sampleWeightsRaw.horizonBars = sw.horizonBars;
        if (sw.measureHorizon) acc.sampleWeightsRaw.measureHorizon = true;
    }
    const raw = s.raw || {};
    for (const key of Object.keys(acc.raw)) {
        const v = raw[key];
        if (!Number.isFinite(v)) continue;
        // Every counter pools additively except the holding maximum.
        if (key === 'heldBarsMax') acc.raw[key] = Math.max(acc.raw[key], v);
        else acc.raw[key] += v;
    }
    return acc;
};

const median = (sorted) => {
    if (!sorted.length) return null;
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// The per-variant `model` block: the pooled diagnostics, or null when the variant
// never fit a model (a pure signal candidate) so an absent model cannot be read
// as a healthy one.
export const summarizeModelStats = (acc) => {
    if (!acc || acc.folds === 0) return null;
    const r = acc.raw;
    const d = labelDiagnostics({
        trainingSteps: r.trainingSteps,
        quarantinedRows: r.quarantinedRows,
        droppedCandles: r.droppedCandles,
        openTradeWriteErrors: r.openTradeWriteErrors,
        resolvedTakeProfit: r.takeProfit,
        resolvedStopLoss: r.stopLoss,
        brierSum: r.brierSum,
        brierCount: r.brierCount,
        wins: r.wins,
        total: r.scored,
        resolvedTimeBarrier: r.resolvedTimeBarrier,
        heldBarsSum: r.heldBarsSum,
        heldBarsCount: r.heldBarsCount,
        heldBarsMax: r.heldBarsMax,
    });
    const tsSorted = acc.trainingStepsList.slice().sort((a, b) => a - b);
    const sw = acc.sampleWeightsRaw;
    return {
        folds: acc.folds,
        trained: d.trainingSteps > 0,
        notTrainedFolds: acc.notTrainedFolds,
        // R27-5: `shallowHistoryFolds` is the (always-zero-at-default-split) count
        // of folds below the warm-up floor; `underTrainedFolds` is the count of
        // folds whose model trained on fewer than `minTrainingSteps` rows.
        shallowHistoryFolds: acc.shallowHistoryFolds,
        underTrainedFolds: acc.underTrainedFolds,
        minTrainingSteps: acc.minTrainingSteps,
        // The per-fold training-step distribution (min/median/max), so the floor
        // can be set from evidence. Named `trainingStepsDistribution` to avoid
        // colliding with the pooled `trainingSteps` scalar below.
        trainingStepsDistribution: tsSorted.length
            ? { min: tsSorted[0], median: median(tsSorted), max: tsSorted[tsSorted.length - 1] }
            : null,
        heldBarsCap: acc.heldBarsCap,
        sampleWeights: sw.count > 0
            ? {
                count: sw.count,
                min: sw.min,
                max: sw.max,
                mean: sw.sum / sw.count,
                // R28 (BUGS.md #54): the RAW (un-normalised) emitted stream's mean,
                // so the scale the weights applied to the learning rate is visible.
                meanUnnormalised: (Number.isFinite(sw.rawSum) && sw.rawSum > 0) ? sw.rawSum / sw.count : sw.sum / sw.count,
                ess: sw.essSum / sw.count,
                n: sw.nSum / sw.count,
                effectiveFraction: sw.nSum > 0 ? sw.essSum / sw.nSum : null,
                // R28 (BUGS.md #58): the span horizon the mechanism ASSUMED, and
                // whether it was the causal measured estimate or a fixed config.
                horizonBars: sw.horizonBars,
                measureHorizon: !!sw.measureHorizon,
            }
            : null,
        warmErrors: acc.warmErrors,
        ...d,
    };
};

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