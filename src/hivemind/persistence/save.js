// HiveMind component: save
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
import path from 'path';
import Database from 'better-sqlite3';
import { isValidNumber } from '../utils.js';

export const saveStateMethods = {
    _saveState () {
        const dbPath = path.join(this._directoryPath, this._fileName);
        let db;

        try {
            db = new Database(dbPath);
            db.pragma('journal_mode = WAL');
            db.pragma('synchronous = NORMAL');
            db.pragma('temp_store = MEMORY');
            db.pragma('cache_size = -256000');

            db.exec('BEGIN TRANSACTION');

            db.exec(`
                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT
                );
                CREATE TABLE IF NOT EXISTS ensemble_weights (
                    idx INTEGER PRIMARY KEY,
                    value REAL
                );
                CREATE TABLE IF NOT EXISTS performance_scores (
                    idx INTEGER PRIMARY KEY,
                    value REAL
                );
                CREATE TABLE IF NOT EXISTS agreement_scores (
                    idx INTEGER PRIMARY KEY,
                    value REAL
                );
                CREATE TABLE IF NOT EXISTS specialization_scores (
                    idx INTEGER PRIMARY KEY,
                    value REAL
                );
                CREATE TABLE IF NOT EXISTS historical_performance (
                    idx INTEGER,
                    step INTEGER,
                    score REAL,
                    PRIMARY KEY (idx, step)
                );
                CREATE TABLE IF NOT EXISTS trust_scores_history (
                    idx INTEGER,
                    step INTEGER,
                    score REAL,
                    PRIMARY KEY (idx, step)
                );
                CREATE TABLE IF NOT EXISTS adaptive_learning_rate (
                    idx INTEGER PRIMARY KEY,
                    value REAL
                );
                CREATE TABLE IF NOT EXISTS attention_weight_matrix (
                    idx INTEGER,
                    row INTEGER,
                    value REAL,
                    PRIMARY KEY (idx, row)
                );
                CREATE TABLE IF NOT EXISTS attention_bias (
                    idx INTEGER,
                    row INTEGER,
                    value REAL,
                    PRIMARY KEY (idx, row)
                );

                CREATE TABLE IF NOT EXISTS attention_memory_protos (
                    idx INTEGER,
                    window INTEGER,
                    proto_idx INTEGER,
                    proto_size REAL,
                    access_count REAL,
                    is_core INTEGER DEFAULT 0,
                    importance REAL DEFAULT 0,
                    mean_blob BLOB,
                    variance_blob BLOB,
                    proto_id TEXT,
                    content_hash TEXT,
                    PRIMARY KEY (idx, window, proto_idx)
                );
                CREATE TABLE IF NOT EXISTS adaptive_context_protos (
                    idx INTEGER,
                    window INTEGER,
                    proto_idx INTEGER,
                    proto_size REAL,
                    access_count REAL,
                    is_core INTEGER DEFAULT 0,
                    importance REAL DEFAULT 0,
                    mean_blob BLOB,
                    variance_blob BLOB,
                    proto_id TEXT,
                    content_hash TEXT,
                    PRIMARY KEY (idx, window, proto_idx)
                );
                CREATE TABLE IF NOT EXISTS semantic_protos (
                    idx INTEGER,
                    proto_idx INTEGER,
                    proto_size REAL,
                    access_count REAL,
                    is_core INTEGER DEFAULT 0,
                    importance REAL DEFAULT 0,
                    mean_blob BLOB,
                    variance_blob BLOB,
                    proto_id TEXT,
                    content_hash TEXT,
                    PRIMARY KEY (idx, proto_idx)
                );
                CREATE TABLE IF NOT EXISTS core_episodic_protos (
                    idx INTEGER,
                    entry_idx INTEGER,
                    proto_idx INTEGER,
                    proto_size REAL,
                    access_count REAL,
                    is_core INTEGER DEFAULT 0,
                    importance REAL DEFAULT 0,
                    mean_blob BLOB,
                    variance_blob BLOB,
                    proto_id TEXT,
                    content_hash TEXT,
                    PRIMARY KEY (idx, entry_idx, proto_idx)
                );

                CREATE TABLE IF NOT EXISTS specialization_weights (
                    idx INTEGER PRIMARY KEY,
                    data BLOB
                );
                CREATE TABLE IF NOT EXISTS projection_matrices (
                    proj_idx INTEGER PRIMARY KEY,
                    data BLOB
                );
                CREATE TABLE IF NOT EXISTS lsh_hyperplanes (
                    set_idx INTEGER,
                    table_idx INTEGER,
                    bit_idx INTEGER,
                    data BLOB,
                    PRIMARY KEY (set_idx, table_idx, bit_idx)
                );

                CREATE TABLE IF NOT EXISTS cached_avg_variance (
                    idx INTEGER PRIMARY KEY,
                    value REAL
                );
                CREATE TABLE IF NOT EXISTS cached_utility_scores (
                    idx INTEGER,
                    proto_idx INTEGER,
                    value REAL,
                    PRIMARY KEY (idx, proto_idx)
                );

                CREATE TABLE IF NOT EXISTS transformer_attention_Wq (idx INTEGER, layer INTEGER, data BLOB, PRIMARY KEY (idx, layer));
                CREATE TABLE IF NOT EXISTS transformer_attention_Wk (idx INTEGER, layer INTEGER, data BLOB, PRIMARY KEY (idx, layer));
                CREATE TABLE IF NOT EXISTS transformer_attention_Wv (idx INTEGER, layer INTEGER, data BLOB, PRIMARY KEY (idx, layer));
                CREATE TABLE IF NOT EXISTS transformer_attention_Wo (idx INTEGER, layer INTEGER, data BLOB, PRIMARY KEY (idx, layer));
                CREATE TABLE IF NOT EXISTS transformer_ffn_gate_proj (idx INTEGER, layer INTEGER, data BLOB, PRIMARY KEY (idx, layer));
                CREATE TABLE IF NOT EXISTS transformer_ffn_up_proj (idx INTEGER, layer INTEGER, data BLOB, PRIMARY KEY (idx, layer));
                CREATE TABLE IF NOT EXISTS transformer_ffn_down_proj (idx INTEGER, layer INTEGER, data BLOB, PRIMARY KEY (idx, layer));
                CREATE TABLE IF NOT EXISTS transformer_layer_norm_gamma1 (idx INTEGER, layer INTEGER, data BLOB, PRIMARY KEY (idx, layer));
                CREATE TABLE IF NOT EXISTS transformer_layer_norm_gamma2 (idx INTEGER, layer INTEGER, data BLOB, PRIMARY KEY (idx, layer));
                CREATE TABLE IF NOT EXISTS transformer_output_weights (idx INTEGER PRIMARY KEY, data BLOB);
                CREATE TABLE IF NOT EXISTS transformer_output_bias (idx INTEGER PRIMARY KEY, data BLOB);

                CREATE TABLE IF NOT EXISTS gradient_attention_Wq (idx INTEGER, layer INTEGER, data BLOB, PRIMARY KEY (idx, layer));
                CREATE TABLE IF NOT EXISTS gradient_attention_Wk (idx INTEGER, layer INTEGER, data BLOB, PRIMARY KEY (idx, layer));
                CREATE TABLE IF NOT EXISTS gradient_attention_Wv (idx INTEGER, layer INTEGER, data BLOB, PRIMARY KEY (idx, layer));
                CREATE TABLE IF NOT EXISTS gradient_attention_Wo (idx INTEGER, layer INTEGER, data BLOB, PRIMARY KEY (idx, layer));
                CREATE TABLE IF NOT EXISTS gradient_ffn_gate_proj (idx INTEGER, layer INTEGER, data BLOB, PRIMARY KEY (idx, layer));
                CREATE TABLE IF NOT EXISTS gradient_ffn_up_proj (idx INTEGER, layer INTEGER, data BLOB, PRIMARY KEY (idx, layer));
                CREATE TABLE IF NOT EXISTS gradient_ffn_down_proj (idx INTEGER, layer INTEGER, data BLOB, PRIMARY KEY (idx, layer));
                CREATE TABLE IF NOT EXISTS gradient_layer_norm_gamma1 (idx INTEGER, layer INTEGER, data BLOB, PRIMARY KEY (idx, layer));
                CREATE TABLE IF NOT EXISTS gradient_layer_norm_gamma2 (idx INTEGER, layer INTEGER, data BLOB, PRIMARY KEY (idx, layer));
                CREATE TABLE IF NOT EXISTS gradient_output_weights (idx INTEGER PRIMARY KEY, data BLOB);
                CREATE TABLE IF NOT EXISTS gradient_output_bias (idx INTEGER PRIMARY KEY, data BLOB);
                CREATE TABLE IF NOT EXISTS gradient_attention_bias (idx INTEGER PRIMARY KEY, data BLOB);
                CREATE TABLE IF NOT EXISTS gradient_attention_weight_matrix (idx INTEGER PRIMARY KEY, data BLOB);
                CREATE TABLE IF NOT EXISTS gradient_specialization_weights (idx INTEGER PRIMARY KEY, data BLOB);
            `);

            const tablesToClear = [
                'metadata',
                'ensemble_weights', 'performance_scores', 'agreement_scores', 'specialization_scores',
                'historical_performance', 'trust_scores_history', 'adaptive_learning_rate',
                'attention_weight_matrix', 'attention_bias',
                'attention_memory_protos', 'adaptive_context_protos', 'semantic_protos', 'core_episodic_protos',
                'specialization_weights', 'projection_matrices', 'lsh_hyperplanes',
                'transformer_attention_Wq', 'transformer_attention_Wk', 'transformer_attention_Wv', 'transformer_attention_Wo',
                'transformer_ffn_gate_proj', 'transformer_ffn_up_proj', 'transformer_ffn_down_proj',
                'transformer_layer_norm_gamma1', 'transformer_layer_norm_gamma2',
                'transformer_output_weights', 'transformer_output_bias',
                'gradient_attention_Wq', 'gradient_attention_Wk', 'gradient_attention_Wv', 'gradient_attention_Wo',
                'gradient_ffn_gate_proj', 'gradient_ffn_up_proj', 'gradient_ffn_down_proj',
                'gradient_layer_norm_gamma1', 'gradient_layer_norm_gamma2',
                'gradient_output_weights', 'gradient_output_bias',
                'gradient_attention_bias', 'gradient_attention_weight_matrix', 'gradient_specialization_weights',
                'cached_avg_variance', 'cached_utility_scores',
            ];

            tablesToClear.forEach(table => db.exec(`DELETE FROM ${table};`));

            const insertMetadata = db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
            const scalarFields = {
                ensembleSize: this._ensembleSize,
                inputSize: this._inputSize,
                numLayers: this._numLayers,
                numHeads: this._numHeads,
                headDim: this._headDim,
                hiddenSize: this._hiddenSize,
                feedForwardSize: this._feedForwardSize,
                contextWindow: this._contextWindow,
                adaptiveWindow: this._adaptiveWindow,
                semanticMaxProtos: this._semanticMaxProtos,
                maxTrustHistory: this._maxTrustHistory,
                maxPerformanceHistory: this._maxPerformanceHistory,
                learningRate: this._learningRate,
                learningRateDecay: this._learningRateDecay,
                swarmIntelligenceFactor: this._swarmIntelligenceFactor,
                gradientResetFrequency: this._gradientResetFrequency,
                semanticLR: this._semanticLR,
                effectiveSemanticMax: this._effectiveSemanticMax,
                longTermMaxProtos: this._longTermMaxProtos,
                shortTermMaxProtos: this._shortTermMaxProtos,
                rawMaxProtos: this._rawMaxProtos,
                lowDim: this._lowDim,
                numProjections: this._numProjections,
                maxRetrievedProtos: this._maxRetrievedProtos,
                numRetrievalCandidates: this._numRetrievalCandidates,
                maxEpisodicConsider: this._maxEpisodicConsider,
                replaySamples: this._replaySamples,
                coreMaxProtos: this._coreMaxProtos,
                coreEpisodicMaxEntries: this._coreEpisodicMaxEntries,
                lshNumTables: this._lshNumTables,
                lshHashBits: this._lshHashBits,
                numLshSets: this._numLshSets,
                priorityMax: this._priorityMax,
                protoCapacityFactor: this._protoCapacityFactor,
                baseProtoCapacity: this._baseProtoCapacity,
                memoryFactor: this._memoryFactor,
                maxVariancePerDim: this._maxVariancePerDim,
                tempOverloadFactor: this._tempOverloadFactor,
                mergeTrimFactor: this._mergeTrimFactor,
                kernelGamma: this._kernelGamma,
                protoIdCounter: this._protoIdCounter,
                generativeReplayEvery : this._generativeReplayEvery,
                faithfulReplayEvery : this._faithfulReplayEvery,
                protoAccessDecay : this._protoAccessDecay,
                protoSizeDecay : this._protoSizeDecay,
                protoImpDecay : this._protoImpDecay,
                baseAccessInc : this._baseAccessInc,
                baseImpInc : this._baseImpInc,
                replaySizeScale : this._replaySizeScale,
                mergeAccessScale : this._mergeAccessScale,
                coreBoostMultiplier : this._coreBoostMultiplier,
                trainingStepCount: this._trainingStepCount
            };

            for (const [key, value] of Object.entries(scalarFields)) {
                insertMetadata.run(key, value.toString());
            }

            const batchInsert = (table, columns, data, maxVariables = 900) => {
                if (data.length === 0) return;

                const paramsPerRow = columns.length;
                const safeBatchSize = Math.max(1, Math.floor(maxVariables / paramsPerRow));

                const placeholder = `(${columns.map(() => '?').join(', ')})`;

                let offset = 0;
                while (offset < data.length) {
                    const chunkSize = Math.min(safeBatchSize, data.length - offset);
                    const chunk = data.slice(offset, offset + chunkSize);

                    const placeholders = Array(chunkSize).fill(placeholder).join(', ');
                    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}`;

                    const params = chunk.flat();
                    db.prepare(sql).run(...params);

                    offset += chunkSize;
                }
            };

            const ensembleSize = this._ensembleSize;
            const hidden = this._hiddenSize;
            const ff = this._feedForwardSize;
            const low = this._lowDim;
            const layers = this._numLayers;

            let rows = [];
            for (let idx = 0; idx < ensembleSize; idx++) {
                rows.push([idx, this._ensembleWeights[idx]]);
            }
            batchInsert('ensemble_weights', ['idx', 'value'], rows);

            rows = [];
            for (let idx = 0; idx < ensembleSize; idx++) {
                rows.push([idx, this._performanceScores[idx]]);
            }
            batchInsert('performance_scores', ['idx', 'value'], rows);

            rows = [];
            for (let idx = 0; idx < ensembleSize; idx++) {
                rows.push([idx, this._agreementScores[idx]]);
            }
            batchInsert('agreement_scores', ['idx', 'value'], rows);

            rows = [];
            for (let idx = 0; idx < ensembleSize; idx++) {
                rows.push([idx, this._specializationScores[idx]]);
            }
            batchInsert('specialization_scores', ['idx', 'value'], rows);

            rows = [];
            for (let idx = 0; idx < ensembleSize; idx++) {
                rows.push([idx, this._adaptiveLearningRate[idx]]);
            }
            batchInsert('adaptive_learning_rate', ['idx', 'value'], rows);

            rows = [];
            for (let idx = 0; idx < ensembleSize; idx++) {
                const history = this._historicalPerformance[idx];
                for (let step = 0; step < history.length; step++) {
                    rows.push([idx, step, history[step]]);
                }
            }
            batchInsert('historical_performance', ['idx', 'step', 'score'], rows);

            rows = [];
            for (let idx = 0; idx < ensembleSize; idx++) {
                const history = this._trustScoresHistory[idx];
                for (let step = 0; step < history.length; step++) {
                    rows.push([idx, step, history[step]]);
                }
            }
            batchInsert('trust_scores_history', ['idx', 'step', 'score'], rows);

            rows = [];
            for (let idx = 0; idx < ensembleSize; idx++) {
                for (let row = 0; row < hidden; row++) {
                    rows.push([idx, row, this._attentionWeightMatrix[idx][row]]);
                }
            }
            batchInsert('attention_weight_matrix', ['idx', 'row', 'value'], rows);

            rows = [];
            for (let idx = 0; idx < ensembleSize; idx++) {
                for (let row = 0; row < hidden; row++) {
                    rows.push([idx, row, this._attentionBias[idx][row]]);
                }
            }
            batchInsert('attention_bias', ['idx', 'row', 'value'], rows);

            rows = [];
            for (let idx = 0; idx < ensembleSize; idx++) {
                const mat = this._specializationWeights[idx];
                const flat = new Float32Array(hidden * hidden);
                for (let r = 0; r < hidden; r++) {
                    for (let c = 0; c < hidden; c++) {
                        flat[r * hidden + c] = mat[r][c];
                    }
                }
                rows.push([idx, Buffer.from(flat.buffer)]);
            }
            batchInsert('specialization_weights', ['idx', 'data'], rows);

            rows = [];
            for (let proj_idx = 0; proj_idx < this._numProjections; proj_idx++) {
                const mat = this._projectionMatrices[proj_idx];
                const flat = new Float32Array(hidden * low);
                for (let r = 0; r < hidden; r++) {
                    for (let c = 0; c < low; c++) {
                        flat[r * low + c] = mat[r][c];
                    }
                }
                rows.push([proj_idx, Buffer.from(flat.buffer)]);
            }
            batchInsert('projection_matrices', ['proj_idx', 'data'], rows);

            rows = [];
            for (let set_idx = 0; set_idx < this._numLshSets; set_idx++) {
                for (let table_idx = 0; table_idx < this._lshNumTables; table_idx++) {
                    for (let bit_idx = 0; bit_idx < this._lshHashBits; bit_idx++) {
                        const vec = this._lshHyperplanes[set_idx][table_idx][bit_idx];
                        const flat = new Float32Array(low);
                        flat.set(vec);
                        rows.push([set_idx, table_idx, bit_idx, Buffer.from(flat.buffer)]);
                    }
                }
            }
            batchInsert('lsh_hyperplanes', ['set_idx', 'table_idx', 'bit_idx', 'data'], rows);

            const wqRows = [], wkRows = [], wvRows = [], woRows = [];
            const gateRows = [], upRows = [], downRows = [];
            const gamma1Rows = [], gamma2Rows = [];
            const outWeightRows = [], outBiasRows = [];

            for (let idx = 0; idx < ensembleSize; idx++) {
                const t = this._transformers[idx];
                let flat;

                for (let layer = 0; layer < layers; layer++) {
                    const att = t.attentionWeights[layer];

                    flat = new Float32Array(hidden * hidden);
                    for (let r = 0; r < hidden; r++) for (let c = 0; c < hidden; c++) flat[r * hidden + c] = att.Wq[r][c];
                    wqRows.push([idx, layer, Buffer.from(flat.buffer)]);

                    flat = new Float32Array(hidden * hidden);
                    for (let r = 0; r < hidden; r++) for (let c = 0; c < hidden; c++) flat[r * hidden + c] = att.Wk[r][c];
                    wkRows.push([idx, layer, Buffer.from(flat.buffer)]);

                    flat = new Float32Array(hidden * hidden);
                    for (let r = 0; r < hidden; r++) for (let c = 0; c < hidden; c++) flat[r * hidden + c] = att.Wv[r][c];
                    wvRows.push([idx, layer, Buffer.from(flat.buffer)]);

                    flat = new Float32Array(hidden * hidden);
                    for (let r = 0; r < hidden; r++) for (let c = 0; c < hidden; c++) flat[r * hidden + c] = att.Wo[r][c];
                    woRows.push([idx, layer, Buffer.from(flat.buffer)]);

                    const ffn = t.ffnWeights[layer];

                    flat = new Float32Array(hidden * ff);
                    for (let r = 0; r < hidden; r++) for (let c = 0; c < ff; c++) flat[r * ff + c] = ffn.gate_proj[r][c];
                    gateRows.push([idx, layer, Buffer.from(flat.buffer)]);

                    flat = new Float32Array(hidden * ff);
                    for (let r = 0; r < hidden; r++) for (let c = 0; c < ff; c++) flat[r * ff + c] = ffn.up_proj[r][c];
                    upRows.push([idx, layer, Buffer.from(flat.buffer)]);

                    flat = new Float32Array(ff * hidden);
                    for (let r = 0; r < ff; r++) for (let c = 0; c < hidden; c++) flat[r * hidden + c] = ffn.down_proj[r][c];
                    downRows.push([idx, layer, Buffer.from(flat.buffer)]);

                    flat = new Float32Array(hidden);
                    flat.set(t.layerNormWeights[layer].gamma1);
                    gamma1Rows.push([idx, layer, Buffer.from(flat.buffer)]);

                    flat = new Float32Array(hidden);
                    flat.set(t.layerNormWeights[layer].gamma2);
                    gamma2Rows.push([idx, layer, Buffer.from(flat.buffer)]);
                }

                flat = new Float32Array(hidden);
                for (let r = 0; r < hidden; r++) flat[r] = t.outputWeights[r][0];
                outWeightRows.push([idx, Buffer.from(flat.buffer)]);

                flat = new Float32Array(1);
                flat[0] = t.outputBias[0];
                outBiasRows.push([idx, Buffer.from(flat.buffer)]);
            }

            batchInsert('transformer_attention_Wq', ['idx', 'layer', 'data'], wqRows);
            batchInsert('transformer_attention_Wk', ['idx', 'layer', 'data'], wkRows);
            batchInsert('transformer_attention_Wv', ['idx', 'layer', 'data'], wvRows);
            batchInsert('transformer_attention_Wo', ['idx', 'layer', 'data'], woRows);
            batchInsert('transformer_ffn_gate_proj', ['idx', 'layer', 'data'], gateRows);
            batchInsert('transformer_ffn_up_proj', ['idx', 'layer', 'data'], upRows);
            batchInsert('transformer_ffn_down_proj', ['idx', 'layer', 'data'], downRows);
            batchInsert('transformer_layer_norm_gamma1', ['idx', 'layer', 'data'], gamma1Rows);
            batchInsert('transformer_layer_norm_gamma2', ['idx', 'layer', 'data'], gamma2Rows);
            batchInsert('transformer_output_weights', ['idx', 'data'], outWeightRows);
            batchInsert('transformer_output_bias', ['idx', 'data'], outBiasRows);

            const gradWqRows = [], gradWkRows = [], gradWvRows = [], gradWoRows = [];
            const gradGateRows = [], gradUpRows = [], gradDownRows = [];
            const gradGamma1Rows = [], gradGamma2Rows = [];
            const gradOutWeightRows = [], gradOutBiasRows = [];
            const gradAttBiasRows = [], gradAttMatRows = [], gradSpecRows = [];

            for (let idx = 0; idx < ensembleSize; idx++) {
                const g = this._gradientAccumulation[idx];
                let flat;

                for (let layer = 0; layer < layers; layer++) {
                    const att = g.attentionWeights[layer];

                    flat = new Float32Array(hidden * hidden);
                    for (let r = 0; r < hidden; r++) for (let c = 0; c < hidden; c++) flat[r * hidden + c] = att.Wq[r][c];
                    gradWqRows.push([idx, layer, Buffer.from(flat.buffer)]);

                    flat = new Float32Array(hidden * hidden);
                    for (let r = 0; r < hidden; r++) for (let c = 0; c < hidden; c++) flat[r * hidden + c] = att.Wk[r][c];
                    gradWkRows.push([idx, layer, Buffer.from(flat.buffer)]);

                    flat = new Float32Array(hidden * hidden);
                    for (let r = 0; r < hidden; r++) for (let c = 0; c < hidden; c++) flat[r * hidden + c] = att.Wv[r][c];
                    gradWvRows.push([idx, layer, Buffer.from(flat.buffer)]);

                    flat = new Float32Array(hidden * hidden);
                    for (let r = 0; r < hidden; r++) for (let c = 0; c < hidden; c++) flat[r * hidden + c] = att.Wo[r][c];
                    gradWoRows.push([idx, layer, Buffer.from(flat.buffer)]);

                    const ffn = g.ffnWeights[layer];

                    flat = new Float32Array(hidden * ff);
                    for (let r = 0; r < hidden; r++) for (let c = 0; c < ff; c++) flat[r * ff + c] = ffn.gate_proj[r][c];
                    gradGateRows.push([idx, layer, Buffer.from(flat.buffer)]);

                    flat = new Float32Array(hidden * ff);
                    for (let r = 0; r < hidden; r++) for (let c = 0; c < ff; c++) flat[r * ff + c] = ffn.up_proj[r][c];
                    gradUpRows.push([idx, layer, Buffer.from(flat.buffer)]);

                    flat = new Float32Array(ff * hidden);
                    for (let r = 0; r < ff; r++) for (let c = 0; c < hidden; c++) flat[r * hidden + c] = ffn.down_proj[r][c];
                    gradDownRows.push([idx, layer, Buffer.from(flat.buffer)]);

                    flat = new Float32Array(hidden);
                    flat.set(g.layerNormWeights[layer].gamma1);
                    gradGamma1Rows.push([idx, layer, Buffer.from(flat.buffer)]);

                    flat = new Float32Array(hidden);
                    flat.set(g.layerNormWeights[layer].gamma2);
                    gradGamma2Rows.push([idx, layer, Buffer.from(flat.buffer)]);
                }

                flat = new Float32Array(hidden);
                for (let r = 0; r < hidden; r++) flat[r] = g.outputWeights[r][0];
                gradOutWeightRows.push([idx, Buffer.from(flat.buffer)]);

                flat = new Float32Array(1);
                flat[0] = g.outputBias[0];
                gradOutBiasRows.push([idx, Buffer.from(flat.buffer)]);

                flat = new Float32Array(hidden);
                flat.set(g.attentionBias);
                gradAttBiasRows.push([idx, Buffer.from(flat.buffer)]);

                flat = new Float32Array(hidden);
                flat.set(g.attentionWeightMatrix);
                gradAttMatRows.push([idx, Buffer.from(flat.buffer)]);

                flat = new Float32Array(hidden * hidden);
                for (let r = 0; r < hidden; r++) for (let c = 0; c < hidden; c++) flat[r * hidden + c] = g.specializationWeights[r][c];
                gradSpecRows.push([idx, Buffer.from(flat.buffer)]);
            }

            batchInsert('gradient_attention_Wq', ['idx', 'layer', 'data'], gradWqRows);
            batchInsert('gradient_attention_Wk', ['idx', 'layer', 'data'], gradWkRows);
            batchInsert('gradient_attention_Wv', ['idx', 'layer', 'data'], gradWvRows);
            batchInsert('gradient_attention_Wo', ['idx', 'layer', 'data'], gradWoRows);
            batchInsert('gradient_ffn_gate_proj', ['idx', 'layer', 'data'], gradGateRows);
            batchInsert('gradient_ffn_up_proj', ['idx', 'layer', 'data'], gradUpRows);
            batchInsert('gradient_ffn_down_proj', ['idx', 'layer', 'data'], gradDownRows);
            batchInsert('gradient_layer_norm_gamma1', ['idx', 'layer', 'data'], gradGamma1Rows);
            batchInsert('gradient_layer_norm_gamma2', ['idx', 'layer', 'data'], gradGamma2Rows);
            batchInsert('gradient_output_weights', ['idx', 'data'], gradOutWeightRows);
            batchInsert('gradient_output_bias', ['idx', 'data'], gradOutBiasRows);
            batchInsert('gradient_attention_bias', ['idx', 'data'], gradAttBiasRows);
            batchInsert('gradient_attention_weight_matrix', ['idx', 'data'], gradAttMatRows);
            batchInsert('gradient_specialization_weights', ['idx', 'data'], gradSpecRows);

            rows = [];
            for (let idx = 0; idx < ensembleSize; idx++) {
                rows.push([idx, this._cachedAvgVariance[idx] ?? 0]);
            }
            batchInsert('cached_avg_variance', ['idx', 'value'], rows);

            rows = [];
            for (let idx = 0; idx < ensembleSize; idx++) {
                const utils = this._cachedUtilityScores[idx] || new Float32Array(0);
                for (let pidx = 0; pidx < utils.length; pidx++) {
                    if (isValidNumber(utils[pidx])) {
                        rows.push([idx, pidx, utils[pidx]]);
                    }
                }
            }
            batchInsert('cached_utility_scores', ['idx', 'proto_idx', 'value'], rows);

            let attProtoRows = [];
            for (let idx = 0; idx < ensembleSize; idx++) {
                const windows = this._attentionMemory[idx];
                for (let window = 0; window < windows.length; window++) {
                    const entry = windows[window];
                    if (!entry) continue;
                    for (let pidx = 0; pidx < entry.protos.length; pidx++) {
                        const proto = entry.protos[pidx];
                        const meanBuf = Buffer.from(proto.mean.buffer);
                        const varBuf = Buffer.from(proto.variance.buffer);
                        attProtoRows.push([idx, window, pidx, proto.size ?? 0, proto.accessCount ?? 0, proto.isCore ? 1 : 0, proto.importance ?? 0, meanBuf, varBuf, proto.protoId || null, proto.contentHash || null]);
                    }
                }
            }
            batchInsert('attention_memory_protos', ['idx', 'window', 'proto_idx', 'proto_size', 'access_count', 'is_core', 'importance', 'mean_blob', 'variance_blob', 'proto_id', 'content_hash'], attProtoRows);

            let adaptProtoRows = [];
            for (let idx = 0; idx < ensembleSize; idx++) {
                const windows = this._adaptiveContext[idx];
                for (let window = 0; window < windows.length; window++) {
                    const entry = windows[window];
                    if (!entry) continue;
                    for (let pidx = 0; pidx < entry.protos.length; pidx++) {
                        const proto = entry.protos[pidx];
                        const meanBuf = Buffer.from(proto.mean.buffer);
                        const varBuf = Buffer.from(proto.variance.buffer);
                        adaptProtoRows.push([idx, window, pidx, proto.size ?? 0, proto.accessCount ?? 0, proto.isCore ? 1 : 0, proto.importance ?? 0, meanBuf, varBuf, proto.protoId || null, proto.contentHash || null]);
                    }
                }
            }
            batchInsert('adaptive_context_protos', ['idx', 'window', 'proto_idx', 'proto_size', 'access_count', 'is_core', 'importance', 'mean_blob', 'variance_blob', 'proto_id', 'content_hash'], adaptProtoRows);

            let semProtoRows = [];
            for (let idx = 0; idx < ensembleSize; idx++) {
                const protos = this._semanticProtos[idx];
                for (let pidx = 0; pidx < protos.length; pidx++) {
                    const proto = protos[pidx];
                    const meanBuf = Buffer.from(proto.mean.buffer);
                    const varBuf = Buffer.from(proto.variance.buffer);
                    semProtoRows.push([idx, pidx, proto.size ?? 0, proto.accessCount ?? 0, proto.isCore ? 1 : 0, proto.importance ?? 0, meanBuf, varBuf, proto.protoId || null, proto.contentHash || null]);
                }
            }
            batchInsert('semantic_protos', ['idx', 'proto_idx', 'proto_size', 'access_count', 'is_core', 'importance', 'mean_blob', 'variance_blob', 'proto_id', 'content_hash'], semProtoRows);

            let coreProtoRows = [];
            for (let idx = 0; idx < ensembleSize; idx++) {
                const entries = this._coreEpisodic[idx];
                for (let eidx = 0; eidx < entries.length; eidx++) {
                    const entry = entries[eidx];
                    if (!entry) continue;
                    for (let pidx = 0; pidx < entry.protos.length; pidx++) {
                        const proto = entry.protos[pidx];
                        const meanBuf = Buffer.from(proto.mean.buffer);
                        const varBuf = Buffer.from(proto.variance.buffer);
                        coreProtoRows.push([idx, eidx, pidx, proto.size ?? 0, proto.accessCount ?? 0, proto.isCore ? 1 : 0, proto.importance ?? 0, meanBuf, varBuf, proto.protoId || null, proto.contentHash || null]);
                    }
                }
            }
            batchInsert('core_episodic_protos', ['idx', 'entry_idx', 'proto_idx', 'proto_size', 'access_count', 'is_core', 'importance', 'mean_blob', 'variance_blob', 'proto_id', 'content_hash'], coreProtoRows);

            db.exec('COMMIT');

            return { status: true, message: 'State saved successfully!' };
        } catch (error) {
            if (db) db.exec('ROLLBACK');

            // Return the failure (never process.exit): the transaction is
            // already rolled back, so the previous checkpoint stays valid and
            // this step is simply reported as unsaved (ROADMAP P0-1).
            console.error(error.message, error.stack);
            return { status: false, error: error.message, trace: error.stack };
        } finally {
            if (db) db.close();
        }
    }

};
