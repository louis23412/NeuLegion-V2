// Volatility forecasting core (W4b, rounds 49-53) — split from
// `analysis/forecast.js` in round 71 (byte-exact move; the `forecast.js`
// re-export shim keeps every import path working). Realized vol, the
// EWMA/AR/ridge-AR fits, the model slot, the split/panel/ladder tournaments,
// QLIKE and the promotion decision. Self-contained: no imports.

// ---------------------------------------------------------------------------
// W4b (round 49): the winnable job — realized-volatility forecasting.
// ---------------------------------------------------------------------------
// Direction is not predictable at this horizon (G-A, F-06…F-09); volatility is
// the one documented predictability in returns, and F-16/L09 already showed a
// causal EWMA is the forecaster to use. These three pure helpers are the
// measurement the model must beat out of sample at matched exposure before it
// earns a place in the default path. Additive: no scored path reads them.
//
// `realizedVolatility(returns, window)`: causal rolling root-mean-square of
// returns — the realized-vol proxy. Returns an array of length
// max(0, n-window+1) (no null padding, so a caller can align it explicitly).
// `ewmaVolForecast(vols, {lambda})`: causal one-step-ahead EWMA (RiskMetrics
// 1996, lambda=0.94 daily): out[0] = vols[0], out[t] = lambda*out[t-1] +
// (1-lambda)*vols[t-1]. `volForecastSkill(actual, forecast, baseline)`: the
// MSE skill 1 - MSE(f)/MSE(b), NaN when either MSE is not positive-finite.
// Round-109 foundations split: the implementation lives in src/analysis/forecast/vol/
// (estimators.js + tournament.js, bodies byte-identical); this file carries the exact registered
// contract so every importer keeps working.
export { realizedVolatility, ewmaVolForecast, volForecastSkill, fitArVolForecast, predictArVolForecast, volForecastQlike, fitRidgeArVolForecast } from './vol/estimators.js';
export { tournamentVolForecast, tournamentVolForecastAcrossSplits, tournamentVolModel, tournamentVolPanel, tournamentVolModelAcrossSplits, decideVolPromotion, tournamentVolLadder } from './vol/tournament.js';
