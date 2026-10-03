// HiveMind component: hiveState
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// ordinary suites (sanity determinism, controller invariants, walk-forward) pin the behavior.
import { isValidNumber } from '../utils.js';

export const hiveStateMethods = {
    _updateHiveState (inputs, target, intermediates, training, shouldUpdateMetrics, shouldReturn) {
        let probability;
        let outputs = [];
        const layerOutputs = [];
        const activations = [];
        const attentionIntermediates = [];

        if (intermediates) {
            this._transformers.forEach((_, idx, arr) => {
                const result = this._processTransformer(inputs, idx, true, training, idx === arr.length - 1);
                outputs[idx] = result.output;
                layerOutputs[idx] = result.layerOutputs;
                activations[idx] = result.activations;
                attentionIntermediates[idx] = result.attentionIntermediates;
            });
        } else {
            outputs = this._transformers.map((_, idx, arr) => 
                this._processTransformer(inputs, idx, false, training, idx === arr.length - 1)
            );
        }

        const finalOutput = this._computeWeightedSum(outputs);
        probability = this._sigmoid(finalOutput);

        if (shouldUpdateMetrics) this._updateMetrics(inputs, outputs, target, probability);

        // C6 (lab CYCLE-206): flush the staged prune discards as one GLOBAL
        // top-K promotion across members (see memory/banks.js). This is the
        // single ensemble-wide point in the forward pass (the member loop is
        // inside `_processTransformer`), so it covers predict and train alike.
        this._promoteStagedDiscards();

        if (intermediates && shouldReturn) { 
            return { outputs, layerOutputs, activations, attentionIntermediates, probability }; 
        }

        if (!intermediates && shouldReturn) {
            return { outputs, probability };
        }
    },

    _computeWeightedSum (outputs) {
        return outputs.reduce((sum, out, idx) => {
            if (isValidNumber(out) && isValidNumber(this._ensembleWeights[idx])) {
                return sum + out * this._ensembleWeights[idx];
            }
            return sum;
        }, 0);
    },

    // The specialization gate M[kk][j] = clamp(1 + specScore * W[kk][j], 0.5, 1.5)
    // is used identically by _multiHeadAttention, _feedForward and
    // _contextAwareAttention, but was previously recomputed for every element of
    // every projection (tens of millions of min/max calls per predict). It only
    // depends on the transformer, so materialize it once and reuse until any
    // specialization weight/score is written (see _specWeightCache = null sites).
    _getSpecWeightMatrix (transformerIdx) {
        const cached = this._specWeightCache[transformerIdx];
        if (cached) return cached;
        const specScore = this._specializationScores[transformerIdx] || 0.5;
        const base = this._specializationWeights[transformerIdx];
        const H = this._hiddenSize;
        const m = new Array(H);
        for (let kk = 0; kk < H; kk++) {
            const baseRow = base[kk];
            const row = new Float64Array(H);
            for (let j = 0; j < H; j++) {
                const w = 1 + specScore * baseRow[j];
                row[j] = w < 0.5 ? 0.5 : (w > 1.5 ? 1.5 : w);
            }
            m[kk] = row;
        }
        this._specWeightCache[transformerIdx] = m;
        return m;
    }

};
