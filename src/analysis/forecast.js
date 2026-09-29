// Forecast comparison — re-export shim (round 71).
//
// `analysis/forecast.js` was split byte-exact into `analysis/forecast/`:
// `scoring.js` (Brier/Murphy/DM/MCS, the family comparison, the renderer),
// `vol.js` (realized vol, EWMA/AR/ridge-AR, the model slot, tournaments),
// `range.js` (range estimators, HAR, the expanding grid),
// `combine.js` (frozen-weight combination), `sizing.js` (vol-target scaling),
// `online.js` (rolling combination). This file re-exports the exact contract
// the lock registry pins, so every existing import path keeps working; new
// code should import the part directly.
export {
    forecastPairs, brierBinIndex, brierScore, logScore, brierDecomposition,
    brierLosses, bootstrapMeans, dieboldMariano, modelConfidenceSet,
    forecastComparison, formatForecast,
} from './forecast/scoring.js';
export {
    realizedVolatility, ewmaVolForecast, volForecastSkill,
    fitArVolForecast, predictArVolForecast, tournamentVolForecast,
    tournamentVolForecastAcrossSplits, tournamentVolModel, tournamentVolPanel,
    volForecastQlike, tournamentVolModelAcrossSplits, decideVolPromotion,
    fitRidgeArVolForecast, tournamentVolLadder,
} from './forecast/vol.js';
export {
    rangeBarVariance, rangeRealizedVolatility, yangZhangVariance,
    yangZhangRealizedVolatility, fitHarVolForecast, predictHarVolForecast,
    tournamentHarVolForecast, tournamentHarVolForecastAcrossSplits,
    tournamentHarVolPanel, expandingVolForecasts,
} from './forecast/range.js';
export {
    fitCombineWeights, inverseMseWeights, fitLassoCombineWeights, predictCombine,
    tournamentCombineVolForecast, tournamentCombineVolForecastAcrossSplits,
    tournamentCombineVolPanel,
} from './forecast/combine.js';
export { applyVolTargetScaling } from './forecast/sizing.js';
export {
    gibbsCombineWeights, rollingCombineWeights,
    tournamentRollingCombineVolForecast, tournamentRollingCombineVolForecastAcrossSplits,
    tournamentRollingCombineVolPanel,
} from './forecast/online.js';
