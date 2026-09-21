// HiveMind component: distillation
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
import { isValidNumber } from '../utils.js';

export const distillationMethods = {
    _distillKnowledge (outputs, attentionIntermediatesAll, activationsAll, layerOutputsAll) {
        if (
            !Array.isArray(outputs) ||
            outputs.length !== this._ensembleSize ||
            !outputs.every(isValidNumber) ||
            attentionIntermediatesAll.length !== this._ensembleSize ||
            activationsAll.length !== this._ensembleSize ||
            layerOutputsAll.length !== this._ensembleSize
        ) {
            return;
        }

        const sortedIndices = this._performanceScores
            .map((score, idx) => ({ score: isValidNumber(score) ? score : 0, idx }))
            .sort((a, b) => b.score - a.score);

        const topTierCount = Math.max(1, Math.floor(this._ensembleSize * 0.30));
        const middleTierEnd = topTierCount + Math.floor(this._ensembleSize * 0.40);
        const topPerformers = sortedIndices.slice(0, topTierCount).map(({ idx }) => idx);

        const topOutputs = topPerformers.map(idx => outputs[idx]);
        const topWeights = topPerformers.map(idx => this._ensembleWeights[idx]);
        const weightSum = topWeights.reduce((sum, w) => sum + (isValidNumber(w) ? w : 0), 0) || 1;
        const teacherLogit = topOutputs.reduce((sum, output, i) =>
            sum + output * (topWeights[i] / weightSum), 0
        );

        const varianceTop = topOutputs.reduce((sum, out) => sum + Math.pow(out - teacherLogit, 2), 0) / topOutputs.length;
        const stdTopOutputs = Math.sqrt(varianceTop + 1e-8);

        const temperature = 2.0;
        const momentum = 0.9;
        const outputKdScale = 0.2;

        this._transformers.forEach((transformer, idx) => {
            if (topPerformers.includes(idx)) return;

            const rank = sortedIndices.findIndex(entry => entry.idx === idx);
            const isMiddleTier = rank >= topTierCount && rank < middleTierEnd;
            const isBottomTier = rank >= middleTierEnd;

            const kdStrengthMultiplier = isMiddleTier ? 1.0 : 0.7;

            const diversityScore = Math.min(1, Math.abs(outputs[idx] - teacherLogit) / (stdTopOutputs || 1));
            const performanceGap = this._performanceScores[topPerformers[0]] - this._performanceScores[idx];

            let klWeight = Math.min(1.0, Math.max(0.1, performanceGap / (this._performanceScores[topPerformers[0]] || 1)));
            klWeight *= (1 - diversityScore);
            klWeight *= kdStrengthMultiplier;
            klWeight = Math.min(1.0, klWeight);

            const studentLogit = outputs[idx];
            const studentProb = this._sigmoid(studentLogit / temperature);
            const teacherProb = this._sigmoid(teacherLogit / temperature);

            let baseGrad = (studentProb - teacherProb) / temperature;
            baseGrad *= klWeight;
            if (!isValidNumber(baseGrad)) baseGrad = 0;

            const adjustedLearningRate = this._adaptiveLearningRate[idx];

            const finalX = layerOutputsAll[idx][this._numLayers];
            let pooled = Array(this._hiddenSize).fill(0);
            let validCount = 0;
            for (let pos = 0; pos < this._inputSize; pos++) {
                let posHidden = finalX[pos];
                if (this._numLayers > 0) {
                    const lastLayerIdx = this._numLayers - 1;
                    posHidden = this._rmsNorm(posHidden, transformer.layerNormWeights[lastLayerIdx].gamma2);
                }
                for (let j = 0; j < this._hiddenSize; j++) {
                    if (isValidNumber(posHidden[j])) {
                        pooled[j] += posHidden[j];
                    }
                }
                validCount++;
            }
            if (validCount > 0) {
                pooled = pooled.map(v => v / validCount);
            }

            const kd_dL = baseGrad * outputKdScale;
            for (let i = 0; i < this._hiddenSize; i++) {
                if (isValidNumber(pooled[i])) {
                    const update = kd_dL * pooled[i] * adjustedLearningRate;
                    this._gradientAccumulation[idx].outputWeights[i][0] += (1 - momentum) * update;
                }
            }
            this._gradientAccumulation[idx].outputBias[0] += (1 - momentum) * kd_dL * adjustedLearningRate;

            if (!isBottomTier) return;

            let gradPooled = Array(this._hiddenSize).fill(0);
            for (let i = 0; i < this._hiddenSize; i++) {
                if (isValidNumber(transformer.outputWeights[i][0])) {
                    gradPooled[i] = kd_dL * transformer.outputWeights[i][0];
                }
            }

            let grad = Array(this._inputSize).fill().map(() => Array(this._hiddenSize).fill(0));
            if (this._numLayers > 0) {
                const lastLayerIdx = this._numLayers - 1;
                const gamma = transformer.layerNormWeights[lastLayerIdx].gamma2;
                for (let pos = 0; pos < this._inputSize; pos++) {
                    const x = finalX[pos];
                    const sq_sum = x.reduce((s, v) => s + v * v, 0);
                    const rms = Math.sqrt(sq_sum / this._hiddenSize + 1e-6);
                    const norm_x = x.map(v => v / rms);

                    const incoming = gradPooled.map(g => g / validCount);

                    const d_gamma = incoming.map((g, i) => g * norm_x[i]);
                    for (let j = 0; j < this._hiddenSize; j++) {
                        if (isValidNumber(d_gamma[j])) {
                            const update = d_gamma[j] * adjustedLearningRate * 0.5;
                            this._gradientAccumulation[idx].layerNormWeights[lastLayerIdx].gamma2[j] += (1 - momentum) * update;
                        }
                    }

                    const d_norm = incoming.map((g, i) => g * gamma[i]);
                    const dot = d_norm.reduce((s, dn, i) => s + dn * norm_x[i], 0);
                    const d_x = d_norm.map((dn, i) => dn / rms - norm_x[i] * dot / (this._hiddenSize + 1e-8));
                    grad[pos] = d_x;
                }
            } else {
                for (let pos = 0; pos < this._inputSize; pos++) {
                    grad[pos] = gradPooled.map(g => g / validCount);
                }
            }

            for (let layer = this._numLayers - 1; layer >= 0; layer--) {
                const act = activationsAll[idx][layer];
                const inter = attentionIntermediatesAll[idx][layer];
                const headSize = this._hiddenSize / this._numHeads;

                let gradToAttentionResidual = grad.map(row => row.slice());

                for (let pos = 0; pos < this._inputSize; pos++) {
                    const x = act.normAttention[pos];

                    const gate = Array(this._feedForwardSize).fill(0);
                    const up = Array(this._feedForwardSize).fill(0);
                    for (let i = 0; i < this._hiddenSize; i++) {
                        for (let j = 0; j < this._feedForwardSize; j++) {
                            const specWeight = isValidNumber(this._specializationWeights[idx][i % this._hiddenSize][j % this._hiddenSize])
                                ? Math.min(Math.max(1 + this._specializationScores[idx] * this._specializationWeights[idx][i % this._hiddenSize][j % this._hiddenSize], 0.5), 1.5)
                                : 1;
                            gate[j] += isValidNumber(x[i]) && isValidNumber(transformer.ffnWeights[layer].gate_proj[i][j])
                                ? x[i] * transformer.ffnWeights[layer].gate_proj[i][j] * specWeight
                                : 0;
                            up[j] += isValidNumber(x[i]) && isValidNumber(transformer.ffnWeights[layer].up_proj[i][j])
                                ? x[i] * transformer.ffnWeights[layer].up_proj[i][j] * specWeight
                                : 0;
                        }
                    }
                    const silu_gate = gate.map(this._silu);
                    const activated = silu_gate.map((s, j) => s * up[j]);

                    const incoming = grad[pos];

                    for (let j = 0; j < this._feedForwardSize; j++) {
                        for (let k = 0; k < this._hiddenSize; k++) {
                            const specWeight = isValidNumber(this._specializationWeights[idx][k % this._hiddenSize][j % this._hiddenSize])
                                ? Math.min(Math.max(1 + this._specializationScores[idx] * this._specializationWeights[idx][k % this._hiddenSize][j % this._hiddenSize], 0.5), 1.5)
                                : 1;
                            const update = incoming[k] * activated[j] * specWeight * adjustedLearningRate;
                            if (isValidNumber(update)) {
                                this._gradientAccumulation[idx].ffnWeights[layer].down_proj[j][k] += (1 - momentum) * update;
                            }
                        }
                    }

                    const d_activated = Array(this._feedForwardSize).fill(0);
                    for (let j = 0; j < this._feedForwardSize; j++) {
                        for (let k = 0; k < this._hiddenSize; k++) {
                            const specWeight = isValidNumber(this._specializationWeights[idx][k % this._hiddenSize][j % this._hiddenSize])
                                ? Math.min(Math.max(1 + this._specializationScores[idx] * this._specializationWeights[idx][k % this._hiddenSize][j % this._hiddenSize], 0.5), 1.5)
                                : 1;
                            d_activated[j] += incoming[k] * transformer.ffnWeights[layer].down_proj[j][k] * specWeight;
                        }
                    }
                    const d_silu = d_activated.map((d, j) => d * up[j]);
                    const d_up = d_activated.map((d, j) => d * silu_gate[j]);
                    const d_gate = d_silu.map((d, j) => d * this._siluDerivative(gate[j]));

                    for (let i = 0; i < this._hiddenSize; i++) {
                        for (let j = 0; j < this._feedForwardSize; j++) {
                            const specWeight = isValidNumber(this._specializationWeights[idx][i % this._hiddenSize][j % this._hiddenSize])
                                ? Math.min(Math.max(1 + this._specializationScores[idx] * this._specializationWeights[idx][i % this._hiddenSize][j % this._hiddenSize], 0.5), 1.5)
                                : 1;
                            const gateUpdate = d_gate[j] * x[i] * specWeight * adjustedLearningRate;
                            if (isValidNumber(gateUpdate)) {
                                this._gradientAccumulation[idx].ffnWeights[layer].gate_proj[i][j] += (1 - momentum) * gateUpdate;
                            }
                            const upUpdate = d_up[j] * x[i] * specWeight * adjustedLearningRate;
                            if (isValidNumber(upUpdate)) {
                                this._gradientAccumulation[idx].ffnWeights[layer].up_proj[i][j] += (1 - momentum) * upUpdate;
                            }
                        }
                    }

                    let d_normAttention = Array(this._hiddenSize).fill(0);
                    for (let i = 0; i < this._hiddenSize; i++) {
                        for (let j = 0; j < this._feedForwardSize; j++) {
                            const specWeight = isValidNumber(this._specializationWeights[idx][i % this._hiddenSize][j % this._hiddenSize])
                                ? Math.min(Math.max(1 + this._specializationScores[idx] * this._specializationWeights[idx][i % this._hiddenSize][j % this._hiddenSize], 0.5), 1.5)
                                : 1;
                            d_normAttention[i] += d_gate[j] * transformer.ffnWeights[layer].gate_proj[i][j] * specWeight +
                                                  d_up[j] * transformer.ffnWeights[layer].up_proj[i][j] * specWeight;
                        }
                    }

                    const gamma2 = transformer.layerNormWeights[layer].gamma2;
                    const sq_sum2 = x.reduce((s, v) => s + v * v, 0);
                    const rms2 = Math.sqrt(sq_sum2 / this._hiddenSize + 1e-6);
                    const norm_x2 = x.map(v => v / rms2);
                    const d_gamma2 = d_normAttention.map((g, i) => g * norm_x2[i]);
                    for (let j = 0; j < this._hiddenSize; j++) {
                        if (isValidNumber(d_gamma2[j])) {
                            const update = d_gamma2[j] * adjustedLearningRate * 0.5;
                            this._gradientAccumulation[idx].layerNormWeights[layer].gamma2[j] += (1 - momentum) * update;
                        }
                    }
                    const d_norm2 = d_normAttention.map((g, i) => g * gamma2[i]);
                    const dot2 = d_norm2.reduce((s, dn, i) => s + dn * norm_x2[i], 0);
                    const d_branch = d_norm2.map((dn, i) => dn / rms2 - norm_x2[i] * dot2 / (this._hiddenSize + 1e-8));

                    for (let j = 0; j < this._hiddenSize; j++) {
                        gradToAttentionResidual[pos][j] += d_branch[j];
                    }
                }

                const gradAttentionOutput = gradToAttentionResidual;

                for (let pos = 0; pos < this._inputSize; pos++) {
                    for (let outDim = 0; outDim < this._hiddenSize; outDim++) {
                        for (let preDim = 0; preDim < this._hiddenSize; preDim++) {
                            const specWeight = isValidNumber(this._specializationWeights[idx][preDim % this._hiddenSize][outDim])
                                ? Math.min(Math.max(1 + this._specializationScores[idx] * this._specializationWeights[idx][preDim % this._hiddenSize][outDim], 0.5), 1.5)
                                : 1;
                            const update = gradAttentionOutput[pos][outDim] * inter.preWoOutput[pos][preDim] * specWeight * adjustedLearningRate;
                            if (isValidNumber(update)) {
                                this._gradientAccumulation[idx].attentionWeights[layer].Wo[preDim][outDim] += (1 - momentum) * update;
                            }
                        }
                    }
                }

                let d_preWo = Array(this._inputSize).fill().map(() => Array(this._hiddenSize).fill(0));
                for (let pos = 0; pos < this._inputSize; pos++) {
                    for (let outDim = 0; outDim < this._hiddenSize; outDim++) {
                        for (let preDim = 0; preDim < this._hiddenSize; preDim++) {
                            const specWeight = isValidNumber(this._specializationWeights[idx][preDim % this._hiddenSize][outDim])
                                ? Math.min(Math.max(1 + this._specializationScores[idx] * this._specializationWeights[idx][preDim % this._hiddenSize][outDim], 0.5), 1.5)
                                : 1;
                            d_preWo[pos][preDim] += gradAttentionOutput[pos][outDim] * transformer.attentionWeights[layer].Wo[preDim][outDim] * specWeight;
                        }
                    }
                }

                const d_v = Array(this._numHeads).fill().map(() => Array(this._inputSize).fill().map(() => Array(headSize).fill(0)));
                const d_scores = Array(this._numHeads).fill().map(() => Array(this._inputSize).fill().map(() => Array(this._inputSize).fill(0)));
                for (let pos = 0; pos < this._inputSize; pos++) {
                    for (let h = 0; h < this._numHeads; h++) {
                        const offset = h * headSize;
                        for (let dim = 0; dim < headSize; dim++) {
                            const fullDim = offset + dim;
                            const d_att = d_preWo[pos][fullDim];
                            if (!isValidNumber(d_att)) continue;
                            for (let vPos = 0; vPos < this._inputSize; vPos++) {
                                d_scores[h][pos][vPos] += d_att * inter.V[vPos][fullDim];
                                d_v[h][vPos][dim] += d_att * inter.attentionProbs[h][pos][vPos];
                            }
                        }
                    }
                }

                for (let h = 0; h < this._numHeads; h++) {
                    for (let pos = 0; pos < this._inputSize; pos++) {
                        let weighted = 0;
                        for (let vPos = 0; vPos < this._inputSize; vPos++) {
                            weighted += inter.attentionProbs[h][pos][vPos] * d_scores[h][pos][vPos];
                        }
                        for (let vPos = 0; vPos < this._inputSize; vPos++) {
                            d_scores[h][pos][vPos] = inter.attentionProbs[h][pos][vPos] * (d_scores[h][pos][vPos] - weighted);
                        }
                    }
                }

                const d_q = Array(this._inputSize).fill().map(() => Array(this._hiddenSize).fill(0));
                const d_k = Array(this._inputSize).fill().map(() => Array(this._hiddenSize).fill(0));
                for (let h = 0; h < this._numHeads; h++) {
                    for (let qPos = 0; qPos < this._inputSize; qPos++) {
                        for (let kPos = 0; kPos < this._inputSize; kPos++) {
                            const scaled = d_scores[h][qPos][kPos] / Math.sqrt(headSize);
                            if (!isValidNumber(scaled)) continue;
                            for (let dim = 0; dim < headSize; dim++) {
                                const fullDim = h * headSize + dim;
                                d_q[qPos][fullDim] += scaled * inter.K[kPos][fullDim];
                                d_k[kPos][fullDim] += scaled * inter.Q[qPos][fullDim];
                            }
                        }
                    }
                }

                let gradNormX = Array(this._inputSize).fill().map(() => Array(this._hiddenSize).fill(0));
                for (let pos = 0; pos < this._inputSize; pos++) {
                    for (let inDim = 0; inDim < this._hiddenSize; inDim++) {
                        let contribQ = 0, contribK = 0, contribV = 0;
                        for (let outDim = 0; outDim < this._hiddenSize; outDim++) {
                            const specWeight = isValidNumber(this._specializationWeights[idx][inDim % this._hiddenSize][outDim])
                                ? Math.min(Math.max(1 + this._specializationScores[idx] * this._specializationWeights[idx][inDim % this._hiddenSize][outDim], 0.5), 1.5)
                                : 1;
                            contribQ += d_q[pos][outDim] * transformer.attentionWeights[layer].Wq[inDim][outDim] * specWeight;
                            contribK += d_k[pos][outDim] * transformer.attentionWeights[layer].Wk[inDim][outDim] * specWeight;
                            contribV += d_v[Math.floor(outDim / headSize)][pos][outDim % headSize] * transformer.attentionWeights[layer].Wv[inDim][outDim] * specWeight;
                        }
                        gradNormX[pos][inDim] = contribQ + contribK + contribV;
                    }
                }

                for (let inDim = 0; inDim < this._hiddenSize; inDim++) {
                    for (let outDim = 0; outDim < this._hiddenSize; outDim++) {
                        let wqUpdate = 0, wkUpdate = 0, wvUpdate = 0;
                        const specWeight = isValidNumber(this._specializationWeights[idx][inDim % this._hiddenSize][outDim])
                            ? Math.min(Math.max(1 + this._specializationScores[idx] * this._specializationWeights[idx][inDim % this._hiddenSize][outDim], 0.5), 1.5)
                            : 1;
                        for (let pos = 0; pos < this._inputSize; pos++) {
                            wqUpdate += d_q[pos][outDim] * act.normX[pos][inDim];
                            wkUpdate += d_k[pos][outDim] * act.normX[pos][inDim];
                            const h = Math.floor(outDim / headSize);
                            const dim = outDim % headSize;
                            wvUpdate += d_v[h][pos][dim] * act.normX[pos][inDim];
                        }
                        if (isValidNumber(wqUpdate)) this._gradientAccumulation[idx].attentionWeights[layer].Wq[inDim][outDim] += (1 - momentum) * wqUpdate * specWeight * adjustedLearningRate;
                        if (isValidNumber(wkUpdate)) this._gradientAccumulation[idx].attentionWeights[layer].Wk[inDim][outDim] += (1 - momentum) * wkUpdate * specWeight * adjustedLearningRate;
                        if (isValidNumber(wvUpdate)) this._gradientAccumulation[idx].attentionWeights[layer].Wv[inDim][outDim] += (1 - momentum) * wvUpdate * specWeight * adjustedLearningRate;
                    }
                }

                const gamma1 = transformer.layerNormWeights[layer].gamma1;
                for (let pos = 0; pos < this._inputSize; pos++) {
                    const x = act.normX[pos];
                    const sq_sum = x.reduce((s, v) => s + v * v, 0);
                    const rms = Math.sqrt(sq_sum / this._hiddenSize + 1e-6);
                    const norm_x = x.map(v => v / rms);

                    const incoming = gradNormX[pos];
                    const d_gamma = incoming.map((g, i) => g * norm_x[i]);
                    for (let j = 0; j < this._hiddenSize; j++) {
                        if (isValidNumber(d_gamma[j])) {
                            const update = d_gamma[j] * adjustedLearningRate * 0.2;
                            this._gradientAccumulation[idx].layerNormWeights[layer].gamma1[j] += (1 - momentum) * update;
                        }
                    }

                    const d_norm = incoming.map((g, i) => g * gamma1[i]);
                    const dot = d_norm.reduce((s, dn, i) => s + dn * norm_x[i], 0);
                    const d_pre = d_norm.map((dn, i) => dn / rms - norm_x[i] * dot / (this._hiddenSize + 1e-8));

                    for (let j = 0; j < this._hiddenSize; j++) {
                        grad[pos][j] = gradToAttentionResidual[pos][j] + d_pre[j];
                    }
                }
            }
        });
    }

};
