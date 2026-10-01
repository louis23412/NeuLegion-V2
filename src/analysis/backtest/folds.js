// src/analysis/backtest/folds.js (round-103 split of src/analysis/backtest.js).
// Purged-CV scoring: the serial path, the concurrent twin, and annualization.
import { scheduleUnits, normaliseConcurrency } from '../parallel.js';
import { strategyReturns, equityCurve } from './primitives.js';
import { backtestMetrics, poolFolds } from './metrics.js';

// Purged-CV backtest: apply the (fixed) signal series inside every fold's test
// The per-fold scoring arithmetic, shared by the serial and the concurrent paths
// (round 26, R26-4) so the two cannot drift: given a fold's already-decided
// positions and its optional raw confidence, it produces exactly the objects the
// old inline loop produced. Pure — no I/O, no RNG.
function scoreFold({ returns, fold, signals, confidence = null, costBps, periodsPerYear, trials }) {
    const test = fold.test;
    const subReturns = test.map((i) => returns[i]);
    const bt = strategyReturns({ returns: subReturns, signals, costBps });
    const metrics = backtestMetrics({ returns: subReturns, signals, costBps, periodsPerYear, trials });
    return {
        test,
        subReturns,
        subSignals: signals,
        subConfidence: confidence,
        bt,
        metrics,
        perFoldEntry: { testStart: fold.testStart, testEnd: fold.testEnd, metrics },
    };
}

// slice and report pooled out-of-sample statistics. Because the signals are
// fixed here, purging protects the *metric* independence rather than preventing
// signal leakage — pass a `signalForFold(trainIdx, testIdx)` to fit per fold.
export function purgedCVBacktest({
    returns, signals = null, signalForFold = null, folds,
    costBps = 0, periodsPerYear = 252, trials = 1,
    // Optional: the raw pre-policy confidence per test bar (round 26, R26-3), so a
    // report can be restated at another confidence->position policy without the
    // model. Purely additive — it is journaled beside the positions, never used in
    // any arithmetic.
    confidenceForFold = null,
    // Optional per-fold reporting hook (round 24). It is called AFTER the fold's
    // metrics are computed and is handed copies of the exact inputs/outputs of
    // that fold, so a caller can stream a self-contained fold journal. It has no
    // arithmetic effect: `perFold`, the pooled arrays and every returned metric are
    // byte-identical whether or not it is supplied (pinned by the ledger).
    onFold = null,
}) {
    if (!Array.isArray(folds) || !folds.length) {
        throw new Error('purgedCVBacktest: folds required (use purgedKFoldSplit)');
    }
    const perFold = [];
    const pooled = [];
    const pooledGross = [];
    // The per-fold signal series, returned so the audit can REUSE the scored pass as
    // its base pass instead of re-fitting an identical model (`auditReuseBase`). The
    // base pass is byte-identical to the scored pass on a deterministic factory
    // (measured 240/240 on the real driver), so this is a pure cost saving.
    const foldSignals = [];
    // The per-fold (returns, signals) inputs, retained by reference (no copies) so
    // a report can be *restated* at another transaction-cost level without the
    // model: `walkforward#restateReportAtCost` scores these with the same
    // `backtestMetrics` arithmetic the scored pass used (round 25's cost ladder).
    const foldInputs = [];
    for (const fold of folds) {
        const test = fold.test;
        const subSignals = signalForFold
            ? signalForFold(fold.train, test)
            : test.map((i) => signals[i]);
        // The raw pre-policy confidence for the same fold, when the caller supplies
        // it (round 26, R26-3). Journaled only — no metric reads it.
        const subConfidence = confidenceForFold ? confidenceForFold(fold.train, test) : null;
        const s = scoreFold({ returns, fold, signals: subSignals, confidence: subConfidence, costBps, periodsPerYear, trials });
        foldSignals.push(s.subSignals);
        foldInputs.push({ returns: s.subReturns, signals: s.subSignals, confidence: s.subConfidence });
        perFold.push(s.perFoldEntry);
        for (const r of s.bt.returns) pooled.push(r);
        for (const r of s.bt.gross) pooledGross.push(r);
        if (onFold) {
            onFold({
                t: 'fold', foldIndex: perFold.length - 1, foldTotal: folds.length,
                testStart: fold.testStart, testEnd: fold.testEnd,
                test: test.slice(), returns: s.subReturns, signals: s.subSignals,
                confidence: s.subConfidence,
                metrics: s.metrics, net: s.bt.returns, gross: s.bt.gross,
            });
        }
    }
    const { pooledMetrics, meanFoldSharpe } = poolFolds(perFold, pooled, pooledGross, { periodsPerYear, trials });
    return {
        folds: perFold,
        foldSignals,
        foldInputs,
        pooledMetrics,
        meanFoldSharpe,
        pooledBars: pooled.length,
        pooledReturns: pooled,
        pooledGross,
    };
}

