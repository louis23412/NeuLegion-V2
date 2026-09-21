// Honest backtest evaluation — the layer that ties splits + labels +
// performance together and, crucially, does NOT bless a zero-skill strategy.
//
// The design rule is "no lookahead": a signal decided at bar t can only affect
// the return of bar t+1, so positions are the signals shifted by one bar. Costs
// are charged on position changes (turnover), never on the P&L itself.
//
// Pure: no I/O, no RNG. Exact reference vectors live in `analysis.test.js`.
//
// References: Lopez de Prado, AFML ch. 7-8 (purging, backtest statistics);
// Bailey & Lopez de Prado (deflated Sharpe) via `performance.js`.

import {
    sharpeRatio, skewness, kurtosis, probabilisticSharpeRatio,
    deflatedSharpeRatio, minimumTrackRecordLength, annualizeSharpe,
} from './performance.js';

// Position held during bar t is the signal decided at bar t-lag (no lookahead).
export function positionsFromSignals(signals, { lag = 1 } = {}) {
    const out = new Array(signals.length).fill(0);
    for (let t = lag; t < signals.length; t++) out[t] = signals[t - lag];
    return out;
}

// Turnover = total absolute position change, counting the initial entry from 0.
export function turnover(positions) {
    let sum = 0;
    let prev = 0;
    for (const p of positions) { sum += Math.abs(p - prev); prev = p; }
    return sum;
}

// Strategy returns with transaction costs.
//   strRet[t] = position[t] * returns[t] - |position[t] - position[t-1]| * costBps/1e4
// Returns { returns, gross, cost, turnover }.
export function strategyReturns({ returns, signals, positions = null, costBps = 0 }) {
    const pos = positions || positionsFromSignals(signals, { lag: 1 });
    const fee = costBps / 1e4;
    const gross = new Array(returns.length).fill(0);
    const net = new Array(returns.length).fill(0);
    const cost = new Array(returns.length).fill(0);
    let prev = 0;
    for (let t = 0; t < returns.length; t++) {
        gross[t] = pos[t] * returns[t];
        cost[t] = Math.abs(pos[t] - prev) * fee;
        net[t] = gross[t] - cost[t];
        prev = pos[t];
    }
    return { returns: net, gross, cost, turnover: turnover(pos) };
}

export function equityCurve(returns, { start = 1 } = {}) {
    const out = new Array(returns.length + 1);
    out[0] = start;
    for (let t = 0; t < returns.length; t++) out[t + 1] = out[t] * (1 + returns[t]);
    return out;
}

// Maximum peak-to-trough drawdown as a fraction of the running peak.
export function maxDrawdown(equityOrReturns, { fromReturns = null } = {}) {
    const eq = fromReturns ? equityCurve(equityOrReturns) : equityOrReturns;
    let peak = eq[0];
    let mdd = 0;
    for (const v of eq) {
        if (v > peak) peak = v;
        if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak);
    }
    return mdd;
}

// Fraction of in-market bars with a positive net return. Bars with no position
// are excluded (they are neither hits nor misses).
export function hitRate(strategyReturnSeries) {
    let n = 0; let hits = 0;
    for (const r of strategyReturnSeries) {
        if (r === 0) continue;
        n++;
        if (r > 0) hits++;
    }
    return n === 0 ? NaN : hits / n;
}

export function tradeCount(positions) {
    let count = 0;
    let prev = 0;
    for (const p of positions) { if (p !== prev) count++; prev = p; }
    return count;
}

