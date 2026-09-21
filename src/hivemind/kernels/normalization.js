// HiveMind component: normalization
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
export const normalizationMethods = {
    _rmsNorm (x, gamma, eps = 1e-6) {
        if (!Array.isArray(x) || x.length !== this._hiddenSize ||
            !Array.isArray(gamma) || gamma.length !== this._hiddenSize) {
            return Array(this._hiddenSize).fill(0);
        }

        let sq_sum = 0;
        for (let i = 0; i < this._hiddenSize; i++) {
            const val = x[i];
            sq_sum += val * val;
        }
        const rms = Math.sqrt(sq_sum / this._hiddenSize + eps);

        const output = Array(this._hiddenSize);
        for (let i = 0; i < this._hiddenSize; i++) {
            output[i] = x[i] * gamma[i] / rms;
        }
        return output;
    },

    _normalizeSemantic (transformerIdx, sem) {
        const maxMeanRMS = 1.8 + 2.2 * this._protoCapacityFactor;

        for (const proto of sem) {
            const rms = Math.sqrt(this._fastVectorDot(proto.mean, proto.mean) / this._hiddenSize + 1e-8);
            if (rms > maxMeanRMS) {
                const scale = maxMeanRMS / rms;
                this._fastVectorScale(proto.mean, scale, proto.mean);
                for (let j = 0; j < this._hiddenSize; j++) {
                    proto.variance[j] *= scale ** 2;
                    proto.variance[j] = Math.min(proto.variance[j], this._maxVariancePerDim);
                }
                this._invalidateProjCache(proto.mean);
                proto.projNorms = this._computeProjNorms(proto.mean);
                this._updateProtoInLSH(transformerIdx, proto);
                proto.contentHash = this._computeContentHash(proto.mean);
            }
        }
    },

    _applyRoPE (matrix, startPos = 0) {
        if (!Array.isArray(matrix) || matrix.length === 0 || !matrix[0] || matrix[0].length !== this._hiddenSize) return;

        const headDim = this._hiddenSize / this._numHeads;
        if (headDim % 2 !== 0) return;

        const half = Math.floor(headDim / 2);
        if (half === 0) return;

        // Frequency factors depend only on the (fixed) head dimension, and the
        // cos/sin for each absolute position are identical across heads, hops
        // and transformers -- cache both so the hot attention loop does no
        // transcendentals at all.
        if (!this._ropeFreqs || this._ropeFreqs.length !== half) {
            const freqs = new Float64Array(half);
            for (let i = 0; i < half; i++) freqs[i] = Math.pow(10000.0, -2.0 * i / headDim);
            this._ropeFreqs = freqs;
            this._ropeCos = new Map();
            this._ropeSin = new Map();
        }

        const freqs = this._ropeFreqs;
        const seqLen = matrix.length;

        for (let pos = 0; pos < seqLen; pos++) {
            const absPos = startPos + pos;
            let cosRow = this._ropeCos.get(absPos);
            let sinRow = this._ropeSin.get(absPos);
            if (cosRow === undefined) {
                cosRow = new Float64Array(half);
                sinRow = new Float64Array(half);
                for (let i = 0; i < half; i++) {
                    const theta = absPos * freqs[i];
                    cosRow[i] = Math.cos(theta);
                    sinRow[i] = Math.sin(theta);
                }
                this._ropeCos.set(absPos, cosRow);
                this._ropeSin.set(absPos, sinRow);
            }

            const row = matrix[pos];
            for (let h = 0; h < this._numHeads; h++) {
                const offset = h * headDim;
                for (let i = 0; i < half; i++) {
                    const idx1 = offset + 2 * i;
                    const idx2 = idx1 + 1;

                    const x = row[idx1];
                    const y = row[idx2];
                    const c = cosRow[i];
                    const s = sinRow[i];

                    row[idx1] = x * c - y * s;
                    row[idx2] = x * s + y * c;
                }
            }
        }
    }

};
