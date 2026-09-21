// HiveMind component: forward
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
import { isValidNumber } from '../utils.js';

export const forwardMethods = {
    // Batched feed-forward. The old per-row entry point was invoked once per
    // token (~250 calls per transformer per predict), and every call allocated
    // five scratch buffers and re-fetched the specialization matrix. Working on
    // a whole block of token rows at once reuses those buffers and hoists the
    // per-layer weight lookups, while the arithmetic (and therefore the
    // float32 rounding of every value) is element-for-element identical to the
    // per-row path. Rows are returned as plain Arrays to match the previous
    // return shape exactly.
    _feedForwardBatch (rows, layer, transformerIdx) {
        const n = rows.length;
        const hidden = this._hiddenSize;
        const ffn = this._feedForwardSize;
        const outputs = new Array(n);

        if (!layer || !layer.gate_proj || !layer.up_proj || !layer.down_proj) {
            for (let r = 0; r < n; r++) outputs[r] = Array(hidden).fill(0);
            return outputs;
        }

        const specW = this._getSpecWeightMatrix(transformerIdx);

        // `specW[i][j % hidden]` and `specW[j][i % hidden]` are pure functions
        // of the (cached) spec weight matrix, so precompute both tiled forms
        // once per cache generation instead of doing a modulo per inner-loop
        // step. The expansion cache is keyed by the identity of the matrix
        // returned by _getSpecWeightMatrix, which is rebuilt whenever the
        // spec weights/scores are written (see _specWeightCache invalidation).
        let ec = this._specExpandCache[transformerIdx];
        if (!ec || ec.src !== specW) {
            const specWE = new Array(hidden);
            for (let kk = 0; kk < hidden; kk++) {
                const srcRow = specW[kk];
                const e = new Float64Array(ffn);
                for (let j = 0; j < ffn; j++) e[j] = srcRow[j % hidden];
                specWE[kk] = e;
            }
            const specWT = new Array(ffn);
            for (let i = 0; i < ffn; i++) {
                const col = i % hidden;
                const t = new Float64Array(hidden);
                for (let kk = 0; kk < hidden; kk++) t[kk] = specW[kk][col];
                specWT[i] = t;
            }
            ec = this._specExpandCache[transformerIdx] = { src: specW, specWE, specWT };
        }
        const specWE = ec.specWE;
        const specWT = ec.specWT;

        const gateProj = layer.gate_proj;
        const upProj = layer.up_proj;
        const downProj = layer.down_proj;

        // Reused across rows (the per-row version allocated these fresh each
        // call); they are explicitly zeroed before every row, so the
        // accumulated double values are bit-identical to a fresh buffer.
        const gateAcc = new Float64Array(ffn);
        const upAcc = new Float64Array(ffn);
        const activated = new Float32Array(ffn);
        const outAcc = new Float64Array(hidden);

        for (let r = 0; r < n; r++) {
            const x = rows[r];
            if (!Array.isArray(x) || x.length !== hidden) {
                outputs[r] = Array(hidden).fill(0);
                continue;
            }

            gateAcc.fill(0);
            upAcc.fill(0);
            for (let i = 0; i < hidden; i++) {
                const xVal = x[i];
                const specRow = specWE[i];
                const gRow = gateProj[i];
                const uRow = upProj[i];
                for (let j = 0; j < ffn; j++) {
                    const specWeight = specRow[j];
                    gateAcc[j] += xVal * gRow[j] * specWeight;
                    upAcc[j] += xVal * uRow[j] * specWeight;
                }
            }


            // Matches the old `Float32Array.from(gateAcc)` round-trip: the
            // _silu input is the float32-rounded gate value.
            for (let j = 0; j < ffn; j++) {
                const gv = Math.fround(gateAcc[j]);
                const s = Number.isFinite(gv) ? gv * (1 / (1 + Math.exp(-gv))) : 0;
                activated[j] = s * Math.fround(upAcc[j]);
            }

            outAcc.fill(0);
            for (let i = 0; i < ffn; i++) {
                const a = activated[i];
                const dRow = downProj[i];
                const specRowT = specWT[i];
                for (let j = 0; j < hidden; j++) {
                    outAcc[j] += a * dRow[j] * specRowT[j];
                }
            }

            const row = new Array(hidden);
            for (let j = 0; j < hidden; j++) row[j] = Math.fround(outAcc[j]);
            outputs[r] = row;
        }

        return outputs;
    },

    _processTransformer (inputs, idx, computeIntermediates = false, training = true, isLast = false) {
        const transformer = this._transformers[idx];

        let x = this._contextAwareAttention(inputs, idx);

        const layerOutputs = computeIntermediates ? [x] : [];
        const activations = computeIntermediates ? [] : [];
        const attentionIntermediates = computeIntermediates ? [] : [];

        for (let layer = 0; layer < this._numLayers; layer++) {
            const normX = x.map(row => this._rmsNorm(row, transformer.layerNormWeights[layer].gamma1));

            const attentionResult = this._multiHeadAttention(normX, layer, transformer.attentionWeights[layer], idx, training, computeIntermediates);
            const attentionOutput = attentionResult.output;

            const attentionResidual = x.map((row, i) => row.map((val, j) => val + attentionOutput[i][j]));

            const normAttention = attentionResidual.map(row => this._rmsNorm(row, transformer.layerNormWeights[layer].gamma2));

            const ffnOutputs = this._feedForwardBatch(normAttention, transformer.ffnWeights[layer], idx);

            x = attentionResidual.map((row, i) => row.map((val, j) => val + ffnOutputs[i][j]));

            if (computeIntermediates) {
                layerOutputs.push(x);
                activations.push({ normX, attentionOutput, normAttention });
                attentionIntermediates.push({
                    Q: attentionResult.Q,
                    K: attentionResult.K,
                    V: attentionResult.V,
                    attentionScores: attentionResult.scores,
                    attentionProbs: attentionResult.probs,
                    preWoOutput: attentionResult.preWoOutput
                });
            }
        }

        let finalHidden = Array(this._hiddenSize).fill(0);
        let validCount = 0;
        for (let pos = 0; pos < this._inputSize; pos++) {
            let posHidden = x[pos];
            if (this._numLayers > 0) {
                const lastLayerIdx = this._numLayers - 1;
                posHidden = this._rmsNorm(posHidden, transformer.layerNormWeights[lastLayerIdx].gamma2);
            }
            for (let j = 0; j < this._hiddenSize; j++) {
                if (isValidNumber(posHidden[j])) {
                    finalHidden[j] += posHidden[j];
                }
            }
            validCount++;
        }
        if (validCount > 0) {
            finalHidden = finalHidden.map(v => v / validCount);
        }

        let output = Array(1).fill(0);
        for (let i = 0; i < this._hiddenSize; i++) {
            output[0] += isValidNumber(finalHidden[i]) && isValidNumber(transformer.outputWeights[i][0])
                ? finalHidden[i] * transformer.outputWeights[i][0]
                : 0;
        }
        output[0] = isValidNumber(output[0]) && isValidNumber(transformer.outputBias[0])
            ? output[0] + transformer.outputBias[0]
            : output[0];

        if (isLast) this._computeAttentionWeights(inputs);

        if (computeIntermediates) {
            return { output: output[0], layerOutputs, activations, attentionIntermediates };
        }
        return output[0];
    }

};