// The concurrent twin of `purgedCVBacktest` (round 26, R26-4). It computes each
// fold's positions with `foldExecutor` (which may dispatch to a worker) at bounded
// concurrency, then assembles the folds **in fold order** with the same
// `scoreFold` arithmetic and the same `poolFolds` merge as the serial path — so
// the returned object is byte-identical to `purgedCVBacktest` whenever the
// per-fold decisions are (the acceptance test pins exactly that).
//
// `foldExecutor(ctx)` receives `{ fold, index, train, test, testStart, testEnd }`
// and resolves `{ signals, confidence }` (or a bare signals array).
export async function purgedCVBacktestAsync({
    returns, folds,
    foldExecutor,
    costBps = 0, periodsPerYear = 252, trials = 1,
    onFold = null, concurrency = 1,
}) {
    if (!Array.isArray(folds) || !folds.length) {
        throw new Error('purgedCVBacktestAsync: folds required (use purgedKFoldSplit)');
    }
    if (typeof foldExecutor !== 'function') {
        throw new Error('purgedCVBacktestAsync: foldExecutor(ctx) is required');
    }
    const width = normaliseConcurrency(concurrency, { max: folds.length });
    const units = folds.map((fold, index) => ({ fold, index }));
    const decided = await scheduleUnits(units, {
        concurrency: width,
        exec: async ({ fold, index }) => {
            const r = await foldExecutor({ fold, index, train: fold.train, test: fold.test, testStart: fold.testStart, testEnd: fold.testEnd });
            const signals = Array.isArray(r) ? r : (r && r.signals);
            if (!Array.isArray(signals)) {
                throw new Error(`purgedCVBacktestAsync: fold ${index} executor returned no signals array`);
            }
            const confidence = r && Array.isArray(r.confidence) ? r.confidence : null;
            return { signals, confidence };
        },
    });

    const perFold = [];
    const pooled = [];
    const pooledGross = [];
    const foldSignals = [];
    const foldInputs = [];
    for (let i = 0; i < folds.length; i++) {
        const fold = folds[i];
        const test = fold.test;
        const { signals: subSignals, confidence: subConfidence } = decided[i];
        const s = scoreFold({ returns, fold, signals: subSignals, confidence: subConfidence, costBps, periodsPerYear, trials });
        foldSignals.push(s.subSignals);
        foldInputs.push({ returns: s.subReturns, signals: s.subSignals, confidence: s.subConfidence });
        perFold.push(s.perFoldEntry);
        for (const r of s.bt.returns) pooled.push(r);
        for (const r of s.bt.gross) pooledGross.push(r);
        if (onFold) {
            onFold({
                t: 'fold', foldIndex: perFold.length - 1, foldTotal: folds.length,
                testStart: fold.testStart, testEnd: fold.testEnd,
                test: test.slice(), returns: s.subReturns, signals: s.subSignals,
                confidence: s.subConfidence,
                metrics: s.metrics, net: s.bt.returns, gross: s.bt.gross,
            });
        }
    }
    const { pooledMetrics, meanFoldSharpe } = poolFolds(perFold, pooled, pooledGross, { periodsPerYear, trials });
    return {
        folds: perFold,
        foldSignals,
        foldInputs,
        pooledMetrics,
        meanFoldSharpe,
        pooledBars: pooled.length,
        pooledReturns: pooled,
        pooledGross,
    };
}

export function annualizedReturn(returns, periodsPerYear = 252) {
    const eq = equityCurve(returns).at(-1);
    return Math.pow(eq, periodsPerYear / returns.length) - 1;
}

