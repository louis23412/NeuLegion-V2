// Manifest of the HiveMind component split.
//
// `src/hivemind/hiveMind.js` keeps only the class shell (fields, constructor,
// the public API) and installs the ~100 remaining methods from component
// modules under `src/hivemind/<domain>/` onto `HiveMind.prototype` via
// `src/hivemind/internal/mixins.js`. This file is the single source of truth
// for "which component owns which method", so both the browser
// (`test/browser/entries/modules.test.js`) and node (`test/node/modules.test.js`)
// structural suites fail if a method is dropped, renamed, or double-installed.
//
// Keys are the bag labels used by the tests; values are the exact method names
// exported by that bag, in file order.

export const COMPONENTS = {
    activations: ['_silu', '_siluDerivative', '_sigmoid', '_softmax'],
    linalg: [
        '_fastVectorDot', '_fastVectorAdd', '_fastVectorScale',
        '_vectorDot', '_vectorNorm', '_vectorSub', '_cosineSimilarity',
        '_weightedMean', '_maxPairwiseKernel', '_projSimilarity',
    ],
    normalization: ['_rmsNorm', '_normalizeSemantic', '_applyRoPE'],
    sampling: [
        '_randomNormal', '_sampleDirichlet', '_generateProjectionMatrix',
        '_generateLshHyperplanesLow', '_dynamicInit',
    ],
    statistics: [
        '_computeVariance', '_computeEMA', '_computeDualEMA',
        '_computeGradientConformity', '_computeKernelRate', '_computeFractalDimension',
        '_computePercentile', '_computeNTKStability', '_computeDynamicPercentile',
        '_computeSparseThreshold', '_computeSpectralNorm', '_computeGradientNorm',
        '_detectSuddenDrop', '_isStagnating',
    ],
    loadState: ['_loadState'],
    saveState: ['_saveState'],
    dimensions: ['_scaleAndSetDimensions', '_setTransformerStructure', '_setGradientStructure'],
    lsh: [
        '_computeContentHash', '_computeProjNorms', '_invalidateProjCache',
        '_getLshBitMasks', '_computeLSHHashesLow', '_insertProtoToLSH',
        '_removeProtoFromLSH', '_updateProtoInLSH', '_getGlobalLSHCandidates',
        '_refreshLshHyperplanes',
    ],
    protos: [
        '_createNewProto', '_reinforceProto', '_finalizeSemanticProto',
        '_decayProtos', '_updateSemanticStats', '_getAvgProtoVariance',
        '_sortByUtilityDescInPlace', '_sortedByUtilityDesc', '_sortByScoreDescInPlace',
        '_computeProtoUtility', '_computeMemberAffinity',
    ],
    replay: ['_replayOldMemory', '_generativeReplay', '_poolMultiPrototype'],
    retrieval: ['_kernelSimilarity', '_retrieveTopRelevantProtos'],
    consolidation: ['_consolidateSemanticProtos', '_computeMemoryScoreFromProtos'],
    banks: ['_updateSemanticProtos', '_pruneMemory', '_updateMemoryBanks'],
    attention: [
        '_multiHeadAttention', '_contextAwareAttention',
        '_computeAttentionWeights', '_cacheAverageWeights',
    ],
    forward: ['_feedForwardBatch', '_processTransformer'],
    hiveState: ['_updateHiveState', '_hiveMemorySharing', '_computeWeightedSum', '_getSpecWeightMatrix'],
    scores: [
        '_computeSpecializationScores', '_updatePerformanceScores', '_updateAgreementScores',
        '_updateTrustScores', '_adjustPerformanceScores', '_updateEnsembleWeights',
        '_normalizeEnsembleWeights', '_updateAdaptiveLearningRates', '_updateMetrics',
    ],
    gradients: [
        '_scaleGradientMatrix', '_scaleGradientVector', '_scaleGradients',
        '_accumulateGradients', '_applyGradients', '_rollbackGradients',
    ],
    distillation: ['_distillKnowledge'],
    transfer: ['broadcastMemory', 'translateMemory'],
    diagnostics: ['diagnostics'],
};

// Methods that stay in the class body (the public API plus the constructor).
export const CLASS_API = ['predict', 'train', 'dumpState'];

// Every installed method, across every component.
export const INSTALLED_METHODS = Object.values(COMPONENTS).flat();

export const TOTAL_INSTALLED = INSTALLED_METHODS.length;

// ---------------------------------------------------------------------------
// HiveMindController split.
//
// `src/hivemind/hiveMindController.js` keeps only its fields, constructor and
// the public `getSignal()`; the per-controller helper methods live under
// `src/hivemind/controller/*` and are installed onto
// `HiveMindController.prototype` by the same `installMethods` helper. Kept in a
// separate map because the two classes are assembled independently.
// ---------------------------------------------------------------------------

export const CONTROLLER_COMPONENTS = {
    controllerDatabase: ['_initDatabase'],
    controllerAccuracy: ['_loadGlobalAccuracy', '_saveGlobalAccuracy'],
    controllerCandle: ['_getRecentCandles'],
    controllerFeature: [
        '_robustNormalize', '_computeProtoQuality', '_interleave',
        '_extractFeatures', '_chooseDimension',
    ],
    controllerTrade: ['_updateOpenTrades', '_processClosedTrades', '_sampleWeightsForBatch'],
};

// The controller class body keeps the constructor and the public getSignal().
export const CONTROLLER_CLASS_API = ['getSignal'];

export const CONTROLLER_INSTALLED_METHODS = Object.values(CONTROLLER_COMPONENTS).flat();

export const CONTROLLER_TOTAL_INSTALLED = CONTROLLER_INSTALLED_METHODS.length;
