// HiveMind component: attention
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
import { isValidNumber } from '../utils.js';

export const attentionMethods = {
    _multiHeadAttention (x, layerNum, layer, transformerIdx, training = true, computeIntermediates = false) {
        if (
            !Array.isArray(x) ||
            x.length !== this._inputSize ||
            !x.every(row => Array.isArray(row) && row.length === this._hiddenSize) ||
            !layer || !layer.Wq || !layer.Wk || !layer.Wv || !layer.Wo
        ) {
            return {
                output: Array(this._inputSize).fill().map(() => Array(this._hiddenSize).fill(0)),
                preWoOutput: Array(this._inputSize).fill().map(() => Array(this._hiddenSize).fill(0)),
                Q: Array(this._inputSize).fill().map(() => Array(this._hiddenSize).fill(0)),
                K: Array(this._inputSize).fill().map(() => Array(this._hiddenSize).fill(0)),
                V: Array(this._inputSize).fill().map(() => Array(this._hiddenSize).fill(0)),
                scores: Array(this._numHeads).fill().map(() => Array(this._inputSize).fill().map(() => Array(this._inputSize).fill(0))),
                probs: Array(this._numHeads).fill().map(() => Array(this._inputSize).fill().map(() => Array(this._inputSize).fill(0)))
            };
        }

        const headSize = this._hiddenSize / this._numHeads;
        const sqrtHead = Math.sqrt(headSize);
        const keepProbs = training || computeIntermediates;

        const Q = Array(this._inputSize).fill().map(() => new Array(this._hiddenSize).fill(0));
        const K = Array(this._inputSize).fill().map(() => new Array(this._hiddenSize).fill(0));
        const V = Array(this._inputSize).fill().map(() => new Array(this._hiddenSize).fill(0));

        const specW = this._getSpecWeightMatrix(transformerIdx);

        const Wq = layer.Wq;
        const Wk = layer.Wk;
        const Wv = layer.Wv;

        // Row-major sweep over the weight matrices (Wq[kk][j] over the fast j
        // index) so every access is contiguous, while still summing over kk in
        // strictly increasing order -- arithmetically identical to the previous
        // (i,j,kk) column-major sweep, just cache friendly.
        for (let i = 0; i < this._inputSize; i++) {
            const xRow = x[i];
            const qRow = Q[i];
            const kRow = K[i];
            const vRow = V[i];
            for (let kk = 0; kk < this._hiddenSize; kk++) {
                const xVal = xRow[kk];
                const specRow = specW[kk];
                const wqRow = Wq[kk];
                const wkRow = Wk[kk];
                const wvRow = Wv[kk];
                for (let j = 0; j < this._hiddenSize; j++) {
                    const specWeight = specRow[j];
                    qRow[j] += xVal * wqRow[j] * specWeight;
                    kRow[j] += xVal * wkRow[j] * specWeight;
                    vRow[j] += xVal * wvRow[j] * specWeight;
                }
            }
        }

        this._applyRoPE(Q);
        this._applyRoPE(K);

        // Scores are needed downstream (_pruneMemory), but the softmaxed probs
        // are only ever read when backprop intermediates are requested. During a
        // pure predict we therefore softmax one row at a time into a scratch row
        // and fold it straight into preWoOutput, instead of materializing a
        // numHeads x inputSize x inputSize array of probabilities.
        const attentionScores = new Array(this._numHeads);
        const attentionProbs = keepProbs ? new Array(this._numHeads) : null;
        const preWoOutput = Array(this._inputSize).fill().map(() => new Array(this._hiddenSize).fill(0));
        // During a pure predict the softmaxed row is consumed immediately (folded
        // into preWoOutput) and never stored, so a single reusable buffer replaces
        // ~numHeads*inputSize short-lived arrays per attention call.
        const probScratch = new Array(this._inputSize);

        for (let h = 0; h < this._numHeads; h++) {
            const offset = h * headSize;
            const scoresH = new Array(this._inputSize);
            const probsH = keepProbs ? new Array(this._inputSize) : null;
            for (let i = 0; i < this._inputSize; i++) {
                const qRow = Q[i];
                const scoreRow = new Array(this._inputSize);
                for (let j = 0; j < this._inputSize; j++) {
                    const kRow = K[j];
                    let sum = 0;
                    for (let kk = 0; kk < headSize; kk++) {
                        sum += qRow[offset + kk] * kRow[offset + kk];
                    }
                    scoreRow[j] = sum / sqrtHead;
                }
                scoresH[i] = scoreRow;
                const probRow = this._softmax(scoreRow, keepProbs ? null : probScratch);
                if (keepProbs) probsH[i] = probRow;
                const preRow = preWoOutput[i];
                for (let j = 0; j < this._inputSize; j++) {
                    const p = probRow[j];
                    const vRow = V[j];
                    for (let kk = 0; kk < headSize; kk++) {
                        preRow[offset + kk] += p * vRow[offset + kk];
                    }
                }
            }
            attentionScores[h] = scoresH;
            if (keepProbs) attentionProbs[h] = probsH;
        }

        const finalOutput = Array(this._inputSize).fill().map(() => new Array(this._hiddenSize).fill(0));
        const Wo = layer.Wo;
        for (let i = 0; i < this._inputSize; i++) {
            const preRow = preWoOutput[i];
            const outRow = finalOutput[i];
            for (let kk = 0; kk < this._hiddenSize; kk++) {
                const preVal = preRow[kk];
                const woRow = Wo[kk];
                const specRow = specW[kk];
                for (let j = 0; j < this._hiddenSize; j++) {
                    outRow[j] += preVal * woRow[j] * specRow[j];
                }
            }
        }

        this._updateMemoryBanks(finalOutput, attentionScores, transformerIdx, training, layerNum);

        return {
            output: finalOutput,
            preWoOutput,
            Q,
            K,
            V,
            scores: attentionScores,
            probs: attentionProbs
        };
    },

    _contextAwareAttention (inputs, transformerIdx) {
        if (
            !Array.isArray(inputs) ||
            inputs.length !== this._inputSize
        ) {
            return Array(this._inputSize).fill().map(() => Array(this._hiddenSize).fill(0));
        }

        const perf = Math.max(0, Math.min(1, this._performanceScores[transformerIdx] || 0.5));
        const specScore = this._specializationScores[transformerIdx] || 0.5;

        // The per-(kk,j) specialization gate is independent of the sequence
        // position, the hop and the transformer batch, yet was being recomputed
        // for every element of every projection -- tens of millions of
        // min/max/clamp calls per predict. Materialize it once per call.
        const specW = this._getSpecWeightMatrix(transformerIdx);

        const rawComponent = Array(this._inputSize).fill().map(() => new Array(this._hiddenSize));
        for (let i = 0; i < this._inputSize; i++) {
            const specRow = specW[i % this._hiddenSize];
            const inputVal = inputs[i] * (1 + this._swarmIntelligenceFactor);
            const row = rawComponent[i];
            for (let j = 0; j < this._hiddenSize; j++) {
                row[j] = inputVal * specRow[j];
            }
        }

        const threshMultiplier = 0.75 + 0.5 * perf;
        const dynamicRawThreshFactor = 4.0 * threshMultiplier;
        const maxAddMultiplier = 1.0 + 1.0 * (1 - perf);
        const dynamicRawMaxAdd = Math.round(this._rawMaxProtos * maxAddMultiplier);

        const currentProtos = this._poolMultiPrototype(rawComponent, dynamicRawMaxAdd, dynamicRawThreshFactor);

        if (currentProtos.length > Math.round(this._rawMaxProtos * this._tempOverloadFactor)) {
            this._sortByUtilityDescInPlace(currentProtos);
            currentProtos.length = Math.round(this._rawMaxProtos * this._tempOverloadFactor);
        }

        if (currentProtos.length === 0) {
            return rawComponent;
        }

        const longTermMemoryLength = this._attentionMemory[transformerIdx].length;
        const shortTermMemoryLength = this._adaptiveContext[transformerIdx].length;
        const fillFactor = (longTermMemoryLength / this._contextWindow + shortTermMemoryLength / this._adaptiveWindow) / 2;

        const dynamicRetrieve = Math.round(this._maxRetrievedProtos * (1 + fillFactor));

        const selectedProtos = this._retrieveTopRelevantProtos(transformerIdx, currentProtos, dynamicRetrieve);

        if (selectedProtos.length === 0) {
            return rawComponent;
        }

        const protoMeans = selectedProtos.map(p => p.mean);
        const protoSizes = selectedProtos.map(p => p.size);

        const pastLen = protoMeans.length;

        const transformer = this._transformers[transformerIdx];
        let { avgWq, avgWk, avgWv, avgWo } = transformer.cachedAvgWeights || this._cacheAverageWeights(transformerIdx);

        // Fold the specialization gate into the averaged weights once, so the
        // per-hop projection inner loops do a single multiply per element.
        const wqS = Array(this._hiddenSize).fill().map(() => new Float64Array(this._hiddenSize));
        const wkS = Array(this._hiddenSize).fill().map(() => new Float64Array(this._hiddenSize));
        const wvS = Array(this._hiddenSize).fill().map(() => new Float64Array(this._hiddenSize));
        const woS = Array(this._hiddenSize).fill().map(() => new Float64Array(this._hiddenSize));
        for (let kk = 0; kk < this._hiddenSize; kk++) {
            const specRow = specW[kk];
            for (let j = 0; j < this._hiddenSize; j++) {
                const s = specRow[j];
                wqS[kk][j] = avgWq[kk][j] * s;
                wkS[kk][j] = avgWk[kk][j] * s;
                wvS[kk][j] = avgWv[kk][j] * s;
                woS[kk][j] = avgWo[kk][j] * s;
            }
        }

        const headSize = this._hiddenSize / this._numHeads;
        const invSqrtHead = 1 / Math.sqrt(headSize);

        const K = Array(pastLen).fill().map(() => new Float64Array(this._hiddenSize));
        const V = Array(pastLen).fill().map(() => new Float64Array(this._hiddenSize));

        for (let pj = 0; pj < pastLen; pj++) {
            const mean = protoMeans[pj];
            const kRow = K[pj];
            const vRow = V[pj];
            for (let kk = 0; kk < this._hiddenSize; kk++) {
                const mVal = mean[kk];
                const wkRow = wkS[kk];
                const wvRow = wvS[kk];
                for (let j = 0; j < this._hiddenSize; j++) {
                    kRow[j] += mVal * wkRow[j];
                    vRow[j] += mVal * wvRow[j];
                }
            }
        }

        this._applyRoPE(K, 0);

        let globalDiversity = 0;
        if (pastLen > 8) {
            const numSamples = Math.min(16, pastLen);
            const sampleIndices = Array.from({length: numSamples}, () => Math.floor(Math.random() * pastLen));
            const centroid = Array(this._hiddenSize).fill(0);
            for (const si of sampleIndices) {
                for (let j = 0; j < this._hiddenSize; j++) {
                    centroid[j] += protoMeans[si][j];
                }
            }
            for (let j = 0; j < this._hiddenSize; j++) centroid[j] /= numSamples;

            for (const si of sampleIndices) {
                globalDiversity += 1 - this._cosineSimilarity(protoMeans[si], centroid);
            }
            globalDiversity /= numSamples;
        }
        const diversityScore = Math.tanh(globalDiversity * 6);

        // `rawComponent` is this call's own freshly allocated scratch buffer
        // (never aliased with `inputs`), and its values are only ever read
        // through here, so the previous defensive deep-copy was pure
        // allocation overhead.
        const augmented = rawComponent;
        const baseHops = Math.round(2 + (2 + 3 * this._memoryFactor) * fillFactor);
        const maxHops = Math.max(baseHops, Math.round(selectedProtos.length * 0.5 * this._memoryFactor));

        // Scratch buffers reused across hops to avoid per-hop allocations.
        const Q = Array(this._inputSize).fill().map(() => new Float64Array(this._hiddenSize));
        const preWoOutput = Array(this._inputSize).fill().map(() => new Float64Array(this._hiddenSize));
        const retrieved = Array(this._inputSize).fill().map(() => new Float64Array(this._hiddenSize));
        const scores = new Float64Array(pastLen);
        const expScores = new Float64Array(pastLen);

        for (let hop = 0; hop < maxHops; hop++) {
            for (let seqi = 0; seqi < this._inputSize; seqi++) {
                const augRow = augmented[seqi];
                const qRow = Q[seqi];
                qRow.fill(0);
                for (let kk = 0; kk < this._hiddenSize; kk++) {
                    const aVal = augRow[kk];
                    const wqRow = wqS[kk];
                    for (let j = 0; j < this._hiddenSize; j++) {
                        qRow[j] += aVal * wqRow[j];
                    }
                }
            }

            this._applyRoPE(Q, pastLen);

            let totalEntropy = 0;
            let queryCount = 0;

            for (let i = 0; i < this._inputSize; i++) preWoOutput[i].fill(0);

            for (let h = 0; h < this._numHeads; h++) {
                const offset = h * headSize;
                for (let i = 0; i < this._inputSize; i++) {
                    const qRow = Q[i];
                    let maxScore = -Infinity;
                    for (let pj = 0; pj < pastLen; pj++) {
                        const kRow = K[pj];
                        let sum = 0;
                        for (let kk = 0; kk < headSize; kk++) {
                            sum += qRow[offset + kk] * kRow[offset + kk];
                        }
                        const score = sum * invSqrtHead;
                        scores[pj] = score;
                        if (score > maxScore) maxScore = score;
                    }

                    let sumExp = 0;
                    for (let pj = 0; pj < pastLen; pj++) {
                        const e = Math.exp(scores[pj] - maxScore);
                        expScores[pj] = e;
                        sumExp += e;
                    }
                    if (sumExp === 0) sumExp = 1;

                    let headEntropy = 0;
                    let sumP = 0;
                    const preRow = preWoOutput[i];
                    for (let pj = 0; pj < pastLen; pj++) {
                        const p = expScores[pj] / sumExp;
                        if (p > 1e-6) {
                            headEntropy -= p * Math.log(p);
                            sumP += p;
                        }
                        if (p > 0) {
                            const vRow = V[pj];
                            const pScaled = p * protoSizes[pj];
                            for (let kk = 0; kk < headSize; kk++) {
                                preRow[offset + kk] += pScaled * vRow[offset + kk];
                            }
                        }
                    }

                    if (sumP > 0.1) {
                        totalEntropy += headEntropy;
                        queryCount++;
                    }
                }
            }

            const logPast = Math.log(pastLen + 1);
            const avgEntropy = queryCount > 0 ? totalEntropy / queryCount : logPast;
            const attentionSharpness = Math.exp(-avgEntropy / logPast);

            const gate = (3.0 + this._memoryFactor) * attentionSharpness + (1.5 + this._memoryFactor) * fillFactor +
                (1.5 + 0.5 * this._protoCapacityFactor) * perf + (1.5 + this._memoryFactor) * diversityScore;
            const retrievedRatio = 1 / (1 + Math.exp(-gate));

            for (let i = 0; i < this._inputSize; i++) {
                const preRow = preWoOutput[i];
                const retRow = retrieved[i];
                retRow.fill(0);
                for (let kk = 0; kk < this._hiddenSize; kk++) {
                    const pVal = preRow[kk];
                    const woRow = woS[kk];
                    for (let j = 0; j < this._hiddenSize; j++) {
                        retRow[j] += pVal * woRow[j];
                    }
                }
            }

            const keepWeight = 1 - retrievedRatio;
            let maxDiff = 0;
            let maxVal = 0;
            for (let i = 0; i < this._inputSize; i++) {
                const augRow = augmented[i];
                const retRow = retrieved[i];
                for (let j = 0; j < this._hiddenSize; j++) {
                    const old = augRow[j];
                    const next = old * keepWeight + retRow[j] * retrievedRatio;
                    augRow[j] = next;

                    const diff = next - old;
                    const absDiff = diff < 0 ? -diff : diff;
                    if (absDiff > maxDiff) maxDiff = absDiff;
                    const absVal = next < 0 ? -next : next;
                    if (absVal > maxVal) maxVal = absVal;
                }
            }

            // The augmentation is a fixed-point update; once it stops moving the
            // remaining hops would only repeat identical work.
            if (maxDiff <= 1e-6 * (1 + maxVal)) {
                break;
            }

            if (hop >= 2 && attentionSharpness > 0.65 + 0.25 * perf) {
                break;
            }
            if (hop >= 3 && retrievedRatio < 0.05) {
                break;
            }
            if (hop >= 5 && retrievedRatio < 0.1) {
                break;
            }
        }

        return augmented;
    },

    _computeAttentionWeights (inputs) {
        if (
            !Array.isArray(inputs) ||
            inputs.length !== this._inputSize ||
            !inputs.every(isValidNumber)
        ) {
            this._ensembleWeights = Array(this._ensembleSize).fill(1 / this._ensembleSize);
            this._normalizeEnsembleWeights();
            return;
        }

        const attentionScores = Array(this._ensembleSize).fill(0);

        const maxConsiderChunks = this._contextWindow;

        // Reused score/probability rows for the per-(member, position) softmax
        // below. That loop runs ensembleSize*inputSize times per call and used to
        // allocate two short-lived arrays each iteration; both buffers are plain
        // Arrays whose `length` is pinned to considerLen before every use, so
        // _softmax sees exactly the elements the original `innerSums.map(...)`
        // produced (same multiply-add order, so the values are bit-identical).
        let attnScoreScratch = this._attnWeightScoreScratch;
        let attnProbScratch = this._attnWeightProbScratch;
        if (!attnScoreScratch || attnScoreScratch.length < maxConsiderChunks) {
            attnScoreScratch = this._attnWeightScoreScratch = new Array(maxConsiderChunks);
            attnProbScratch = this._attnWeightProbScratch = new Array(maxConsiderChunks);
        }

        for (let t = 0; t < this._ensembleSize; t++) {
            const memChunks = this._attentionMemory[t];
            const memLen = memChunks.length;

            let considerLen = 0;
            let consideredChunks = [];

            if (memLen > 0) {
                considerLen = Math.min(maxConsiderChunks, memLen);
                const startIdx = memLen - considerLen;
                consideredChunks = memChunks.slice(startIdx);
            }

            if (considerLen === 0) {
                attentionScores[t] = 0;
                continue;
            }

            const pooledMemory = consideredChunks.map(chunkProtos => {
                if (!Array.isArray(chunkProtos) || chunkProtos.length === 0) {
                    return Array(this._hiddenSize).fill(0);
                }
                return this._weightedMean(chunkProtos);
            });

            const keys = pooledMemory.map(pool =>
                pool.map((v, k) =>
                    isValidNumber(v) && isValidNumber(this._attentionWeightMatrix[t][k])
                        ? v * this._attentionWeightMatrix[t][k]
                        : 0
                )
            );

            const innerSums = Array(considerLen).fill(0);
            for (let j = 0; j < considerLen; j++) {
                let sum = 0;
                for (let k = 0; k < this._hiddenSize; k++) {
                    if (isValidNumber(this._attentionWeightMatrix[t][k]) && isValidNumber(keys[j][k])) {
                        sum += this._attentionWeightMatrix[t][k] * keys[j][k];
                    }
                }
                innerSums[j] = sum;
            }

            const biasSum = this._attentionBias[t].reduce((s, val) => s + (isValidNumber(val) ? val : 0), 0);
            const avgBias = this._hiddenSize > 0 ? biasSum / this._hiddenSize : 0;

            let score = 0;
            const scale = 1 / Math.sqrt(this._hiddenSize);

            for (let i = 0; i < this._inputSize; i++) {
                const inputVal = inputs[i];
                if (!isValidNumber(inputVal)) continue;

                attnScoreScratch.length = considerLen;
                for (let j = 0; j < considerLen; j++) {
                    attnScoreScratch[j] = inputVal * innerSums[j] * scale + avgBias;
                }

                const attentionWeights = this._softmax(attnScoreScratch, attnProbScratch);

                for (let j = 0; j < considerLen; j++) {
                    if (!isValidNumber(attentionWeights[j])) continue;
                    for (let k = 0; k < this._hiddenSize; k++) {
                        if (isValidNumber(keys[j][k])) {
                            score += attentionWeights[j] * keys[j][k];
                        }
                    }
                }
            }

            score /= this._inputSize;

            const performanceScore = isValidNumber(this._performanceScores[t]) ? this._performanceScores[t] : 0.5;
            const specializationBoost = 1 + (isValidNumber(this._specializationScores[t])
                ? this._specializationScores[t] * this._swarmIntelligenceFactor
                : 0);

            attentionScores[t] = score * (0.7 + 0.2 * performanceScore + 0.1 * specializationBoost);
        }

        const weights = this._softmax(attentionScores);

        const finalWeights = weights.map((w, idx) => {
            const performanceScore = isValidNumber(this._performanceScores[idx]) ? this._performanceScores[idx] : 0.5;
            const specializationFactor = 1 + (isValidNumber(this._specializationScores[idx])
                ? this._specializationScores[idx] * this._swarmIntelligenceFactor
                : 0);
            const weight = 0.6 * w + 0.3 * performanceScore + 0.1 * specializationFactor;
            return isValidNumber(weight) && weight >= 0 ? weight : 1 / this._ensembleSize;
        });

        const sum = finalWeights.reduce((s, w) => s + (isValidNumber(w) && w >= 0 ? w : 0), 0);
        if (sum <= 1e-6) {
            this._ensembleWeights = Array(this._ensembleSize).fill(1 / this._ensembleSize);
        } else {
            this._ensembleWeights = finalWeights.map(w => (isValidNumber(w) && w >= 0 ? w / sum : 1 / this._ensembleSize));
        }

        this._normalizeEnsembleWeights();
    },

    _cacheAverageWeights (transformerIdx) {
        const transformer = this._transformers[transformerIdx];
        const numLayers = this._numLayers;

        const avgWq = Array(this._hiddenSize).fill().map(() => Array(this._hiddenSize).fill(0));
        const avgWk = Array(this._hiddenSize).fill().map(() => Array(this._hiddenSize).fill(0));
        const avgWv = Array(this._hiddenSize).fill().map(() => Array(this._hiddenSize).fill(0));
        const avgWo = Array(this._hiddenSize).fill().map(() => Array(this._hiddenSize).fill(0));

        const scale = 1.0 / numLayers;
        for (let l = 0; l < numLayers; l++) {
            const att = transformer.attentionWeights[l];
            for (let ii = 0; ii < this._hiddenSize; ii++) {
                for (let jj = 0; jj < this._hiddenSize; jj++) {
                    avgWq[ii][jj] += att.Wq[ii][jj] * scale;
                    avgWk[ii][jj] += att.Wk[ii][jj] * scale;
                    avgWv[ii][jj] += att.Wv[ii][jj] * scale;
                    avgWo[ii][jj] += att.Wo[ii][jj] * scale;
                }
            }
        }

        transformer.cachedAvgWeights = { avgWq, avgWk, avgWv, avgWo };
        return transformer.cachedAvgWeights;
    }

};
