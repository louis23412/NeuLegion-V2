// White's Reality Check / SPA / subsampling inference — re-export shim (round-94 split).
// Part 1: ./reality_check/bootstrap.js (block-bootstrap RC/SPA family + shared guards).
// Part 2: ./reality_check/subsampling.js (variance-consistent subsampling family).
// The registered contract is unchanged; see test/node/analysis.test.js (registered analysis modules).
export {
    DEFAULT_RC_CONFIG, benchmarkSeries, relativePerformance,
    stationaryBlockIndices, politisWhiteBlockLength, autoBlockLength, bootstrapRelativeMeans,
    whiteRealityCheck, hansenSpa, consistentRecentring, hansenSpaConsistent, romanoWolfStepM,
} from './reality_check/bootstrap.js';
export {
    DEFAULT_SUB_CONFIG, neweyWestSE,
    subsamplingSpa, subsamplingStepM, subsamplingKfwer, subsamplingFdp,
} from './reality_check/subsampling.js';
