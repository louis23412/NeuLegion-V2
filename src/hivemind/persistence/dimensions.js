// HiveMind component: dimensions
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
export const dimensionMethods = {
    _scaleAndSetDimensions (es, is, forceMin) {
        this._ensembleSize = es;
        this._inputSize = is;

        const logEs = Math.log10(this._ensembleSize);
        const normalized = Math.min(1.0, logEs / 3.0);
        const sqrtEs = Math.sqrt(this._ensembleSize);
        const log2SqrtEs = Math.log2(sqrtEs);

        const numLayersRaw = 6.0 - 4.0 * normalized;
        this._numLayers = forceMin ? 2 : Math.max(2, Math.round(numLayersRaw));

        const numHeadsRaw = 8.0 - 6.0 * normalized;
        this._numHeads = forceMin ? 2 : Math.max(2, Math.round(numHeadsRaw));

        const hsExponent = Math.max(2, Math.min(4, 4 - log2SqrtEs));
        const hs = Math.pow(2, Math.floor(hsExponent));
        this._headDim = forceMin ? 4 : hs * Math.ceil(this._numHeads / 4);
        this._hiddenSize = forceMin ? 8 : this._numHeads * this._headDim;

        const ffnMultiplier = 8.0 - 4.0 * normalized;
        this._feedForwardSize = forceMin ? 32 : Math.round(this._hiddenSize * ffnMultiplier);

        this._protoCapacityFactor = forceMin ? 0.5 : 1 - 0.5 * normalized;
        this._memoryFactor = forceMin ? 2.5 : 1 + 1.5 * normalized;

        this._protoAccessDecay = forceMin ? 0.996 : 0.996;
        this._protoSizeDecay = forceMin ? 0.999 : 0.999;
        this._protoImpDecay = forceMin ? 0.995 : 0.995;
        this._baseAccessInc = forceMin ? 1.0 : 1.0;
        this._baseImpInc = forceMin ? 0.5 : 0.5;
        this._replaySizeScale = forceMin ? 0.1 : 0.1;
        this._mergeAccessScale = forceMin ? 0.7 : 0.7;
        this._coreBoostMultiplier = forceMin ? 1.2 : 1.2;

        const rawBase = Math.round(this._hiddenSize * 0.188 * this._protoCapacityFactor);
        const minBase = Math.max(4, Math.round(this._hiddenSize / 32));
        this._baseProtoCapacity = forceMin ? 4 : Math.max(minBase, rawBase);

        this._maxVariancePerDim = forceMin ? 20.9 : Number((8 + 25 * this._protoCapacityFactor + 0.05 * this._hiddenSize).toFixed(4));

        this._semanticLR = forceMin ? 0.04 : Number((0.02 + 0.04 * this._protoCapacityFactor).toFixed(4));

        const longTermMultiplier = 0.4 + 0.6 * this._protoCapacityFactor;
        const shortTermMultiplier = 0.8 + 0.7 * this._protoCapacityFactor;
        const rawMultiplier = 0.6 + 0.8 * this._protoCapacityFactor;
        const coreMultiplier = 1.0 + 1.5 * this._protoCapacityFactor;
        const semanticMultiplier = 2.0 + 4.0 * this._protoCapacityFactor;
        const coreEpisodicMultiplier = 0.8 + 1.2 * this._protoCapacityFactor;
        const retrievalMultiplier = semanticMultiplier;
        const candidatesMultiplier = 2 * semanticMultiplier;

        this._longTermMaxProtos = forceMin ? 3 : Math.round(this._baseProtoCapacity * longTermMultiplier);
        this._shortTermMaxProtos = forceMin ? 5 : Math.round(this._baseProtoCapacity * shortTermMultiplier);
        this._rawMaxProtos = forceMin ? 4 : Math.round(this._baseProtoCapacity * rawMultiplier);
        this._semanticMaxProtos = forceMin ? 75 : Math.round(this._baseProtoCapacity * semanticMultiplier);
        this._effectiveSemanticMax = forceMin ? 100 : Math.round(this._semanticMaxProtos * (1.1 + 0.15 * this._protoCapacityFactor));

        this._coreMaxProtos = forceMin ? 7 : Math.round(this._baseProtoCapacity * coreMultiplier);
        this._coreEpisodicMaxEntries = forceMin ? 6 : Math.round(this._baseProtoCapacity * coreEpisodicMultiplier);

        this._contextWindow = forceMin ? 50 : Math.round(this._hiddenSize * 2.5 * this._memoryFactor);
        this._adaptiveWindow = forceMin ? 13 : Math.max(1, Math.round(this._contextWindow * 0.25));
        
        this._maxTrustHistory = forceMin ? 100 : Math.round(this._contextWindow * 2);
        this._maxPerformanceHistory = forceMin ? 200 : Math.round(this._contextWindow * 4);

        const targetProportion = 0.35 + 0.3 * this._protoCapacityFactor;
        const minLowDim = Math.max(4, Math.round(this._hiddenSize * 0.18));
        const maxLowDim = Math.round(this._hiddenSize * 0.78);
        const candidate = Math.round(this._hiddenSize * targetProportion);
        this._lowDim = forceMin ? 4 : Math.max(minLowDim, Math.min(maxLowDim, candidate));

        const numProjectionsRaw = 16.0 - 10.0 * normalized;
        this._numProjections = forceMin ? 6 : Math.max(6, Math.round(numProjectionsRaw));

        const baseLrUnscaled = 0.12 / Math.max(this._inputSize, 1);
        const sizeScale = Math.pow(this._hiddenSize, -0.18);
        this._learningRate = Number(Math.min(0.0025, baseLrUnscaled * sizeScale).toPrecision(6));
        this._learningRateDecay = Number((this._learningRate / 10).toPrecision(6));

        this._swarmIntelligenceFactor = forceMin ? 0.95 : Number((0.05 + 0.90 * normalized).toFixed(6));

        const baseFreq = 10 + Math.ceil(this._ensembleSize / 8);
        this._gradientResetFrequency = forceMin ? 30 : baseFreq + Math.round(50 * this._swarmIntelligenceFactor);

        this._maxRetrievedProtos = forceMin ? 16 : Math.round(this._baseProtoCapacity * retrievalMultiplier);
        this._numRetrievalCandidates = forceMin ? 32 : Math.round(this._baseProtoCapacity * candidatesMultiplier);

        this._faithfulReplayEvery = forceMin ? 5 : Math.round(3 + 15 * this._protoCapacityFactor);
        this._generativeReplayEvery = forceMin ? 15 : Math.round(13 + 28 * this._protoCapacityFactor);

        this._maxEpisodicConsider = forceMin ? 45 : Math.round(this._contextWindow * (0.4 + 0.2 * this._memoryFactor));
        this._replaySamples = forceMin ? 3 : Math.round(this._baseProtoCapacity * (0.5 + 0.5 * this._protoCapacityFactor));

        this._priorityMax = forceMin ? 16 : this._maxRetrievedProtos;

        this._numLshSets = forceMin ? 2 : Math.max(1, Math.floor(this._numProjections / 3));

        const dimScale = Math.max(1, Math.log2(this._lowDim / 4));
        const capacityScale = Math.max(0.5, this._protoCapacityFactor);
        const dimFactor = Math.max(1, Math.log2(this._lowDim / 8));
        const rawTables = Math.round(this._hiddenSize * (0.04 + 0.12 * this._protoCapacityFactor) * dimScale);
        const rawBits = Math.round(this._hiddenSize * (0.06 + 0.18 * this._protoCapacityFactor) * dimScale);
        const maxTablesCap = Math.round(this._lowDim * 6 * capacityScale);
        const maxBitsCap = Math.round(this._lowDim * 3 * capacityScale);

        this._lshNumTables = forceMin ? 2 : Math.max(Math.round(4 * capacityScale * dimFactor), Math.min(maxTablesCap, rawTables));
        this._lshHashBits = forceMin ? 6 : Math.max(Math.round(12 * capacityScale * dimFactor), Math.min(maxBitsCap, rawBits));

        this._tempOverloadFactor = forceMin ? 2.5 : 2.0 + 1.0 * (1 - this._protoCapacityFactor);
        this._mergeTrimFactor = forceMin ? 1.75 : 1.5 + 0.5 * (1 - this._protoCapacityFactor);

        this._kernelGamma = forceMin ? 32.0 : Number((16 + 32 * this._protoCapacityFactor).toFixed(1));

        this._protoIdCounter = 0n;
        this._trainingStepCount = 0;

        this._projCache = new WeakMap();
        this._cachedAvgVariance = Array(this._ensembleSize).fill(0);
        this._cachedUtilityScores = Array(this._ensembleSize).fill().map(() => new Float32Array(0));

        this._projectionMatrices = Array.from({length: this._numProjections}, () => this._generateProjectionMatrix());

        this._lshHyperplanes = Array.from({length: this._numLshSets}, () => this._generateLshHyperplanesLow());

        this._semanticLSHBuckets = Array(this._ensembleSize).fill().map(() => 
            Array(this._numLshSets).fill().map(() => 
                Array(this._lshNumTables).fill().map(() => new Map())
            )
        );

        this._performanceScores = Array(this._ensembleSize).fill(0);
        this._agreementScores = Array(this._ensembleSize).fill(0);
        this._specializationScores = Array(this._ensembleSize).fill(0);
        this._trustScoresHistory = Array(this._ensembleSize).fill().map(() => [0]);
        this._historicalPerformance = Array(this._ensembleSize).fill().map(() => [0]);
        this._adaptiveLearningRate = Array(this._ensembleSize).fill(this._learningRate);

        this._ensembleWeights = Array(this._ensembleSize).fill().map(() => 
            Math.max(0, 1 / this._ensembleSize + (Math.random() - 0.5) * 0.1 / this._ensembleSize)
        );
        this._normalizeEnsembleWeights();

        this._attentionMemory = Array(this._ensembleSize).fill().map(() => []);
        this._adaptiveContext = Array(this._ensembleSize).fill().map(() => []);
        this._semanticProtos = Array(this._ensembleSize).fill().map(() => []);
        this._coreEpisodic = Array(this._ensembleSize).fill().map(() => []);
        this._priorityIndices = Array(this._ensembleSize).fill().map(() => []);

        this._attentionWeightMatrix = Array(this._ensembleSize).fill().map(() =>
            this._dynamicInit(this._hiddenSize, 1, 0, 1).map(row => row[0])
        );

        this._attentionBias = Array(this._ensembleSize).fill().map(() =>
            Array(this._hiddenSize).fill().map(() => (Math.random() - 0.5) * Math.sqrt(4 / this._hiddenSize))
        );

        this._specializationWeights = Array(this._ensembleSize).fill().map(() => {
            const baseWeights = this._dynamicInit(this._hiddenSize, this._hiddenSize, 0, 1);
            return Array(this._hiddenSize).fill().map((_, j) =>
                Array(this._hiddenSize).fill().map((_, k) => {
                    const scale = 1 + 0.1 * (j / this._hiddenSize + k / this._hiddenSize);
                    return baseWeights[j][k] * scale;
                })
            );
        });

        this._transformers = this._setTransformerStructure();

        this._gradientAccumulation = this._setGradientStructure();
    },

    _setTransformerStructure () {
        return Array(this._ensembleSize).fill().map(() => ({
            attentionWeights: Array(this._numLayers).fill().map((_, layerIndex) => ({
                Wq: this._dynamicInit(this._hiddenSize, this._hiddenSize, layerIndex, this._numLayers),
                Wk: this._dynamicInit(this._hiddenSize, this._hiddenSize, layerIndex, this._numLayers),
                Wv: this._dynamicInit(this._hiddenSize, this._hiddenSize, layerIndex, this._numLayers),
                Wo: this._dynamicInit(this._hiddenSize, this._hiddenSize, layerIndex, this._numLayers)
            })),

            ffnWeights: Array(this._numLayers).fill().map((_, layerIndex) => ({
                gate_proj: this._dynamicInit(this._hiddenSize, this._feedForwardSize, layerIndex, this._numLayers),
                up_proj: this._dynamicInit(this._hiddenSize, this._feedForwardSize, layerIndex, this._numLayers),
                down_proj: this._dynamicInit(this._feedForwardSize, this._hiddenSize, layerIndex, this._numLayers)
            })),
            
            layerNormWeights: Array(this._numLayers).fill().map(() => ({
                gamma1: Array(this._hiddenSize).fill(1.0),
                gamma2: Array(this._hiddenSize).fill(1.0)
            })),

            outputWeights: this._dynamicInit(this._hiddenSize, 1, this._numLayers, this._numLayers + 1, 2.1),
            outputBias: Array(1).fill(0)
        }));
    },

    _setGradientStructure () {
        return Array(this._ensembleSize).fill().map(() => ({
            outputWeights: Array(this._hiddenSize).fill().map(() => Array(1).fill(0)),
            outputBias: Array(1).fill(0),

            attentionWeights: Array(this._numLayers).fill().map(() => ({
                Wq: Array(this._hiddenSize).fill().map(() => Array(this._hiddenSize).fill(0)),
                Wk: Array(this._hiddenSize).fill().map(() => Array(this._hiddenSize).fill(0)),
                Wv: Array(this._hiddenSize).fill().map(() => Array(this._hiddenSize).fill(0)),
                Wo: Array(this._hiddenSize).fill().map(() => Array(this._hiddenSize).fill(0))
            })),

            ffnWeights: Array(this._numLayers).fill().map(() => ({
                gate_proj: Array(this._hiddenSize).fill().map(() => Array(this._feedForwardSize).fill(0)),
                up_proj: Array(this._hiddenSize).fill().map(() => Array(this._feedForwardSize).fill(0)),
                down_proj: Array(this._feedForwardSize).fill().map(() => Array(this._hiddenSize).fill(0))
            })),

            layerNormWeights: Array(this._numLayers).fill().map(() => ({
                gamma1: Array(this._hiddenSize).fill(0),
                gamma2: Array(this._hiddenSize).fill(0)
            })),

            attentionBias: Array(this._hiddenSize).fill(0),
            attentionWeightMatrix: Array(this._hiddenSize).fill(0),
            specializationWeights: Array(this._hiddenSize).fill().map(() => Array(this._hiddenSize).fill(0))
        }));
    }

};
