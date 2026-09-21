// HiveMind component: load
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { isValidNumber } from '../utils.js';

export const loadStateMethods = {
    _loadState (ensembleSize, inputSize, forceMin) {
        const dbPath = path.join(this._directoryPath, this._fileName);
        let db;

        try {
            if (!fs.existsSync(dbPath)) {
                this._scaleAndSetDimensions(ensembleSize, inputSize, forceMin);
                return { status: true, message: 'Started with new state!' };
            }

            db = new Database(dbPath, { readonly: true });
            db.pragma('journal_mode = WAL');
            db.pragma('synchronous = NORMAL');
            db.pragma('temp_store = MEMORY');
            db.pragma('cache_size = -256000');

            const getMetadata = db.prepare('SELECT value FROM metadata WHERE key = ?');

            const scalarKeys = [
                'ensembleSize', 'inputSize', 'numLayers', 'numHeads', 'headDim', 'hiddenSize',
                'feedForwardSize', 'contextWindow', 'adaptiveWindow', 'semanticMaxProtos',
                'maxTrustHistory', 'maxPerformanceHistory', 'learningRate', 'learningRateDecay',
                'swarmIntelligenceFactor', 'gradientResetFrequency', 'semanticLR',
                'effectiveSemanticMax', 'longTermMaxProtos', 'shortTermMaxProtos', 'rawMaxProtos',
                'lowDim', 'numProjections', 'faithfulReplayEvery', 'generativeReplayEvery',
                'maxRetrievedProtos', 'numRetrievalCandidates', 'maxEpisodicConsider',
                'replaySamples', 'coreMaxProtos', 'coreEpisodicMaxEntries', 
                'lshNumTables', 'lshHashBits', 'numLshSets', 'priorityMax', 'trainingStepCount',
                'protoCapacityFactor', 'baseProtoCapacity', 'memoryFactor', 'maxVariancePerDim',
                'tempOverloadFactor', 'mergeTrimFactor', 'kernelGamma', 'protoIdCounter',
                'protoAccessDecay', 'protoSizeDecay', 'protoImpDecay', 'baseAccessInc', 'baseImpInc',
                'replaySizeScale', 'mergeAccessScale', 'coreBoostMultiplier'
            ];

            scalarKeys.forEach(key => {
                const row = getMetadata.get(key);
                if (row) {
                    const value = Number(row.value);
                    if (isValidNumber(value)) {
                        switch (key) {
                            case 'ensembleSize':
                                this._ensembleSize = value;
                                break;
                            case 'inputSize':
                                this._inputSize = value;
                                break;
                            case 'numLayers':
                                this._numLayers = value;
                                break;
                            case 'numHeads':
                                this._numHeads = value;
                                break;
                            case 'headDim':
                                this._headDim = value;
                                break;
                            case 'hiddenSize':
                                this._hiddenSize = value;
                                break;
                            case 'feedForwardSize':
                                this._feedForwardSize = value;
                                break;
                            case 'contextWindow':
                                this._contextWindow = value;
                                break;
                            case 'adaptiveWindow':
                                this._adaptiveWindow = value;
                                break;
                            case 'semanticMaxProtos':
                                this._semanticMaxProtos = value;
                                break;
                            case 'maxTrustHistory':
                                this._maxTrustHistory = value;
                                break;
                            case 'maxPerformanceHistory':
                                this._maxPerformanceHistory = value;
                                break;
                            case 'learningRate':
                                this._learningRate = value;
                                break;
                            case 'learningRateDecay':
                                this._learningRateDecay = value;
                                break;
                            case 'swarmIntelligenceFactor':
                                this._swarmIntelligenceFactor = value;
                                break;
                            case 'gradientResetFrequency':
                                this._gradientResetFrequency = value;
                                break;
                            case 'semanticLR':
                                this._semanticLR = value;
                                break;
                            case 'effectiveSemanticMax':
                                this._effectiveSemanticMax = value;
                                break;
                            case 'longTermMaxProtos':
                                this._longTermMaxProtos = value;
                                break;
                            case 'shortTermMaxProtos':
                                this._shortTermMaxProtos = value;
                                break;
                            case 'rawMaxProtos':
                                this._rawMaxProtos = value;
                                break;
                            case 'lowDim':
                                this._lowDim = value;
                                break;
                            case 'numProjections':
                                this._numProjections = value;
                                break;
                            case 'maxRetrievedProtos':
                                this._maxRetrievedProtos = value;
                                break;
                            case 'numRetrievalCandidates':
                                this._numRetrievalCandidates = value;
                                break;
                            case 'maxEpisodicConsider':
                                this._maxEpisodicConsider = value;
                                break;
                            case 'replaySamples':
                                this._replaySamples = value;
                                break;
                            case 'coreMaxProtos':
                                this._coreMaxProtos = value;
                                break;
                            case 'coreEpisodicMaxEntries':
                                this._coreEpisodicMaxEntries = value;
                                break;
                            case 'lshNumTables':
                                this._lshNumTables = value;
                                break;
                            case 'lshHashBits':
                                this._lshHashBits = value;
                                break;
                            case 'numLshSets':
                                this._numLshSets = value;
                                break;
                            case 'priorityMax':
                                this._priorityMax = value;
                                break;
                            case 'trainingStepCount':
                                this._trainingStepCount = value;
                                break;
                            case 'protoCapacityFactor':
                                this._protoCapacityFactor = value;
                                break;
                            case 'baseProtoCapacity':
                                this._baseProtoCapacity = value;
                                break;
                            case 'memoryFactor':
                                this._memoryFactor = value;
                                break;
                            case 'maxVariancePerDim':
                                this._maxVariancePerDim = value;
                                break;
                            case 'tempOverloadFactor':
                                this._tempOverloadFactor = value;
                                break;
                            case 'mergeTrimFactor':
                                this._mergeTrimFactor = value;
                                break;
                            case 'kernelGamma':
                                this._kernelGamma = value;
                                break;
                            case 'protoIdCounter':
                                this._protoIdCounter = BigInt(value);
                                break;
                            case 'generativeReplayEvery':
                                this._generativeReplayEvery = value;
                                break;
                            case 'faithfulReplayEvery':
                                this._faithfulReplayEvery = value;
                                break;
                            case 'protoAccessDecay':
                                this._protoAccessDecay = value;
                                break;
                            case 'protoSizeDecay':
                                this._protoSizeDecay = value;
                                break;
                            case 'protoImpDecay':
                                this._protoImpDecay = value;
                                break;
                            case 'baseAccessInc':
                                this._baseAccessInc = value;
                                break;
                            case 'baseImpInc':
                                this._baseImpInc = value;
                                break;
                            case 'replaySizeScale':
                                this._replaySizeScale = value;
                                break;
                            case 'mergeAccessScale':
                                this._mergeAccessScale = value;
                                break;
                            case 'coreBoostMultiplier':
                                this._coreBoostMultiplier = value;
                                break;
                            default:
                                console.warn(`Unexpected metadata key loaded: ${key}`);
                        }
                    }
                }
            });

            const hidden = this._hiddenSize;
            const ff = this._feedForwardSize;
            const low = this._lowDim;
            const projCount = this._numProjections;
            const es = this._ensembleSize;
            const layers = this._numLayers;

            this._projCache = new WeakMap();
            this._cachedAvgVariance = Array(es).fill(0);
            this._cachedUtilityScores = Array(es).fill().map(() => new Float32Array(0));

            this._projectionMatrices = Array.from({ length: projCount }, () => {
                const mat = new Array(hidden);
                for (let r = 0; r < hidden; r++) {
                    mat[r] = new Float32Array(low).fill(0);
                }
                return mat;
            });

            this._lshHyperplanes = Array.from({ length: this._numLshSets }, () =>
                Array.from({ length: this._lshNumTables }, () =>
                    Array.from({ length: this._lshHashBits }, () => new Float32Array(low).fill(0))
                )
            );

            this._attentionMemory = Array(es).fill().map(() => []);
            this._adaptiveContext = Array(es).fill().map(() => []);
            this._semanticProtos = Array(es).fill().map(() => []);
            this._coreEpisodic = Array(es).fill().map(() => []);
            this._priorityIndices = Array(es).fill().map(() => []);
            this._semanticLSHBuckets = Array(es).fill().map(() =>
                Array(this._numLshSets).fill().map(() =>
                    Array(this._lshNumTables).fill().map(() => new Map())
                )
            );

            this._ensembleWeights = Array(es).fill(0);
            this._performanceScores = Array(es).fill(0);
            this._agreementScores = Array(es).fill(0);
            this._specializationScores = Array(es).fill(0);
            this._adaptiveLearningRate = Array(es).fill(0);
            this._attentionWeightMatrix = Array(es).fill().map(() => Array(hidden).fill(0));
            this._attentionBias = Array(es).fill().map(() => Array(hidden).fill(0));
            this._specializationWeights = Array(es).fill().map(() =>
                Array(hidden).fill().map(() => Array(hidden).fill(0))
            );
            this._historicalPerformance = Array(es).fill().map(() => []);
            this._trustScoresHistory = Array(es).fill().map(() => []);

            const zeroMatrix = (rows, cols) => Array(rows).fill().map(() => Array(cols).fill(0));
            const zeroVector = length => Array(length).fill(0);

            this._transformers = Array(es).fill().map(() => ({
                attentionWeights: Array(layers).fill().map(() => ({
                    Wq: zeroMatrix(hidden, hidden),
                    Wk: zeroMatrix(hidden, hidden),
                    Wv: zeroMatrix(hidden, hidden),
                    Wo: zeroMatrix(hidden, hidden)
                })),
                ffnWeights: Array(layers).fill().map(() => ({
                    gate_proj: zeroMatrix(hidden, ff),
                    up_proj: zeroMatrix(hidden, ff),
                    down_proj: zeroMatrix(ff, hidden)
                })),
                layerNormWeights: Array(layers).fill().map(() => ({
                    gamma1: zeroVector(hidden),
                    gamma2: zeroVector(hidden)
                })),
                outputWeights: zeroMatrix(hidden, 1),
                outputBias: [0]
            }));

            this._gradientAccumulation = Array(es).fill().map(() => ({
                outputWeights: zeroMatrix(hidden, 1),
                outputBias: [0],
                attentionWeights: Array(layers).fill().map(() => ({
                    Wq: zeroMatrix(hidden, hidden),
                    Wk: zeroMatrix(hidden, hidden),
                    Wv: zeroMatrix(hidden, hidden),
                    Wo: zeroMatrix(hidden, hidden)
                })),
                ffnWeights: Array(layers).fill().map(() => ({
                    gate_proj: zeroMatrix(hidden, ff),
                    up_proj: zeroMatrix(hidden, ff),
                    down_proj: zeroMatrix(ff, hidden)
                })),
                layerNormWeights: Array(layers).fill().map(() => ({
                    gamma1: zeroVector(hidden),
                    gamma2: zeroVector(hidden)
                })),
                attentionBias: zeroVector(hidden),
                attentionWeightMatrix: zeroVector(hidden),
                specializationWeights: zeroMatrix(hidden, hidden)
            }));

            const loadVector = (table, target) => {
                const stmt = db.prepare(`SELECT idx, value FROM ${table} ORDER BY idx`);
                const rows = stmt.all();
                rows.forEach(({ idx, value }) => {
                    if (idx >= 0 && idx < es && isValidNumber(value)) {
                        target[idx] = value;
                    }
                });
            };

            loadVector('ensemble_weights', this._ensembleWeights);
            loadVector('performance_scores', this._performanceScores);
            loadVector('agreement_scores', this._agreementScores);
            loadVector('specialization_scores', this._specializationScores);
            loadVector('adaptive_learning_rate', this._adaptiveLearningRate);

            const load1DPerIdx = (table, target) => {
                const stmt = db.prepare(`SELECT idx, row, value FROM ${table}`);
                const rows = stmt.all();
                rows.forEach(({ idx, row, value }) => {
                    if (idx >= 0 && idx < es && row >= 0 && row < hidden && isValidNumber(value)) {
                        target[idx][row] = value;
                    }
                });
            };

            load1DPerIdx('attention_weight_matrix', this._attentionWeightMatrix);
            load1DPerIdx('attention_bias', this._attentionBias);

            const loadHistory = (table, target) => {
                const stmt = db.prepare(`SELECT idx, step, score FROM ${table} ORDER BY idx, step`);
                const rows = stmt.all();
                rows.forEach(({ idx, step, score }) => {
                    if (idx >= 0 && idx < es && Number.isInteger(step) && step >= 0 && isValidNumber(score)) {
                        while (target[idx].length <= step) target[idx].push(0);
                        target[idx][step] = score;
                    }
                });
            };

            loadHistory('historical_performance', this._historicalPerformance);
            loadHistory('trust_scores_history', this._trustScoresHistory);

            const specStmt = db.prepare('SELECT idx, data FROM specialization_weights');
            for (const row of specStmt.iterate()) {
                if (row.idx >= 0 && row.idx < es && row.data) {
                    const flat = new Float32Array(row.data.buffer, row.data.byteOffset, hidden * hidden);
                    if (flat.length === hidden * hidden) {
                        const mat = this._specializationWeights[row.idx];
                        for (let r = 0; r < hidden; r++) {
                            for (let c = 0; c < hidden; c++) {
                                mat[r][c] = flat[r * hidden + c];
                            }
                        }
                        this._specWeightCache[row.idx] = null;
                    }
                }
            }

            const projStmt = db.prepare('SELECT proj_idx, data FROM projection_matrices');
            for (const row of projStmt.iterate()) {
                if (row.proj_idx >= 0 && row.proj_idx < projCount && row.data) {
                    const flat = new Float32Array(row.data.buffer, row.data.byteOffset, hidden * low);
                    if (flat.length === hidden * low) {
                        const mat = this._projectionMatrices[row.proj_idx];
                        for (let r = 0; r < hidden; r++) {
                            for (let c = 0; c < low; c++) {
                                mat[r][c] = flat[r * low + c];
                            }
                        }
                    }
                }
            }

            const lshStmt = db.prepare('SELECT set_idx, table_idx, bit_idx, data FROM lsh_hyperplanes');
            for (const row of lshStmt.iterate()) {
                if (row.set_idx >= 0 && row.set_idx < this._numLshSets &&
                    row.table_idx >= 0 && row.table_idx < this._lshNumTables &&
                    row.bit_idx >= 0 && row.bit_idx < this._lshHashBits && row.data) {
                    const flat = new Float32Array(row.data.buffer, row.data.byteOffset, low);
                    if (flat.length === low) {
                        const vec = this._lshHyperplanes[row.set_idx][row.table_idx][row.bit_idx];
                        vec.set(flat);
                    }
                }
            }

            const loadAvgVar = db.prepare('SELECT idx, value FROM cached_avg_variance');
            const avgVarRows = loadAvgVar.all();
            avgVarRows.forEach(({ idx, value }) => {
                const i = Number(idx);
                if (i >= 0 && i < es && isValidNumber(value)) {
                    this._cachedAvgVariance[i] = Number(value);
                }
            });

            const loadUtil = db.prepare('SELECT idx, proto_idx, value FROM cached_utility_scores ORDER BY idx, proto_idx');
            const utilRows = loadUtil.all();
            utilRows.forEach(({ idx, proto_idx, value }) => {
                const i = Number(idx);
                const p = Number(proto_idx);
                const v = Number(value);
                if (i >= 0 && i < es && p >= 0 && isValidNumber(v)) {
                    let arr = this._cachedUtilityScores[i];
                    if (p >= arr.length) {
                        const newArr = new Float32Array(Math.max(p + 1, this._semanticProtos[i]?.length || p + 1));
                        newArr.set(arr);
                        this._cachedUtilityScores[i] = newArr;
                        arr = newArr;
                    }
                    arr[p] = v;
                }
            });

            const loadPrototypeMemory = (type) => {
                const isAttention = type === 'attention';
                const isAdaptive = type === 'adaptive';
                const isSemantic = type === 'semantic';
                const isCore = type === 'core';

                const hasWindow = isAttention || isAdaptive;
                const hasEntry = isCore;
                const hasRep = !isSemantic;

                const prefix = isAttention ? 'attention_memory' :
                               isAdaptive ? 'adaptive_context' :
                               isSemantic ? 'semantic' :
                               'core_episodic';

                let sql = `SELECT idx`;
                if (hasWindow) sql += ', window';
                if (hasEntry) sql += ', entry_idx';
                sql += ', proto_idx, proto_size, access_count, is_core, importance, mean_blob, variance_blob';
                sql += ', proto_id, content_hash';
                sql += ` FROM ${prefix}_protos`;
                sql += ` ORDER BY idx`;
                if (hasWindow) sql += ', window';
                if (hasEntry) sql += ', entry_idx';
                sql += ', proto_idx';

                const stmt = db.prepare(sql);
                const rows = stmt.all();

                const groups = {};
                rows.forEach(row => {
                    const pos = hasWindow ? row.window : (hasEntry ? row.entry_idx : 0);
                    const key = `${row.idx}_${pos}`;
                    if (!groups[key]) groups[key] = { protos: [], idx: row.idx, pos };
                    if (row.mean_blob && row.variance_blob) {
                        const mean = new Float32Array(row.mean_blob.buffer, row.mean_blob.byteOffset, hidden);
                        const variance = new Float32Array(row.variance_blob.buffer, row.variance_blob.byteOffset, hidden);
                        if (mean.length === hidden && variance.length === hidden) {
                            groups[key].protos[row.proto_idx] = {
                                mean,
                                variance,
                                size: row.proto_size || 0,
                                accessCount: row.access_count || 0,
                                isCore: !!row.is_core,
                                importance: row.importance || 0,
                                projNorms: Array(projCount).fill().map(() => new Float32Array(low).fill(0)),
                                protoId: row.proto_id || null,
                                contentHash: row.content_hash || null
                            };
                        }
                    }
                });

                Object.values(groups).forEach(group => {
                    const denseProtos = group.protos.filter(p => p !== undefined);
                    const entry = { protos: denseProtos };
                    if (hasRep) {
                        entry.repMean = new Float32Array(hidden).fill(0);
                        entry.repProj = Array(projCount).fill().map(() => new Float32Array(low).fill(0));
                    }

                    let memoryArray;
                    if (isAttention) memoryArray = this._attentionMemory[group.idx];
                    else if (isAdaptive) memoryArray = this._adaptiveContext[group.idx];
                    else if (isSemantic) memoryArray = this._semanticProtos[group.idx];
                    else if (isCore) memoryArray = this._coreEpisodic[group.idx];

                    if (isSemantic) {
                        this._semanticProtos[group.idx] = denseProtos;
                    } else {
                        while (memoryArray.length <= group.pos) memoryArray.push(null);
                        memoryArray[group.pos] = entry;
                    }
                });

                if (isAttention || isAdaptive) {
                    for (let i = 0; i < es; i++) {
                        const mem = isAttention ? this._attentionMemory[i] : this._adaptiveContext[i];
                        while (mem.length > 0 && (!mem[mem.length - 1] || mem[mem.length - 1].protos.length === 0)) {
                            mem.pop();
                        }
                    }
                }
            };

            loadPrototypeMemory('attention');
            loadPrototypeMemory('adaptive');
            loadPrototypeMemory('semantic');
            loadPrototypeMemory('core');

            for (let idx = 0; idx < es; idx++) {
                [this._attentionMemory[idx], this._adaptiveContext[idx], this._coreEpisodic[idx]].forEach(mem => {
                    mem.forEach(entry => {
                        if (entry && entry.protos.length > 0) {
                            entry.protos.forEach(proto => {
                                proto.projNorms = this._computeProjNorms(proto.mean);
                            });
                            entry.repMean = this._weightedMean(entry.protos);
                            entry.repProj = this._computeProjNorms(entry.repMean);
                        }
                    });
                });

                const semProtos = this._semanticProtos[idx];
                semProtos.forEach(proto => {
                    proto.projNorms = this._computeProjNorms(proto.mean);
                });

                this._semanticLSHBuckets[idx] = Array(this._numLshSets).fill().map(() =>
                    Array(this._lshNumTables).fill().map(() => new Map())
                );
                semProtos.forEach(proto => {
                    this._insertProtoToLSH(idx, proto);
                });

                const indexed = semProtos.map((proto, i) => ({ i, util: this._computeProtoUtility(proto) }));
                indexed.sort((a, b) => b.util - a.util);
                this._priorityIndices[idx] = indexed.slice(0, this._priorityMax).map(o => o.i);
            }

            const weightTypes = ['Wq', 'Wk', 'Wv', 'Wo'];
            const ffnTypes = ['gate_proj', 'up_proj', 'down_proj'];
            const normTypes = ['gamma1', 'gamma2'];

            weightTypes.forEach(type => {
                const stmt = db.prepare(`SELECT idx, layer, data FROM transformer_attention_${type}`);
                for (const row of stmt.iterate()) {
                    if (row.idx >= 0 && row.idx < es && row.layer >= 0 && row.layer < layers && row.data) {
                        const flat = new Float32Array(row.data.buffer, row.data.byteOffset, hidden * hidden);
                        if (flat.length === hidden * hidden) {
                            const mat = this._transformers[row.idx].attentionWeights[row.layer][type];
                            for (let r = 0; r < hidden; r++) {
                                for (let c = 0; c < hidden; c++) {
                                    mat[r][c] = flat[r * hidden + c];
                                }
                            }
                        }
                    }
                }
            });

            ffnTypes.forEach(type => {
                const rowsDim = type === 'down_proj' ? ff : hidden;
                const colsDim = type === 'down_proj' ? hidden : ff;
                const stmt = db.prepare(`SELECT idx, layer, data FROM transformer_ffn_${type}`);
                for (const row of stmt.iterate()) {
                    if (row.idx >= 0 && row.idx < es && row.layer >= 0 && row.layer < layers && row.data) {
                        const flat = new Float32Array(row.data.buffer, row.data.byteOffset, rowsDim * colsDim);
                        if (flat.length === rowsDim * colsDim) {
                            const mat = this._transformers[row.idx].ffnWeights[row.layer][type];
                            for (let r = 0; r < rowsDim; r++) {
                                for (let c = 0; c < colsDim; c++) {
                                    mat[r][c] = flat[r * colsDim + c];
                                }
                            }
                        }
                    }
                }
            });

            normTypes.forEach(type => {
                const stmt = db.prepare(`SELECT idx, layer, data FROM transformer_layer_norm_${type}`);
                for (const row of stmt.iterate()) {
                    if (row.idx >= 0 && row.idx < es && row.layer >= 0 && row.layer < layers && row.data) {
                        const flat = new Float32Array(row.data.buffer, row.data.byteOffset, hidden);
                        if (flat.length === hidden) {
                            const vec = this._transformers[row.idx].layerNormWeights[row.layer][type];
                            for (let i = 0; i < hidden; i++) {
                                vec[i] = flat[i];
                            }
                        }
                    }
                }
            });

            const outWeightStmt = db.prepare('SELECT idx, data FROM transformer_output_weights');
            for (const row of outWeightStmt.iterate()) {
                if (row.idx >= 0 && row.idx < es && row.data) {
                    const flat = new Float32Array(row.data.buffer, row.data.byteOffset, hidden);
                    if (flat.length === hidden) {
                        const mat = this._transformers[row.idx].outputWeights;
                        for (let r = 0; r < hidden; r++) {
                            mat[r][0] = flat[r];
                        }
                    }
                }
            }

            const outBiasStmt = db.prepare('SELECT idx, data FROM transformer_output_bias');
            for (const row of outBiasStmt.iterate()) {
                if (row.idx >= 0 && row.idx < es && row.data) {
                    const flat = new Float32Array(row.data.buffer, row.data.byteOffset, 1);
                    if (flat.length === 1) {
                        this._transformers[row.idx].outputBias[0] = flat[0];
                    }
                }
            }

            weightTypes.forEach(type => {
                const stmt = db.prepare(`SELECT idx, layer, data FROM gradient_attention_${type}`);
                for (const row of stmt.iterate()) {
                    if (row.idx >= 0 && row.idx < es && row.layer >= 0 && row.layer < layers && row.data) {
                        const flat = new Float32Array(row.data.buffer, row.data.byteOffset, hidden * hidden);
                        if (flat.length === hidden * hidden) {
                            const mat = this._gradientAccumulation[row.idx].attentionWeights[row.layer][type];
                            for (let r = 0; r < hidden; r++) {
                                for (let c = 0; c < hidden; c++) {
                                    mat[r][c] = flat[r * hidden + c];
                                }
                            }
                        }
                    }
                }
            });

            ffnTypes.forEach(type => {
                const rowsDim = type === 'down_proj' ? ff : hidden;
                const colsDim = type === 'down_proj' ? hidden : ff;
                const stmt = db.prepare(`SELECT idx, layer, data FROM gradient_ffn_${type}`);
                for (const row of stmt.iterate()) {
                    if (row.idx >= 0 && row.idx < es && row.layer >= 0 && row.layer < layers && row.data) {
                        const flat = new Float32Array(row.data.buffer, row.data.byteOffset, rowsDim * colsDim);
                        if (flat.length === rowsDim * colsDim) {
                            const mat = this._gradientAccumulation[row.idx].ffnWeights[row.layer][type];
                            for (let r = 0; r < rowsDim; r++) {
                                for (let c = 0; c < colsDim; c++) {
                                    mat[r][c] = flat[r * colsDim + c];
                                }
                            }
                        }
                    }
                }
            });

            normTypes.forEach(type => {
                const stmt = db.prepare(`SELECT idx, layer, data FROM gradient_layer_norm_${type}`);
                for (const row of stmt.iterate()) {
                    if (row.idx >= 0 && row.idx < es && row.layer >= 0 && row.layer < layers && row.data) {
                        const flat = new Float32Array(row.data.buffer, row.data.byteOffset, hidden);
                        if (flat.length === hidden) {
                            const vec = this._gradientAccumulation[row.idx].layerNormWeights[row.layer][type];
                            for (let i = 0; i < hidden; i++) {
                                vec[i] = flat[i];
                            }
                        }
                    }
                }
            });

            const gradOutWeightStmt = db.prepare('SELECT idx, data FROM gradient_output_weights');
            for (const row of gradOutWeightStmt.iterate()) {
                if (row.idx >= 0 && row.idx < es && row.data) {
                    const flat = new Float32Array(row.data.buffer, row.data.byteOffset, hidden);
                    if (flat.length === hidden) {
                        const mat = this._gradientAccumulation[row.idx].outputWeights;
                        for (let r = 0; r < hidden; r++) {
                            mat[r][0] = flat[r];
                        }
                    }
                }
            }

            const gradOutBiasStmt = db.prepare('SELECT idx, data FROM gradient_output_bias');
            for (const row of gradOutBiasStmt.iterate()) {
                if (row.idx >= 0 && row.idx < es && row.data) {
                    const flat = new Float32Array(row.data.buffer, row.data.byteOffset, 1);
                    if (flat.length === 1) {
                        this._gradientAccumulation[row.idx].outputBias[0] = flat[0];
                    }
                }
            }

            const gradAttBiasStmt = db.prepare('SELECT idx, data FROM gradient_attention_bias');
            for (const row of gradAttBiasStmt.iterate()) {
                if (row.idx >= 0 && row.idx < es && row.data) {
                    const flat = new Float32Array(row.data.buffer, row.data.byteOffset, hidden);
                    if (flat.length === hidden) {
                        const vec = this._gradientAccumulation[row.idx].attentionBias;
                        for (let i = 0; i < hidden; i++) {
                            vec[i] = flat[i];
                        }
                    }
                }
            }

            const gradAttMatStmt = db.prepare('SELECT idx, data FROM gradient_attention_weight_matrix');
            for (const row of gradAttMatStmt.iterate()) {
                if (row.idx >= 0 && row.idx < es && row.data) {
                    const flat = new Float32Array(row.data.buffer, row.data.byteOffset, hidden);
                    if (flat.length === hidden) {
                        const vec = this._gradientAccumulation[row.idx].attentionWeightMatrix;
                        for (let i = 0; i < hidden; i++) {
                            vec[i] = flat[i];
                        }
                    }
                }
            }

            const gradSpecStmt = db.prepare('SELECT idx, data FROM gradient_specialization_weights');
            for (const row of gradSpecStmt.iterate()) {
                if (row.idx >= 0 && row.idx < es && row.data) {
                    const flat = new Float32Array(row.data.buffer, row.data.byteOffset, hidden * hidden);
                    if (flat.length === hidden * hidden) {
                        const mat = this._gradientAccumulation[row.idx].specializationWeights;
                        for (let r = 0; r < hidden; r++) {
                            for (let c = 0; c < hidden; c++) {
                                mat[r][c] = flat[r * hidden + c];
                            }
                        }
                    }
                }
            }

            for (let idx = 0; idx < es; idx++) {
                this._updateSemanticStats(idx);
            }

            this._normalizeEnsembleWeights();

            return { status: true, message: 'State loaded successfully!' };
        } catch (error) {
            // Return the failure (never process.exit): a corrupt/partial state
            // file degrades to a clear error the caller can act on instead of
            // killing the worker — and therefore the run (ROADMAP P0-1).
            console.error(error.message, error.stack);
            return { status: false, error: error.message, trace: error.stack };
        } finally {
            if (db) db.close();
        }
    }

};