// Full report: gross vs net Sharpe, drawdown, hit rate, PSR/DSR/MinTRL.
// `trials`/`trialsVariance` feed the deflated Sharpe (selection bias).
export function backtestMetrics({
    returns, signals, positions = null, costBps = 0,
    periodsPerYear = 252, trials = 1, trialsVariance = null,
    // Round 25: the design-effect-adjusted sample size. `psr`/`dsr` above treat
    // the `n` bars as independent draws. When a pooled multi-stream report knows
    // better (a cluster jackknife says the pooled Sharpe's variance is inflated
    // by `designEffect`, so the effective sample is n/designEffect), it passes
    // `effectiveBars` and gets `psrAdjusted`/`dsrAdjusted` computed on the
    // honest sample size. `null` (the default, and every single-stream report)
    // means "no correction was justified", which is not the same as "adjusted to
    // the same value".
    effectiveBars = null,
}) {
    const pos = positions || positionsFromSignals(signals, { lag: 1 });
    const bt = strategyReturns({ returns, signals, positions: pos, costBps });
    const net = bt.returns;
    const n = net.length;
    const netSharpe = sharpeRatio(net, { periodsPerYear });
    const grossSharpe = sharpeRatio(bt.gross, { periodsPerYear });
    const perPeriodNet = netSharpe / Math.sqrt(periodsPerYear);
    const skew = skewness(net);
    const kurt = kurtosis(net);
    const grossPnl = bt.gross.reduce((a, b) => a + b, 0);
    const nEff = Number.isFinite(effectiveBars) && effectiveBars >= 2 && effectiveBars < n
        ? Math.max(2, Math.round(effectiveBars))
        : null;
    // MinTRL is Infinity whenever the net Sharpe is at or below its benchmark (no
    // track record length suffices), and `JSON.stringify` turns Infinity into
    // `null` — which is indistinguishable from "not computed" once the report is
    // on disk. The status below makes the two cases readable in `report.json`.
    const mtrl = minimumTrackRecordLength({ sharpe: perPeriodNet, skew, kurtosis: kurt });
    const mtrlStatus = Number.isFinite(mtrl) ? 'finite' : (mtrl === Infinity ? 'beyond-horizon' : 'unavailable');
    // `null` when no design effect was measured (a single stream), OR when the
    // measured effect is <= 1 — streams whose returns are uncorrelated enough to
    // be diversifying have no *over*-confidence to deflate, and manufacturing
    // extra confidence from negative correlation is not what this is for.
    return {
        bars: n,
        netSharpe,
        grossSharpe,
        perPeriodNetSharpe: perPeriodNet,
        psr: probabilisticSharpeRatio({ sharpe: perPeriodNet, n, skew, kurtosis: kurt }),
        dsr: deflatedSharpeRatio({ sharpe: perPeriodNet, n, skew, kurtosis: kurt, trials, trialsVariance }),
        effectiveBars: nEff,
        psrAdjusted: nEff
            ? probabilisticSharpeRatio({ sharpe: perPeriodNet, n: nEff, skew, kurtosis: kurt })
            : null,
        dsrAdjusted: nEff
            ? deflatedSharpeRatio({ sharpe: perPeriodNet, n: nEff, skew, kurtosis: kurt, trials, trialsVariance })
            : null,
        minTrackRecordLength: mtrl,
        minTrackRecordLengthStatus: mtrlStatus,
        maxDrawdown: maxDrawdown(equityCurve(net)),
        hitRate: hitRate(net),
        turnover: bt.turnover,
        tradeCount: tradeCount(pos),
        totalCost: bt.cost.reduce((a, b) => a + b, 0),
        grossPnl,
        // The per-unit-turnover cost (in bps) at which the gross P&L is exactly
        // consumed by costs — `net P&L = grossPnl - (costBps/1e4)*turnover = 0`.
        // Assumption-free and turnover-normalised, so a low-turnover mechanism and
        // a high-turnover signal can be compared on the same axis (`null` when the
        // strategy never trades, where the number would be meaningless).
        breakEvenCostBps: bt.turnover > 0 ? (1e4 * grossPnl) / bt.turnover : null,
        finalEquity: equityCurve(net).at(-1),
        // Participation (round 25). `turnover`/`tradeCount` say how much was
        // traded, not how often the strategy was *in* the market — and the two
        // are different stories: `query-mod` on the attempt-3 power run had a
        // median fold Sharpe of exactly 0 with a pooled DSR of 0.9992, which is
        // the signature of a filter that abstains on most folds and bets big on a
        // few. `nonZeroFraction` (share of bars with a non-zero position) and
        // `meanAbsPosition` make that visible in the pooled report instead of
        // hiding it in a turnover number.
        nonZeroFraction: n > 0 ? pos.filter((p) => p !== 0).length / n : null,
        meanAbsPosition: n > 0 ? pos.reduce((a, p) => a + Math.abs(p), 0) / n : null,
    };
}

