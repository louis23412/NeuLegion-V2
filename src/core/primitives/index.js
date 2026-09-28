// The primitives barrel. Like the contracts barrel, it imports only its own
// directory (files in `primitives/` may import `contracts/` and each other).

export { canonical, fnv1a, fingerprint } from './fingerprint.js';
export { viewIdentity, viewFingerprint, sameView, assertOneView } from './views.js';
export {
    MIN_TRAIN_PERIODS,
    clipWeights,
    saturateWeights,
    bandWeights,
    cleanBook,
    sumAbs,
    sumRow,
    maxAbs,
    normalizeL1,
    isValidRow,
    turnoverSeries,
} from './weights.js';
export {
    rowMean,
    rowStdPopulation,
    sharpeOf,
    meanOf,
    ewmaUpdate,
    blendRows,
    dlogPositive,
    firstCommonIndex,
    rowRankWeights,
    rowLevelWeights,
    crossSectionalTarget,
    applyWeightPolicy,
    fin,
} from './series.js';
export { buildFundingBook, buildCrossSectionalBook, dlogMatrix, blendBooks } from './books.js';
