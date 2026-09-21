// HiveMind component: hiveState
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
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

        if (intermediates && shouldReturn) { 
            return { outputs, layerOutputs, activations, attentionIntermediates, probability }; 
        }

        if (!intermediates && shouldReturn) {
            return { outputs, probability };
        }
    },

    _hiveMemorySharing () {
        if (this._ensembleSize < 2) return;

        const compositeScores = this._performanceScores.map((perf, i) => {
            const agree = this._agreementScores[i] ?? 0.5;
            const spec = this._specializationScores[i] ?? 0.5;
            return 0.45 * perf + 0.25 * agree + 0.3 * spec;
        });

        const rankedIndices = Array.from({length: this._ensembleSize}, (_, i) => i);
        rankedIndices.sort((a, b) => compositeScores[b] - compositeScores[a]);

        const minShare = Math.max(2, Math.round(this._ensembleSize * 0.05));
        const numShare = Math.max(minShare, Math.round(this._ensembleSize * (0.2 + 0.4 * this._swarmIntelligenceFactor)));
        const donors = rankedIndices.slice(0, numShare);
        const receivers = rankedIndices.slice(-numShare);

        const hidden = this._hiddenSize;
        const maxTransferPerReceiver = Math.round(this._baseProtoCapacity * (0.5 + 0.8 * this._swarmIntelligenceFactor));

        for (const recIdx of receivers) {
            const recPerf = this._performanceScores[recIdx] ?? 0.5;
            const recAgree = this._agreementScores[recIdx] ?? 0.5;
            const noiseScale = 0.04 + 0.08 * (1 - recPerf) + 0.04 * (1 - recAgree);

            let transferredProtos = [];

            for (const donIdx of donors) {
                let donProtos = this._semanticProtos[donIdx];
                if (donProtos.length === 0) continue;

                const sorted = this._sortByScoreDescInPlace(donProtos.slice(), (p) =>
                    this._computeProtoUtility(p) + 5 * (p.importance || 0)
                );

                const minFromDonor = Math.max(2, Math.round((2 + 1.5 * this._protoCapacityFactor) * this._memoryFactor));
                let numFromDonor = Math.max(minFromDonor, Math.round(sorted.length * (0.08 + 0.12 * this._swarmIntelligenceFactor)));
                const topFraction = 0.6 + 0.2 * this._protoCapacityFactor;
                const numTop = Math.ceil(numFromDonor * topFraction);
                const numRandom = numFromDonor - numTop;

                for (const p of sorted.slice(0, numTop)) {
                    const newMean = new Float32Array(p.mean);
                    for (let j = 0; j < hidden; j++) {
                        newMean[j] += (Math.random() - 0.5) * 2 * noiseScale;
                    }

                    const newProto = this._createNewProto(newMean, p.variance, p.size * 0.12, false);
                    this._reinforceProto(newProto, p.accessCount * 0.4, 0, p.importance * 0.25);
                    this._finalizeSemanticProto(newProto, null);
                    transferredProtos.push(newProto);
                }

                const shuffled = donProtos.slice();
                for (let i = shuffled.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                }
                for (let r = 0; r < numRandom && r < shuffled.length; r++) {
                    const p = shuffled[r];
                    const newMean = new Float32Array(p.mean);
                    const extraNoise = noiseScale * 0.8;
                    for (let j = 0; j < hidden; j++) {
                        newMean[j] += (Math.random() - 0.5) * 2 * extraNoise;
                    }

                    const newProto = this._createNewProto(newMean, p.variance, p.size * 0.08, false);
                    this._reinforceProto(newProto, p.accessCount * 0.25, 0, p.importance * 0.15);
                    this._finalizeSemanticProto(newProto, null);
                    transferredProtos.push(newProto);
                }
            }

            if (transferredProtos.length > maxTransferPerReceiver) {
                const sortedTransfer = this._sortedByUtilityDesc(transferredProtos);
                // The dropped tail is transient (it only ever feeds
                // _updateSemanticProtos, which never stores these instances), so
                // unregister it from recIdx's LSH buckets to be safe - otherwise
                // the bucket sets slowly fill with dead protos and every later
                // retrieval wastes probes on them.
                for (let k = maxTransferPerReceiver; k < sortedTransfer.length; k++) {
                    this._removeProtoFromLSH(recIdx, sortedTransfer[k]);
                }
                transferredProtos = sortedTransfer.slice(0, maxTransferPerReceiver);
            }

            if (transferredProtos.length > 0) {
                this._updateSemanticProtos(recIdx, transferredProtos);
                this._updateSemanticStats(recIdx);
            }
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