// Pool per-fold results into one report. Extracted so a multi-stream evaluation
// (e.g. one walk-forward per symbol) pools with EXACTLY the same arithmetic as a
// single stream — the round-23 cross-symbol evaluation must not invent a second
// pooling convention.
//
// The pooled return stream is scored with a synthetic all-long signal, which is
// correct for Sharpe/PSR/DSR/drawdown/hit-rate/final-equity (they read the return
// series) but makes turnover / tradeCount / totalCost / grossSharpe describe the
// overlay rather than the strategy. Those four are replaced with the per-fold
// strategy aggregates, so the pooled report is a real strategy summary.
export function poolFolds(perFold, pooled, pooledGross, { periodsPerYear = 252, trials = 1, effectiveBars = null } = {}) {
    let turnoverSum = 0;
    let tradeCountSum = 0;
    let costSum = 0;
    let nonZeroSum = 0;
    let meanAbsSum = 0;
    for (const f of perFold) {
        turnoverSum += f.metrics.turnover;
        tradeCountSum += f.metrics.tradeCount;
        costSum += f.metrics.totalCost;
        nonZeroSum += (f.metrics.nonZeroFraction || 0) * f.metrics.bars;
        meanAbsSum += (f.metrics.meanAbsPosition || 0) * f.metrics.bars;
    }
    const pooledBase = backtestMetrics({ returns: pooled, signals: pooled.map(() => 1), costBps: 0, periodsPerYear, trials, effectiveBars });
    // The pooled gross P&L is the sum of the per-fold strategy gross returns; the
    // pooled base report cannot supply it (it scores the pooled series with a
    // synthetic all-long signal), so both it and the break-even cost are restated
    // from the strategy aggregates — like turnover / tradeCount / totalCost.
    const grossPnlSum = Array.isArray(pooledGross)
        ? pooledGross.reduce((a, b) => a + b, 0)
        : perFold.reduce((a, f) => a + (f.metrics.grossPnl || 0), 0);
    const pooledMetrics = {
        ...pooledBase,
        turnover: turnoverSum,
        tradeCount: tradeCountSum,
        totalCost: costSum,
        grossPnl: grossPnlSum,
        breakEvenCostBps: turnoverSum > 0 ? (1e4 * grossPnlSum) / turnoverSum : null,
        grossSharpe: sharpeRatio(pooledGross, { periodsPerYear }),
        // Participation, aggregated over the folds from the per-fold strategy
        // statistics (the all-long overlay of the pooled series would report 1.0
        // / 1.0, which is the overlay's participation, not the strategy's).
        nonZeroFraction: pooled.length > 0 ? nonZeroSum / pooled.length : null,
        meanAbsPosition: pooled.length > 0 ? meanAbsSum / pooled.length : null,
    };
    const meanFoldSharpe = perFold.reduce((a, f) => a + f.metrics.netSharpe, 0) / perFold.length;
    return { pooledMetrics, meanFoldSharpe };
}

// Purged-CV backtest: apply the (fixed) signal series inside every fold's test
// slice and report pooled out-of-sample statistics. Because the signals are
// fixed here, purging protects the *metric* independence rather than preventing
// signal leakage — pass a `signalForFold(trainIdx, testIdx)` to fit per fold.
export function purgedCVBacktest({
    returns, signals = null, signalForFold = null, folds,
    costBps = 0, periodsPerYear = 252, trials = 1,
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
        const subReturns = test.map((i) => returns[i]);
        const subSignals = signalForFold
            ? signalForFold(fold.train, test)
            : test.map((i) => signals[i]);
        foldSignals.push(subSignals);
        foldInputs.push({ returns: subReturns, signals: subSignals });
        const bt = strategyReturns({ returns: subReturns, signals: subSignals, costBps });
        const metrics = backtestMetrics({ returns: subReturns, signals: subSignals, costBps, periodsPerYear, trials });
        perFold.push({ testStart: fold.testStart, testEnd: fold.testEnd, metrics });
        for (const r of bt.returns) pooled.push(r);
        for (const r of bt.gross) pooledGross.push(r);
        if (onFold) {
            onFold({
                t: 'fold', foldIndex: perFold.length - 1, foldTotal: folds.length,
                testStart: fold.testStart, testEnd: fold.testEnd,
                test: test.slice(), returns: subReturns, signals: subSignals,
                metrics, net: bt.returns, gross: bt.gross,
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

export { annualizeSharpe };
