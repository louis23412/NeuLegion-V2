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
//
// Round-103 foundations split: the implementation lives in src/analysis/backtest/
// (three parts, bodies byte-identical; the `annualizeSharpe` re-export sits with
// its import in metrics.js); this file carries the exact registered contract so
// every importer keeps working.
export { positionsFromSignals, turnover, strategyReturns, equityCurve, maxDrawdown, hitRate, tradeCount } from './backtest/primitives.js';
export { backtestMetrics, poolFolds, annualizeSharpe } from './backtest/metrics.js';
export { purgedCVBacktest, purgedCVBacktestAsync, annualizedReturn } from './backtest/folds.js';
