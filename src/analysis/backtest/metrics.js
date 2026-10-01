// src/analysis/backtest/metrics.js (round-103 split of src/analysis/backtest.js).
// Full-report metrics + fold pooling.
import {
    sharpeRatio, skewness, kurtosis, probabilisticSharpeRatio,
    deflatedSharpeRatio, minimumTrackRecordLength, annualizeSharpe,
} from '../performance.js';
import { positionsFromSignals, strategyReturns, equityCurve, maxDrawdown, hitRate, tradeCount } from './primitives.js';

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
    //
    // NOTE (PLAN-round30 §5): this is NOT a monotone shrink of `dsr` toward 0.5.
    // The WHOLE deflated formula is re-run on `nEff`, so both the `sqrt(n)`
    // scaling and the `defaultTrialVariance` deflation hurdle move together. For a
    // positive-Sharpe, sub-hurdle arm `dsrAdjusted` can sit BELOW `dsr` (more
    // conservative); for a negative-Sharpe arm it moves toward 0.5 (pinned by
    // `analysis.test.js` §AD).
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
        hitRate: hitRate(net, pos),
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
export { annualizeSharpe };
