import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import { isValidNumber, isFiniteNumber } from './utils.js';
import { installMethods } from './internal/mixins.js';
import { activationMethods } from './kernels/activations.js';
import { linalgMethods } from './kernels/linalg.js';
import { normalizationMethods } from './kernels/normalization.js';
import { samplingMethods } from './kernels/sampling.js';
import { statisticsMethods } from './kernels/statistics.js';
import { loadStateMethods } from './persistence/load.js';
import { saveStateMethods } from './persistence/save.js';
import { dimensionMethods } from './persistence/dimensions.js';
import { lshMethods } from './memory/lsh.js';
import { protoMethods } from './memory/protos.js';
import { replayMethods } from './memory/replay.js';
import { retrievalMethods } from './memory/retrieval.js';
import { consolidationMethods } from './memory/consolidation.js';
import { bankMethods } from './memory/banks.js';
import { attentionMethods } from './transformer/attention.js';
import { forwardMethods } from './transformer/forward.js';
import { hiveStateMethods } from './ensemble/hiveState.js';
import { scoreMethods } from './ensemble/scores.js';
import { gradientMethods } from './training/gradients.js';
import { distillationMethods } from './training/distillation.js';
import { transferMethods } from './knowledge/transfer.js';
import { diagnosticsMethods } from './internal/diagnostics.js';

class HiveMind {
    _directoryPath; _fileName; 
    _ensembleSize; _inputSize;
    _numLayers; _numHeads; _headDim; _hiddenSize; _feedForwardSize; 
    _contextWindow; _adaptiveWindow; _semanticMaxProtos;
    _maxTrustHistory; _maxPerformanceHistory;
    _learningRate; _learningRateDecay;
    _swarmIntelligenceFactor; _gradientResetFrequency;
    _adaptiveLearningRate; _ensembleWeights; _agreementScores;
    _performanceScores; _historicalPerformance; _trustScoresHistory;
    _specializationScores; _specializationWeights; _specWeightCache = [];
    _specWeightScratch = null;
    _specWExpandScratch = null;
    _specExpandCache = [];
    _accScratch = null;
    _accFfnScratch = null;
    _accMemberScratch = null;
    _attnWeightScoreScratch = null;
    _attnWeightProbScratch = null;
    _attentionWeightMatrix; _attentionBias;
    _transformers; _gradientAccumulation;
    _attentionMemory; _adaptiveContext; _semanticProtos;
    _semanticLR; _effectiveSemanticMax;
    _longTermMaxProtos; _shortTermMaxProtos; _rawMaxProtos;
    _lowDim; _numProjections; _projectionMatrices;
    _kernelGamma; _faithfulReplayEvery; _generativeReplayEvery;
    _maxRetrievedProtos; _numRetrievalCandidates;
    _maxEpisodicConsider; _replaySamples;
    _coreMaxProtos; _coreEpisodicMaxEntries; _coreEpisodic;
    _lshNumTables; _lshHashBits;
    _numLshSets; _lshHyperplanes; _semanticLSHBuckets;
    _priorityMax; _priorityIndices;
    _protoCapacityFactor; _baseProtoCapacity; _memoryFactor; _maxVariancePerDim;
    _tempOverloadFactor; _mergeTrimFactor;
    _projCache; _cachedAvgVariance; _cachedUtilityScores;
    _protoIdCounter; _hiveId;
    _protoAccessDecay; _protoSizeDecay; _protoImpDecay;
    _baseAccessInc; _baseImpInc;
    _replaySizeScale; _mergeAccessScale; _coreBoostMultiplier;
    _trainingStepCount;
    _ropeFreqs = null; _ropeCos = null; _ropeSin = null;
    _lshBitMasks = null;
    _lshKeyIsNumber = false;
    // Surprise-gated memory writes (Titans, arXiv 2501.00663). Off by default:
    // the semantic write path then multiplies by exactly 1.0 (see
    // memory/surprise.js), so the golden fingerprints are unchanged. Enable by
    // setting `_surpriseGateEnabled = true` and optionally `_surpriseConfig`.
    _surpriseGateEnabled = false;
    _surpriseConfig = null;
    // Homeostatic plasticity of per-member learning rates (Turrigiano synaptic
    // scaling; arXiv 2609.13771). Off by default: with it disabled the adaptive
    // rate path is bit-identical, so the golden fingerprints are unchanged.
    // Enable by setting `_homeostasisEnabled = true` and optionally
    // `_homeostasisConfig` (see ensemble/homeostasis.js).
    _homeostasisEnabled = false;
    _homeostasisConfig = null;
    _activityEma = [];
    // Margin-ordered multi-probe LSH (Lv et al., VLDB 2007). Off by default: the
    // candidate probe loop then flips the first four hash bits exactly as before,
    // so the golden fingerprints are unchanged. Enable by setting
    // `_multiProbeConfig` (see memory/multiprobe.js) — the probe order then
    // follows the query's hyperplane margins, which `multiprobe.test.js` measures
    // at 0.033 -> 0.30 self-recall on a real wide-hash index.
    _multiProbeConfig = null;
    // Data-aware (PCA-aligned) LSH hyperplanes (BinaryPC, arXiv 2608.04405). Off
    // by default: the index is then built from data-independent random
    // hyperplanes exactly as before, so the golden fingerprints are unchanged.
    // Enable by setting `_pcaHashConfig` and calling `_refreshLshHyperplanes()`
    // (see memory/lsh.js + memory/binarypc.js). `_pcaHashConfig.rankPolicy`
    // ('above-mean' | 'noise') lets the aligned rank come from the spectrum
    // instead of the fixed dim/4 default (see memory/bitweight.js).
    // `_lshAlignedRank` records the rank each set actually used (per set) after
    // the last refresh — diagnostic only, null until a refresh runs.
    _pcaHashConfig = null;
    _lshAlignedRank = null;
    // Dynamic query modification (Claydon, Connor & Dearle, arXiv 2605.23807).
    // Off by default: the candidate probe pass then runs exactly as before, so
    // the golden fingerprints are unchanged. Enable by setting
    // `_queryModConfig` (see memory/querymod.js) — each set re-hashes the
    // l2-normalised centroid of the candidates it found and probes its buckets,
    // which recovers neighbourhoods a raw query's sparse word would miss.
    _queryModConfig = null;

