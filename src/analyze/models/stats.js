// src/analyze/models/stats.js (round-98 split of src/analyze/models.js).
// Model diagnostics accumulator + summary; labelDiagnostics exported for inter-part use only.




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
export const labelDiagnostics = (ga = {}) => {
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
