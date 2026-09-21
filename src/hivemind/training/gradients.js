// HiveMind component: gradients
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
import { isValidNumber } from '../utils.js';

export const gradientMethods = {
    _scaleGradientMatrix (gradMatrix, threshold, minScaleFactor, alpha, decay, sparseThreshold, precomputedNorm = null) {
        const spectralNorm = precomputedNorm !== null ? precomputedNorm : this._computeSpectralNorm(gradMatrix);
        if (spectralNorm <= threshold) return;

        const scale = Math.max(minScaleFactor, Math.pow(threshold / spectralNorm, alpha) * decay);
        const quantScale = Math.ceil(scale * 255) / 255;
        for (let i = 0; i < gradMatrix.length; i++) {
            const row = gradMatrix[i];
            for (let j = 0; j < row.length; j++) {
                if (Math.abs(row[j]) > sparseThreshold) {
                    row[j] *= quantScale;
                }
            }
        }
    },

    _scaleGradientVector (gradVector, threshold, minScaleFactor, alpha, decay, sparseThreshold, precomputedNorm = null) {
        const l2Norm = precomputedNorm !== null ? precomputedNorm : this._computeGradientNorm(gradVector, false);
        if (l2Norm <= threshold) return;

        const scale = Math.max(minScaleFactor, Math.pow(threshold / l2Norm, alpha) * decay);
        const quantScale = Math.ceil(scale * 255) / 255;
        for (let i = 0; i < gradVector.length; i++) {
            if (Math.abs(gradVector[i]) > sparseThreshold) {
                gradVector[i] *= quantScale;
            }
        }
    },

    _scaleGradients (idx) {
        const baseAttentionPercentile = 0.95;
        const baseFfnPercentile = 0.9;
        const baseVectorPercentile = 0.8;

        const trustVariance = this._computeVariance(this._trustScoresHistory[idx].slice(-10));
        const lossVariance = this._computeVariance(this._historicalPerformance[idx].slice(-10));
        const stabilityMetric = 0.5 * lossVariance + 0.5 * trustVariance;

        const minScaleFactor = Math.max(0.01, 0.1 / (Math.sqrt(this._ensembleSize) * (1 + stabilityMetric)));

        const emaBetaShort = Math.min(0.95, Math.max(0.8, this._computeKernelRate(this._historicalPerformance[idx])));
        const emaBetaLong = Math.min(0.999, Math.max(0.95, this._computeKernelRate(this._trustScoresHistory[idx])));

        const fractalDim = this._computeFractalDimension(this._historicalPerformance[idx].slice(-10));
        const componentWeights = {
            ensemble: Math.min(0.4, Math.max(0.1, 0.2 * (1 + 0.1 * fractalDim))),
            specialization: Math.min(0.4, Math.max(0.1, 0.2 * (1 + 0.15 * fractalDim * Math.min(this._specializationScores[idx], 10)))),
            trust: Math.min(0.4, Math.max(0.1, 0.2 * (1 - 0.1 * fractalDim))),
            historicalPerformance: Math.min(0.4, Math.max(0.1, 0.2 * (1 + 0.05 * fractalDim))),
            performance: Math.min(0.4, Math.max(0.1, 0.2 * (1 + 0.05 * fractalDim)))
        };
        const totalWeight = Object.values(componentWeights).reduce((sum, w) => sum + w, 0);
        Object.keys(componentWeights).forEach(key => {
            componentWeights[key] /= Math.max(totalWeight, 1e-8);
        });

        const trust_ema = this._computeDualEMA(this._trustScoresHistory[idx], emaBetaShort, emaBetaLong);
        const perf_ema = this._computeDualEMA(this._historicalPerformance[idx], emaBetaShort, emaBetaLong);

        const robustnessFactor = Math.min(0.9, Math.max(0.1, 0.5 + 0.5 * (trust_ema / (Math.abs(trust_ema) + Math.abs(perf_ema) + 1e-10))));
        const compositeScore = (
            this._ensembleWeights[idx] * componentWeights.ensemble +
            this._specializationScores[idx] * componentWeights.specialization +
            trust_ema * componentWeights.trust +
            perf_ema * componentWeights.historicalPerformance +
            this._performanceScores[idx] * componentWeights.performance
        ) * robustnessFactor;

        const totalCompositeScore = this._ensembleWeights.reduce((sum, _, i) => {
            const memberTrustEma = this._computeDualEMA(this._trustScoresHistory[i], emaBetaShort, emaBetaLong);
            const memberPerfEma = this._computeDualEMA(this._historicalPerformance[i], emaBetaShort, emaBetaLong);
            const memberRobustness = Math.min(0.9, Math.max(0.1, 0.5 + 0.5 * (memberTrustEma / (Math.abs(memberTrustEma) + Math.abs(memberPerfEma) + 1e-10))));
            return sum + (
                this._ensembleWeights[i] * componentWeights.ensemble +
                this._specializationScores[i] * componentWeights.specialization +
                memberTrustEma * componentWeights.trust +
                memberPerfEma * componentWeights.historicalPerformance +
                this._performanceScores[i] * componentWeights.performance
            ) * memberRobustness;
        }, 0);

        const normalizedScore = Math.min(1, Math.max(0, 0.8 * (compositeScore / Math.max(totalCompositeScore, 1e-8)) + 0.2 / this._ensembleSize));
        const ntkStability = this._computeNTKStability(this._historicalPerformance[idx].slice(-10), lossVariance);
        const weightFactorMin = 0.5 / (1 + lossVariance);
        const weightFactorMax = 1 + this._ensembleSize / (10 * (1 + lossVariance));
        const weightFactor = Math.min(weightFactorMax, Math.max(weightFactorMin, normalizedScore * this._ensembleSize * ntkStability));

        const sigmoidSlope = 5 / (1 + trustVariance);
        const alpha = Math.min(1, Math.max(0.1, 0.5 + 0.5 * (1 / (1 + Math.exp(sigmoidSlope * trust_ema)) - 0.5)));

        const dynamicK = 4 / (1 + trustVariance);
        const decay = Math.max(0.1, Math.min(1, 1 / (1 + dynamicK * trustVariance)));

        const attentionMatrixNorms = [];
        const ffnMatrixNorms = [];
        const vectorNorms = [];
        const specMatrixNorms = [];

        ffnMatrixNorms.push(this._computeSpectralNorm(this._gradientAccumulation[idx].outputWeights));
        vectorNorms.push(this._computeGradientNorm(this._gradientAccumulation[idx].outputBias, false));

        for (let layer = 0; layer < this._numLayers; layer++) {
            ['Wq', 'Wk', 'Wv', 'Wo'].forEach(key => {
                const gradMatrix = this._gradientAccumulation[idx].attentionWeights[layer][key];
                attentionMatrixNorms.push(this._computeSpectralNorm(gradMatrix));
            });

            ['gate_proj', 'up_proj'].forEach(key => {
                const gradMatrix = this._gradientAccumulation[idx].ffnWeights[layer][key];
                ffnMatrixNorms.push(this._computeSpectralNorm(gradMatrix));
            });
            const downGrad = this._gradientAccumulation[idx].ffnWeights[layer].down_proj;
            ffnMatrixNorms.push(this._computeSpectralNorm(downGrad));

            vectorNorms.push(this._computeGradientNorm(this._gradientAccumulation[idx].layerNormWeights[layer].gamma1, false));
            vectorNorms.push(this._computeGradientNorm(this._gradientAccumulation[idx].layerNormWeights[layer].gamma2, false));
        }

        vectorNorms.push(this._computeGradientNorm(this._gradientAccumulation[idx].attentionBias, false));
        vectorNorms.push(this._computeGradientNorm(this._gradientAccumulation[idx].attentionWeightMatrix, false));

        specMatrixNorms.push(this._computeSpectralNorm(this._gradientAccumulation[idx].specializationWeights));

        const sparseThreshold = this._computeSparseThreshold([...attentionMatrixNorms, ...ffnMatrixNorms, ...vectorNorms, ...specMatrixNorms]);

        const attentionPercentile = this._computeDynamicPercentile(attentionMatrixNorms, baseAttentionPercentile);
        const ffnPercentile = this._computeDynamicPercentile(ffnMatrixNorms, baseFfnPercentile);
        const vectorPercentile = this._computeDynamicPercentile(vectorNorms, baseVectorPercentile);
        const specPercentile = this._computeDynamicPercentile(specMatrixNorms, baseAttentionPercentile);

        const attentionMatrixThreshold = Math.min(this._computePercentile(attentionMatrixNorms, attentionPercentile), 1.0) * weightFactor;
        const ffnMatrixThreshold = Math.min(this._computePercentile(ffnMatrixNorms, ffnPercentile), 1.0) * weightFactor;
        const vectorThreshold = Math.min(this._computePercentile(vectorNorms, vectorPercentile), 1.0) * weightFactor;
        const specMatrixThreshold = Math.min(this._computePercentile(specMatrixNorms, specPercentile), 1.0) * weightFactor;

        let ffnNormIdx = 0;
        let vectorNormIdx = 0;

        this._scaleGradientMatrix(this._gradientAccumulation[idx].outputWeights, ffnMatrixThreshold, minScaleFactor, alpha, decay, sparseThreshold, ffnMatrixNorms[ffnNormIdx++]);
        this._scaleGradientVector(this._gradientAccumulation[idx].outputBias, vectorThreshold, minScaleFactor, alpha, decay, sparseThreshold, vectorNorms[vectorNormIdx++]);

        for (let layer = 0; layer < this._numLayers; layer++) {
            ['Wq', 'Wk', 'Wv', 'Wo'].forEach((key, keyIdx) => {
                this._scaleGradientMatrix(this._gradientAccumulation[idx].attentionWeights[layer][key], attentionMatrixThreshold, minScaleFactor, alpha, decay, sparseThreshold, attentionMatrixNorms[layer * 4 + keyIdx]);
            });

            ['gate_proj', 'up_proj'].forEach(key => {
                this._scaleGradientMatrix(this._gradientAccumulation[idx].ffnWeights[layer][key], ffnMatrixThreshold, minScaleFactor, alpha, decay, sparseThreshold, ffnMatrixNorms[ffnNormIdx++]);
            });
            this._scaleGradientMatrix(this._gradientAccumulation[idx].ffnWeights[layer].down_proj, ffnMatrixThreshold, minScaleFactor, alpha, decay, sparseThreshold, ffnMatrixNorms[ffnNormIdx++]);

            this._scaleGradientVector(this._gradientAccumulation[idx].layerNormWeights[layer].gamma1, vectorThreshold, minScaleFactor, alpha, decay, sparseThreshold, vectorNorms[vectorNormIdx++]);
            this._scaleGradientVector(this._gradientAccumulation[idx].layerNormWeights[layer].gamma2, vectorThreshold, minScaleFactor, alpha, decay, sparseThreshold, vectorNorms[vectorNormIdx++]);
        }

        this._scaleGradientVector(this._gradientAccumulation[idx].attentionBias, vectorThreshold, minScaleFactor, alpha, decay, sparseThreshold, vectorNorms[vectorNormIdx++]);
        this._scaleGradientVector(this._gradientAccumulation[idx].attentionWeightMatrix, vectorThreshold, minScaleFactor, alpha, decay, sparseThreshold, vectorNorms[vectorNormIdx++]);
        this._scaleGradientMatrix(this._gradientAccumulation[idx].specializationWeights, specMatrixThreshold, minScaleFactor, alpha, decay, sparseThreshold, specMatrixNorms[0]);
    },

    _accumulateGradients (inputs, outputs, target, probability, layerOutputs, activations, attentionIntermediates, sampleWeight = 1) {
        const H = this._hiddenSize;
        const IS = this._inputSize;
        const FF = this._feedForwardSize;
        const NH = this._numHeads;
        const headSize = H / NH;
        const sqrtHeadSize = Math.sqrt(headSize);
        const sqrtH = Math.sqrt(H);
        // `sampleWeight` is the average uniqueness of this observation (Lopez de
        // Prado ch. 4, see training/sample_weights.js); every accumulated term is
        // linear in this gradient, so the weight scales the whole step. It is a
        // bit-exact no-op at the default 1.
        const dL_dLogit = (probability - target) * sampleWeight;

        let fsc = this._accFfnScratch;
        if (!fsc || fsc.H !== H || fsc.FF !== FF) {
            fsc = this._accFfnScratch = {
                H, FF,
                gate: new Float64Array(FF), up: new Float64Array(FF),
                siluGate: new Float64Array(FF), activated: new Float64Array(FF),
                dActivated: new Float64Array(FF), dSilu: new Float64Array(FF),
                dUp: new Float64Array(FF), dGate: new Float64Array(FF),
                dNormAttention: new Float64Array(H), dGamma: new Float64Array(H),
                dNorm: new Float64Array(H), normX: new Float64Array(H),
            };
        }

        // Per-member backward workspace, reused across ensemble members (and
        // across layers within a member). Each buffer is explicitly zeroed /
        // fully overwritten before every use, so the accumulated values are
        // bit-identical to freshly allocated buffers -- but a training step now
        // allocates one set of these instead of ~1140 per member.
        let ms = this._accMemberScratch;
        if (!ms || ms.IS !== IS || ms.H !== H) {
            ms = this._accMemberScratch = {
                IS, H,
                pooled: new Float64Array(H),
                gradPooled: new Float64Array(H),
                incomingPool: new Float64Array(H),
                grad: Array(IS).fill().map(() => new Float64Array(H)),
                gradToAttentionResidual: Array(IS).fill().map(() => new Float64Array(H)),
                d_q: Array(IS).fill().map(() => new Float64Array(H)),
                d_k: Array(IS).fill().map(() => new Float64Array(H)),
                gradToNormX: Array(IS).fill().map(() => new Float64Array(H)),
                normXT: Array(H).fill().map(() => new Float64Array(IS)),
            };
        }

        let finalLogit = 0;
        for (let i = 0; i < this._ensembleSize; i++) {
            if (Number.isFinite(outputs[i]) && Number.isFinite(this._ensembleWeights[i])) {
                finalLogit += this._ensembleWeights[i] * outputs[i];
            }
        }

        let specW = this._specWeightScratch;
        if (!specW || specW.length !== H || specW[0].length !== H) {
            specW = this._specWeightScratch = Array(H).fill().map(() => new Float64Array(H));
        }

        this._transformers.forEach((transformer, idx) => {
            const lr = this._adaptiveLearningRate[idx];

            const specScore = this._specializationScores[idx];
            const specFactor = Number.isFinite(specScore)
                ? 1 + specScore * this._swarmIntelligenceFactor
                : 1;

            const specWeightSource = this._specializationWeights[idx];
            for (let a = 0; a < H; a++) {
                const srcRow = specWeightSource[a];
                const dstRow = specW[a];
                for (let b = 0; b < H; b++) {
                    const wv = srcRow[b];
                    dstRow[b] = Number.isFinite(wv)
                        ? Math.min(Math.max(1 + specScore * wv, 0.5), 1.5)
                        : 1;
                }
            }

            let specWE = this._specWExpandScratch;
            // Flattened H x FF scratch (row a at offset a*FF) instead of an
            // Array of Float64Arrays: the backward inner loops read
            // specWE[k*FF+j] millions of times, and a single contiguous buffer
            // removes one pointer-chase load per access. Values are identical.
            if (!specWE || specWE.length !== H * FF) {
                specWE = this._specWExpandScratch = new Float64Array(H * FF);
            }
            for (let a = 0; a < H; a++) {
                const srcRow = specW[a];
                const base = a * FF;
                for (let b = 0; b < FF; b++) specWE[base + b] = srcRow[b % H];
            }

            const memberWeight = Number.isFinite(this._ensembleWeights[idx]) ? this._ensembleWeights[idx] : 1 / this._ensembleSize;
            const effective_dL = dL_dLogit * memberWeight;

            let agreement_dL = 0;
            if (Number.isFinite(outputs[idx])) {
                agreement_dL = dL_dLogit * memberWeight * (outputs[idx] - finalLogit);
            }

            let attWeightGrad = 0;
            if (Number.isFinite(agreement_dL)) {
                attWeightGrad = agreement_dL / sqrtH;
            }
            const attWeightGradOk = Number.isFinite(attWeightGrad);
            const accum = this._gradientAccumulation[idx];
            for (let k = 0; k < H; k++) {
                if (attWeightGradOk) {
                    accum.attentionBias[k] += attWeightGrad * lr;
                }
                for (let i = 0; i < IS; i++) {
                    const inputVal = inputs[i];
                    if (!isValidNumber(inputVal)) continue;
                    const update = attWeightGrad * inputVal * specFactor * lr;
                    if (Number.isFinite(update)) {
                        accum.attentionWeightMatrix[k] += update;
                    }
                }
            }

            for (let j = 0; j < H; j++) {
                const specAccRow = accum.specializationWeights[j];
                for (let k = 0; k < H; k++) {
                    const inputIdx = (j + k) % IS;
                    const inputVal = inputs[inputIdx];
                    if (!isValidNumber(inputVal)) continue;
                    const update = dL_dLogit * inputVal * specFactor * lr * 0.01;
                    if (Number.isFinite(update)) {
                        specAccRow[k] += update;
                    }
                }
            }

            const finalX = layerOutputs[idx][this._numLayers];
            const pooled = ms.pooled;
            pooled.fill(0);
            let validCount = 0;
            const hasLayers = this._numLayers > 0;
            const lastLayerIdx = this._numLayers - 1;
            const pooledGamma = hasLayers ? transformer.layerNormWeights[lastLayerIdx].gamma2 : null;
            for (let pos = 0; pos < IS; pos++) {
                let posHidden = finalX[pos];
                if (hasLayers) {
                    posHidden = this._rmsNorm(posHidden, pooledGamma);
                }
                for (let j = 0; j < H; j++) {
                    const v = posHidden[j];
                    if (Number.isFinite(v)) {
                        pooled[j] += v;
                    }
                }
                validCount++;
            }
            if (validCount > 0) {
                for (let j = 0; j < H; j++) pooled[j] = pooled[j] / validCount;
            }

            const gradPooled = ms.gradPooled;
            gradPooled.fill(0);
            const outW = transformer.outputWeights;
            for (let i = 0; i < H; i++) {
                const w = outW[i][0];
                if (Number.isFinite(pooled[i]) && Number.isFinite(w)) {
                    accum.outputWeights[i][0] += effective_dL * pooled[i] * lr;
                    gradPooled[i] += effective_dL * w;
                }
            }
            accum.outputBias[0] += effective_dL * lr;

            const grad = ms.grad;
            const incomingPool = ms.incomingPool;
            for (let i = 0; i < H; i++) incomingPool[i] = gradPooled[i] / validCount;
            if (hasLayers) {
                const gamma = transformer.layerNormWeights[lastLayerIdx].gamma2;
                const lna = accum.layerNormWeights[lastLayerIdx].gamma2;
                const psNormX = fsc.normX, pdGamma = fsc.dGamma, pdNorm = fsc.dNorm;
                for (let pos = 0; pos < IS; pos++) {
                    const x = finalX[pos];
                    const gRow = grad[pos];
                    let sq_sum = 0;
                    for (let j = 0; j < H; j++) { const v = x[j]; sq_sum += v * v; }
                    const rms = Math.sqrt(sq_sum / H + 1e-6);
                    for (let j = 0; j < H; j++) psNormX[j] = x[j] / rms;

                    for (let i = 0; i < H; i++) pdGamma[i] = incomingPool[i] * psNormX[i];
                    for (let j = 0; j < H; j++) {
                        lna[j] += pdGamma[j] * lr;
                    }

                    let dot = 0;
                    for (let i = 0; i < H; i++) {
                        const dn = incomingPool[i] * gamma[i];
                        pdNorm[i] = dn;
                        dot += dn * psNormX[i];
                    }
                    for (let i = 0; i < H; i++) gRow[i] = pdNorm[i] / rms - psNormX[i] * dot / (H + 1e-8);
                }
            } else {
                for (let pos = 0; pos < IS; pos++) {
                    grad[pos].set(incomingPool);
                }
            }

            for (let layer = this._numLayers - 1; layer >= 0; layer--) {
                const act = activations[idx][layer];
                const inter = attentionIntermediates[idx][layer];
                const ffn = transformer.ffnWeights[layer];
                const attn = transformer.attentionWeights[layer];
                const accumFfn = accum.ffnWeights[layer];
                const accumAttn = accum.attentionWeights[layer];
                const accumLn = accum.layerNormWeights[layer];

                const gradToAttentionResidual = ms.gradToAttentionResidual;
                for (let pos = 0; pos < IS; pos++) {
                    const g = grad[pos];
                    const dest = gradToAttentionResidual[pos];
                    for (let j = 0; j < H; j++) dest[j] = g[j];
                }

                const gateProj = ffn.gate_proj;
                const upProj = ffn.up_proj;
                const downProj = ffn.down_proj;
                const downAcc = accumFfn.down_proj;
                const gateProjAcc = accumFfn.gate_proj;
                const upProjAcc = accumFfn.up_proj;

                for (let pos = 0; pos < IS; pos++) {
                    const x = act.normAttention[pos];
                    const gate = fsc.gate;
                    const up = fsc.up;
                    gate.fill(0);
                    up.fill(0);

                    for (let i = 0; i < H; i++) {
                        const xi = x[i];
                        if (!Number.isFinite(xi)) continue;
                        const swBase = i * FF;
                        const gpRow = gateProj[i];
                        const upRow = upProj[i];
                        for (let j = 0; j < FF; j++) {
                            const sw = specWE[swBase + j];
                            const gv = gpRow[j];
                            if (Number.isFinite(gv)) gate[j] += xi * gv * sw;
                            const uv = upRow[j];
                            if (Number.isFinite(uv)) up[j] += xi * uv * sw;
                        }
                    }

                    const silu_gate = fsc.siluGate;
                    const activated = fsc.activated;
                    for (let j = 0; j < FF; j++) {
                        const gv = gate[j];
                        const s = Number.isFinite(gv) ? gv * (1 / (1 + Math.exp(-gv))) : 0;
                        silu_gate[j] = s;
                        activated[j] = s * up[j];
                    }

                    const incoming = grad[pos];

                    for (let j = 0; j < FF; j++) {
                        const aj = activated[j];
                        const dAccRow = downAcc[j];
                        for (let k = 0; k < H; k++) {
                            dAccRow[k] += incoming[k] * aj * specWE[k * FF + j] * lr;
                        }
                    }

                    const d_activated = fsc.dActivated;
                    for (let j = 0; j < FF; j++) {
                        const dRow = downProj[j];
                        let acc = 0;
                        for (let k = 0; k < H; k++) {
                            acc += incoming[k] * dRow[k] * specWE[k * FF + j];
                        }
                        d_activated[j] = acc;
                    }

                    const d_up = fsc.dUp;
                    const d_gate = fsc.dGate;
                    for (let j = 0; j < FF; j++) {
                        const da = d_activated[j];
                        const ds = da * up[j];
                        d_up[j] = da * silu_gate[j];
                        const gv = gate[j];
                        let deriv = 0;
                        if (Number.isFinite(gv)) {
                            const s = 1 / (1 + Math.exp(-gv));
                            deriv = s * (1 + gv * (1 - s));
                        }
                        d_gate[j] = ds * deriv;
                    }

                    const d_normAttention = fsc.dNormAttention;
                    for (let i = 0; i < H; i++) {
                        const xi = x[i];
                        const swBase = i * FF;
                        const gpAccRow = gateProjAcc[i];
                        const upAccRow = upProjAcc[i];
                        const gpRow = gateProj[i];
                        const upRow = upProj[i];
                        let dna = 0;
                        for (let j = 0; j < FF; j++) {
                            const sw = specWE[swBase + j];
                            gpAccRow[j] += d_gate[j] * xi * sw * lr;
                            upAccRow[j] += d_up[j] * xi * sw * lr;
                            dna += d_gate[j] * gpRow[j] * sw + d_up[j] * upRow[j] * sw;
                        }
                        d_normAttention[i] = dna;
                    }

                    const gamma2 = transformer.layerNormWeights[layer].gamma2;
                    let sq_sum = 0;
                    for (let j = 0; j < H; j++) { const v = x[j]; sq_sum += v * v; }
                    const rms = Math.sqrt(sq_sum / H + 1e-6);
                    const norm_x = fsc.normX;
                    for (let j = 0; j < H; j++) norm_x[j] = x[j] / rms;

                    const d_gamma = fsc.dGamma;
                    for (let i = 0; i < H; i++) d_gamma[i] = d_normAttention[i] * norm_x[i];
                    for (let j = 0; j < H; j++) {
                        accumLn.gamma2[j] += d_gamma[j] * lr;
                    }

                    const d_norm = fsc.dNorm;
                    let dot = 0;
                    for (let i = 0; i < H; i++) {
                        const dn = d_normAttention[i] * gamma2[i];
                        d_norm[i] = dn;
                        dot += dn * norm_x[i];
                    }

                    const residual = gradToAttentionResidual[pos];
                    for (let j = 0; j < H; j++) {
                        const d_x_branch = d_norm[j] / rms - norm_x[j] * dot / (H + 1e-8);
                        residual[j] += d_x_branch;
                    }
                }

                const gradToAttentionOutput = gradToAttentionResidual;

                let sc = this._accScratch;
                if (!sc || sc.NH !== NH || sc.IS !== IS || sc.H !== H || sc.headSize !== headSize) {
                    sc = this._accScratch = {
                        NH, IS, H, headSize,
                        dScores: Array(NH).fill().map(() => Array(IS).fill().map(() => new Float64Array(IS))),
                        probsC: Array(NH).fill().map(() => Array(IS).fill().map(() => new Float64Array(IS))),
                        Qs: Array(IS).fill().map(() => new Float64Array(H)),
                        Ks: Array(IS).fill().map(() => new Float64Array(H)),
                        vTs: Array(H).fill().map(() => new Float64Array(IS)),
                        dPreWo: Array(IS).fill().map(() => new Float64Array(H)),
                        dqT: Array(H).fill().map(() => new Float64Array(IS)),
                        dkT: Array(H).fill().map(() => new Float64Array(IS)),
                        dvT: Array(NH).fill().map(() => Array(headSize).fill().map(() => new Float64Array(IS))),
                    };
                }
                const dScores = sc.dScores;
                const probsC = sc.probsC;
                const Qs = sc.Qs, Ks = sc.Ks, vTs = sc.vTs;
                const dPreWo = sc.dPreWo;
                const dqT = sc.dqT, dkT = sc.dkT, dvT = sc.dvT;

                const d_q = ms.d_q;
                const d_k = ms.d_k;
                for (let pos = 0; pos < IS; pos++) { d_q[pos].fill(0); d_k[pos].fill(0); }

                const probs = inter.attentionProbs;
                const Qin = inter.Q;
                const Kin = inter.K;
                const Vin = inter.V;
                const preWo = inter.preWoOutput;
                const woAcc = accumAttn.Wo;
                const woT = attn.Wo;

                for (let pos = 0; pos < IS; pos++) {
                    const qI = Qin[pos], kI = Kin[pos], vI = Vin[pos];
                    const qS = Qs[pos], kS = Ks[pos];
                    for (let dim = 0; dim < H; dim++) {
                        const qv = qI[dim]; qS[dim] = Number.isFinite(qv) ? qv : 0;
                        const kv = kI[dim]; kS[dim] = Number.isFinite(kv) ? kv : 0;
                        const vv = vI[dim]; vTs[dim][pos] = Number.isFinite(vv) ? vv : 0;
                    }
                }
                for (let h = 0; h < NH; h++) {
                    const pH = probs[h], pcH = probsC[h], dsH = dScores[h];
                    const dvH = dvT[h];
                    for (let qp = 0; qp < IS; qp++) {
                        const pRow = pH[qp], pcRow = pcH[qp], dsRow = dsH[qp];
                        for (let vp = 0; vp < IS; vp++) {
                            const pRaw = pRow[vp];
                            pcRow[vp] = Number.isFinite(pRaw) ? pRaw : 0;
                            dsRow[vp] = 0;
                        }
                    }
                    for (let dim = 0; dim < headSize; dim++) dvH[dim].fill(0);
                }

                for (let queryPos = 0; queryPos < IS; queryPos++) {
                    const incoming = gradToAttentionOutput[queryPos];
                    const preWoRow = preWo[queryPos];
                    const dPreRow = dPreWo[queryPos];
                    dPreRow.fill(0);
                    for (let outDim = 0; outDim < H; outDim++) {
                        const inc = incoming[outDim];
                        for (let preDim = 0; preDim < H; preDim++) {
                            const specWeight = specW[preDim][outDim];
                            woAcc[preDim][outDim] += inc * preWoRow[preDim] * specWeight * lr;
                            dPreRow[preDim] += inc * woT[preDim][outDim] * specWeight;
                        }
                    }
                }

                for (let h = 0; h < NH; h++) {
                    const offset = h * headSize;
                    const pcH = probsC[h];
                    const dsH = dScores[h];
                    const dvH = dvT[h];
                    for (let dim = 0; dim < headSize; dim++) {
                        const idx = offset + dim;
                        const vCol = vTs[idx];
                        const dvCol = dvH[dim];
                        for (let queryPos = 0; queryPos < IS; queryPos++) {
                            const dAttRaw = dPreWo[queryPos][idx];
                            const d_att = Number.isFinite(dAttRaw) ? dAttRaw : 0;
                            const dsRow = dsH[queryPos];
                            const pcRow = pcH[queryPos];
                            for (let valuePos = 0; valuePos < IS; valuePos++) {
                                dsRow[valuePos] += d_att * vCol[valuePos];
                                dvCol[valuePos] += d_att * pcRow[valuePos];
                            }
                        }
                    }
                }

                for (let h = 0; h < NH; h++) {
                    const pcH = probsC[h];
                    const dsH = dScores[h];
                    for (let qp = 0; qp < IS; qp++) {
                        const pRow = pcH[qp];
                        const dsRow = dsH[qp];
                        let weighted = 0;
                        for (let vp = 0; vp < IS; vp++) {
                            const dp = Number.isFinite(dsRow[vp]) ? dsRow[vp] : 0;
                            weighted += pRow[vp] * dp;
                        }
                        for (let vp = 0; vp < IS; vp++) {
                            const dp = Number.isFinite(dsRow[vp]) ? dsRow[vp] : 0;
                            dsRow[vp] = pRow[vp] * (dp - weighted);
                        }
                    }
                }

                for (let h = 0; h < NH; h++) {
                    const offset = h * headSize;
                    const dsH = dScores[h];
                    for (let queryPos = 0; queryPos < IS; queryPos++) {
                        const Qrow = Qs[queryPos];
                        const dqRow = d_q[queryPos];
                        const dsRow = dsH[queryPos];
                        for (let keyPos = 0; keyPos < IS; keyPos++) {
                            const dsRaw = dsRow[keyPos];
                            const scaled = Number.isFinite(dsRaw) ? dsRaw / sqrtHeadSize : 0;
                            const Krow = Ks[keyPos];
                            const dkRow = d_k[keyPos];
                            for (let dim = 0; dim < headSize; dim++) {
                                const idx = offset + dim;
                                dqRow[idx] += scaled * Krow[idx];
                                dkRow[idx] += scaled * Qrow[idx];
                            }
                        }
                    }
                }

                for (let outputDim = 0; outputDim < H; outputDim++) {
                    const dqt = dqT[outputDim], dkt = dkT[outputDim];
                    for (let pos = 0; pos < IS; pos++) {
                        dqt[pos] = d_q[pos][outputDim];
                        dkt[pos] = d_k[pos][outputDim];
                    }
                }

                const gradToNormX = ms.gradToNormX;
                for (let pos = 0; pos < IS; pos++) gradToNormX[pos].fill(0);
                const Wq = attn.Wq;
                const Wk = attn.Wk;
                const Wv = attn.Wv;

                for (let pos = 0; pos < IS; pos++) {
                    const dqRow = d_q[pos];
                    const dkRow = d_k[pos];
                    const gxRow = gradToNormX[pos];
                    for (let inputDim = 0; inputDim < H; inputDim++) {
                        const swRow = specW[inputDim];
                        const wqRow = Wq[inputDim];
                        let contribQ = 0;
                        for (let outputDim = 0; outputDim < H; outputDim++) {
                            contribQ += dqRow[outputDim] * wqRow[outputDim] * swRow[outputDim];
                        }
                        gxRow[inputDim] += contribQ;
                        const wkRow = Wk[inputDim];
                        let contribK = 0;
                        for (let outputDim = 0; outputDim < H; outputDim++) {
                            contribK += dkRow[outputDim] * wkRow[outputDim] * swRow[outputDim];
                        }
                        gxRow[inputDim] += contribK;
                    }
                    for (let inputDim = 0; inputDim < H; inputDim++) {
                        const swRow = specW[inputDim];
                        const wvRow = Wv[inputDim];
                        let contribV = 0;
                        for (let h = 0; h < NH; h++) {
                            const dvh = dvT[h];
                            for (let dim = 0; dim < headSize; dim++) {
                                const outputDim = h * headSize + dim;
                                contribV += dvh[dim][pos] * wvRow[outputDim] * swRow[outputDim];
                            }
                        }
                        gxRow[inputDim] += contribV;
                    }
                }

                const normX = act.normX;
                const normXT = ms.normXT;
                for (let pos = 0; pos < IS; pos++) {
                    const nx = normX[pos];
                    for (let i = 0; i < H; i++) normXT[i][pos] = nx[i];
                }

                const wqAcc = accumAttn.Wq;
                const wkAcc = accumAttn.Wk;
                const wvAcc = accumAttn.Wv;
                for (let inputDim = 0; inputDim < H; inputDim++) {
                    const nxRow = normXT[inputDim];
                    const wqAccRow = wqAcc[inputDim];
                    const wkAccRow = wkAcc[inputDim];
                    const wvAccRow = wvAcc[inputDim];
                    const swRow = specW[inputDim];
                    for (let outputDim = 0; outputDim < H; outputDim++) {
                        const specWeight = swRow[outputDim];
                        const head = Math.floor(outputDim / headSize);
                        const dim = outputDim % headSize;
                        const dvRow = dvT[head][dim];
                        const dqt = dqT[outputDim];
                        const dkt = dkT[outputDim];
                        let wqUpdate = 0;
                        let wkUpdate = 0;
                        let wvUpdate = 0;
                        for (let pos = 0; pos < IS; pos++) {
                            const nx = nxRow[pos];
                            wqUpdate += dqt[pos] * nx;
                            wkUpdate += dkt[pos] * nx;
                            wvUpdate += dvRow[pos] * nx;
                        }
                        wqAccRow[outputDim] += wqUpdate * specWeight * lr;
                        wkAccRow[outputDim] += wkUpdate * specWeight * lr;
                        wvAccRow[outputDim] += wvUpdate * specWeight * lr;
                    }
                }

                const gamma1 = transformer.layerNormWeights[layer].gamma1;
                const lna1 = accumLn.gamma1;
                for (let pos = 0; pos < IS; pos++) {
                    const x = normX[pos];
                    let sq_sum = 0;
                    for (let j = 0; j < H; j++) { const v = x[j]; sq_sum += v * v; }
                    const rms = Math.sqrt(sq_sum / H + 1e-6);
                    const norm_x = fsc.normX;
                    for (let j = 0; j < H; j++) norm_x[j] = x[j] / rms;

                    const incoming = gradToNormX[pos];

                    const d_gamma = fsc.dGamma;
                    for (let i = 0; i < H; i++) d_gamma[i] = incoming[i] * norm_x[i];
                    for (let j = 0; j < H; j++) {
                        lna1[j] += d_gamma[j] * lr;
                    }

                    const d_norm = fsc.dNorm;
                    let dot = 0;
                    for (let i = 0; i < H; i++) {
                        const dn = incoming[i] * gamma1[i];
                        d_norm[i] = dn;
                        dot += dn * norm_x[i];
                    }

                    const gOut = gradToAttentionOutput[pos];
                    const gRow = grad[pos];
                    for (let j = 0; j < H; j++) {
                        const d_x = d_norm[j] / rms - norm_x[j] * dot / (H + 1e-8);
                        gRow[j] = gOut[j] + d_x;
                    }
                }
            }
        });
    },

    _applyGradients (shouldScale = true, shouldClone = false, steps = 1) {
        let gradClone;
        if (shouldClone) gradClone = this._setGradientStructure();

        this._transformers.forEach((transformer, idx) => {
            if (shouldScale) this._scaleGradients(idx);

            for (let k = 0; k < this._hiddenSize; k++) {
                const biasAcc = this._gradientAccumulation[idx].attentionBias[k];
                if (isValidNumber(biasAcc)) {
                    const finalBiasAcc = biasAcc / steps;
                    this._attentionBias[idx][k] -= finalBiasAcc;
                    if (shouldClone) gradClone[idx].attentionBias[k] = finalBiasAcc;
                }

                const matrixAcc = this._gradientAccumulation[idx].attentionWeightMatrix[k];
                if (isValidNumber(matrixAcc)) {
                    const finalMatrixAcc = matrixAcc / steps;
                    this._attentionWeightMatrix[idx][k] -= finalMatrixAcc;
                    if (shouldClone) gradClone[idx].attentionWeightMatrix[k] = finalMatrixAcc;
                }
            }

            for (let j = 0; j < this._hiddenSize; j++) {
                for (let k = 0; k < this._hiddenSize; k++) {
                    const specAcc = this._gradientAccumulation[idx].specializationWeights[j][k];
                    if (isValidNumber(specAcc)) {
                        const finalSpecAcc = specAcc / steps;
                        this._specializationWeights[idx][j][k] -= finalSpecAcc;
                        if (shouldClone) gradClone[idx].specializationWeights[j][k] = finalSpecAcc;
                    }
                }
            }
            this._specWeightCache[idx] = null;

            for (let i = 0; i < this._hiddenSize; i++) {
                const outWeightAcc = this._gradientAccumulation[idx].outputWeights[i][0];
                if (isValidNumber(outWeightAcc)) {
                    const finalOutWeightAcc = outWeightAcc / steps;
                    transformer.outputWeights[i][0] -= finalOutWeightAcc;
                    if (shouldClone) gradClone[idx].outputWeights[i][0] = finalOutWeightAcc;
                }
            }
            const outBiasAcc = this._gradientAccumulation[idx].outputBias[0];
            if (isValidNumber(outBiasAcc)) {
                const finalOutBiasAcc = outBiasAcc / steps;
                transformer.outputBias[0] -= finalOutBiasAcc;
                if (shouldClone) gradClone[idx].outputBias[0] = finalOutBiasAcc;
            }

            for (let layer = 0; layer < this._numLayers; layer++) {
                for (let i = 0; i < this._hiddenSize; i++) {
                    for (let j = 0; j < this._hiddenSize; j++) {
                        ['Wq', 'Wk', 'Wv', 'Wo'].forEach(key => {
                            const acc = this._gradientAccumulation[idx].attentionWeights[layer][key][i][j];
                            if (isValidNumber(acc)) {
                                const finalAcc = acc / steps;
                                transformer.attentionWeights[layer][key][i][j] -= finalAcc;
                                if (shouldClone) gradClone[idx].attentionWeights[layer][key][i][j] = finalAcc;
                            }
                        });
                    }
                }

                for (let i = 0; i < this._hiddenSize; i++) {
                    for (let j = 0; j < this._feedForwardSize; j++) {
                        const gateAcc = this._gradientAccumulation[idx].ffnWeights[layer].gate_proj[i][j];
                        if (isValidNumber(gateAcc)) {
                            const finalAcc = gateAcc / steps;
                            transformer.ffnWeights[layer].gate_proj[i][j] -= finalAcc;
                            if (shouldClone) gradClone[idx].ffnWeights[layer].gate_proj[i][j] = finalAcc;
                        }
                        const upAcc = this._gradientAccumulation[idx].ffnWeights[layer].up_proj[i][j];
                        if (isValidNumber(upAcc)) {
                            const finalAcc = upAcc / steps;
                            transformer.ffnWeights[layer].up_proj[i][j] -= finalAcc;
                            if (shouldClone) gradClone[idx].ffnWeights[layer].up_proj[i][j] = finalAcc;
                        }
                    }
                }
                for (let i = 0; i < this._feedForwardSize; i++) {
                    for (let j = 0; j < this._hiddenSize; j++) {
                        const downAcc = this._gradientAccumulation[idx].ffnWeights[layer].down_proj[i][j];
                        if (isValidNumber(downAcc)) {
                            const finalAcc = downAcc / steps;
                            transformer.ffnWeights[layer].down_proj[i][j] -= finalAcc;
                            if (shouldClone) gradClone[idx].ffnWeights[layer].down_proj[i][j] = finalAcc;
                        }
                    }
                }

                for (let i = 0; i < this._hiddenSize; i++) {
                    const gamma1Acc = this._gradientAccumulation[idx].layerNormWeights[layer].gamma1[i];
                    if (isValidNumber(gamma1Acc)) {
                        const finalAcc = gamma1Acc / steps;
                        transformer.layerNormWeights[layer].gamma1[i] -= finalAcc;
                        if (shouldClone) gradClone[idx].layerNormWeights[layer].gamma1[i] = finalAcc;
                    }
                    const gamma2Acc = this._gradientAccumulation[idx].layerNormWeights[layer].gamma2[i];
                    if (isValidNumber(gamma2Acc)) {
                        const finalAcc = gamma2Acc / steps;
                        transformer.layerNormWeights[layer].gamma2[i] -= finalAcc;
                        if (shouldClone) gradClone[idx].layerNormWeights[layer].gamma2[i] = finalAcc;
                    }
                }
            }
        });

        if (shouldClone) return gradClone;
    },

    _rollbackGradients (gradClone) {
        this._transformers.forEach((transformer, idx) => {
            for (let k = 0; k < this._hiddenSize; k++) {
                const attBias = gradClone[idx].attentionBias[k];
                if (isValidNumber(attBias)) this._attentionBias[idx][k] += attBias;

                const attMatrix = gradClone[idx].attentionWeightMatrix[k];
                if (isValidNumber(attMatrix)) this._attentionWeightMatrix[idx][k] += attMatrix;
            }

            for (let j = 0; j < this._hiddenSize; j++) {
                for (let k = 0; k < this._hiddenSize; k++) {
                    const specWeight = gradClone[idx].specializationWeights[j][k];
                    if (isValidNumber(specWeight)) this._specializationWeights[idx][j][k] += specWeight;
                }
            }
            this._specWeightCache[idx] = null;

            for (let i = 0; i < this._hiddenSize; i++) {
                const outputWeight = gradClone[idx].outputWeights[i][0];
                if (isValidNumber(outputWeight)) transformer.outputWeights[i][0] += outputWeight;
            }
            const outputBias = gradClone[idx].outputBias[0];
            if (isValidNumber(outputBias)) transformer.outputBias[0] += outputBias;

            for (let layer = 0; layer < this._numLayers; layer++) {
                for (let i = 0; i < this._hiddenSize; i++) {
                    for (let j = 0; j < this._hiddenSize; j++) {
                        ['Wq', 'Wk', 'Wv', 'Wo'].forEach(key => {
                            const weight = gradClone[idx].attentionWeights[layer][key][i][j];
                            if (isValidNumber(weight)) transformer.attentionWeights[layer][key][i][j] += weight;
                        });
                    }
                }

                for (let i = 0; i < this._hiddenSize; i++) {
                    for (let j = 0; j < this._feedForwardSize; j++) {
                        const gateWeight = gradClone[idx].ffnWeights[layer].gate_proj[i][j];
                        if (isValidNumber(gateWeight)) transformer.ffnWeights[layer].gate_proj[i][j] += gateWeight;
                        const upWeight = gradClone[idx].ffnWeights[layer].up_proj[i][j];
                        if (isValidNumber(upWeight)) transformer.ffnWeights[layer].up_proj[i][j] += upWeight;
                    }
                }
                for (let i = 0; i < this._feedForwardSize; i++) {
                    for (let j = 0; j < this._hiddenSize; j++) {
                        const downWeight = gradClone[idx].ffnWeights[layer].down_proj[i][j];
                        if (isValidNumber(downWeight)) transformer.ffnWeights[layer].down_proj[i][j] += downWeight;
                    }
                }

                for (let i = 0; i < this._hiddenSize; i++) {
                    const gamma1Weight = gradClone[idx].layerNormWeights[layer].gamma1[i];
                    if (isValidNumber(gamma1Weight)) transformer.layerNormWeights[layer].gamma1[i] += gamma1Weight;
                    const gamma2Weight = gradClone[idx].layerNormWeights[layer].gamma2[i];
                    if (isValidNumber(gamma2Weight)) transformer.layerNormWeights[layer].gamma2[i] += gamma2Weight;
                }
            }
        });
    }

};