    constructor (dp, es, is, id, forceMin = false) {
        this._directoryPath = dp;
        this._hiveId = id;
        this._fileName = `hivemind_state-ID=${this._hiveId}-es=${es}-is=${is}.db`;

        const loadStatus = this._loadState(es, is, forceMin);

        if (!loadStatus.status) {
            // Throw (never process.exit): worker.js catches this, posts an error
            // and batch.js isolates the slot, so one corrupt state file cannot
            // kill the run (ROADMAP P0-1).
            throw new Error(`HiveMind load state failed for "${id}": ${loadStatus.error}`);
        }
    }

    predict (inputs) {
        if ( !Array.isArray(inputs) || inputs.length !== this._inputSize || !inputs.every(isValidNumber) ) { return 0 }

        const predictionResult = this._updateHiveState(inputs, null, false, false, false, true);
        return predictionResult.probability;
    }

    train (inputs, target, sampleWeight = 1) {
        if ( !Array.isArray(inputs) || inputs.length !== this._inputSize || !inputs.every(isValidNumber) || !isValidNumber(target) ) { return }

        // Optional per-sample loss weight (see training/sample_weights.js). The
        // default 1 makes the scaling a bit-exact no-op, so the golden
        // fingerprints are unchanged when no weight is supplied.
        const weight = Number.isFinite(sampleWeight) ? sampleWeight : 1;

        this._trainingStepCount++;

        const trainingResults = this._updateHiveState(inputs, target, true, true, true, true);

        this._accumulateGradients(
            inputs, trainingResults.outputs, target, trainingResults.probability, 
            trainingResults.layerOutputs, trainingResults.activations, trainingResults.attentionIntermediates,
            weight
        );

        if (this._trainingStepCount % this._gradientResetFrequency === 0) {
            const clonedGrads = this._applyGradients(true, true, this._gradientResetFrequency);

            this._gradientAccumulation = structuredClone(clonedGrads);

            const freshResults = this._updateHiveState(inputs, target , true, false, true, true);

            this._distillKnowledge(
                freshResults.outputs, freshResults.attentionIntermediates, 
                freshResults.activations, freshResults.layerOutputs
            );

            this._rollbackGradients(clonedGrads);

            this._applyGradients(false, false, 1);

            this._updateHiveState(inputs, target, false, false, true, false);

            this._hiveMemorySharing();

            this._gradientAccumulation = this._setGradientStructure();
        }

        return this._trainingStepCount
    }

    dumpState () {
        return this._saveState();
    }
}

// The ~100 methods that used to live in this class are split across the
// component modules above (see src/README.md). Each exports a bag of methods
// which is installed onto the prototype here, in a single place, so the class
// body stays a readable shell: configuration/scaling, the transformer
// structures, and the public API (predict / train / dumpState).
for (const methods of [
    activationMethods,
    linalgMethods,
    normalizationMethods,
    samplingMethods,
    statisticsMethods,
    loadStateMethods,
    saveStateMethods,
    dimensionMethods,
    lshMethods,
    protoMethods,
    replayMethods,
    retrievalMethods,
    consolidationMethods,
    bankMethods,
    attentionMethods,
    forwardMethods,
    hiveStateMethods,
    scoreMethods,
    gradientMethods,
    distillationMethods,
    transferMethods,
    diagnosticsMethods
]) {
    installMethods(HiveMind, methods);
}

export default HiveMind;
