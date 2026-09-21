// HiveMind component: linalg
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
export const linalgMethods = {
    _fastVectorDot (a, b) {
        let sum = 0;
        const len = a.length;
        for (let i = 0; i < len; i++) sum += a[i] * b[i];
        return sum;
    },

    _fastVectorAdd (a, b, coeffA = 1, coeffB = 1, target = null) {
        const len = a.length;
        if (len !== b.length) return new Float32Array(a);
        const result = target || new Float32Array(len);
        for (let i = 0; i < len; i++) {
            result[i] = a[i] * coeffA + b[i] * coeffB;
        }
        return result;
    },

    _fastVectorScale (vec, scalar, target = null) {
        const len = vec.length;
        const result = target || new Float32Array(len);
        for (let i = 0; i < len; i++) result[i] = vec[i] * scalar;
        return result;
    },

    _vectorDot (a, b) {
        if (a.length !== b.length) return 0;
        let sum = 0;
        for (let i = 0; i < a.length; i++) {
            sum += a[i] * b[i];
        }
        return sum;
    },

    _vectorNorm (a) {
        return Math.sqrt(this._fastVectorDot(a, a));
    },

    _vectorSub (a, b, target = null) {
        return this._fastVectorAdd(a, b, 1, -1, target);
    },

    _cosineSimilarity (a, b) {
        const dot = this._fastVectorDot(a, b);
        const normA = Math.sqrt(this._fastVectorDot(a, a));
        const normB = Math.sqrt(this._fastVectorDot(b, b));
        return dot / (normA * normB + 1e-8);
    },

    _weightedMean (protos) {
        if (!Array.isArray(protos) || protos.length === 0) {
            return new Float32Array(this._hiddenSize);
        }
        let totalSize = 0;
        for (const p of protos) {
            totalSize += p.size || 0;
        }
        if (totalSize === 0) {
            return new Float32Array(this._hiddenSize);
        }
        const rep = new Float32Array(this._hiddenSize);
        for (const p of protos) {
            const weight = (p.size || 0) / totalSize;
            this._fastVectorAdd(rep, p.mean, 1, weight, rep);
        }
        return rep;
    },

    _maxPairwiseKernel (protosA, protosB) {
        if (protosA.length === 0 || protosB.length === 0) return 0;
        let maxSim = 0;
        for (const a of protosA) {
            for (const b of protosB) {
                const sim = this._kernelSimilarity(a, b);
                if (sim > maxSim) maxSim = sim;
            }
        }
        return maxSim;
    },

    _projSimilarity (projsA, projsB) {
        if (!projsA || !projsB || projsA.length !== this._numProjections || projsB.length !== this._numProjections) {
            return 0;
        }
        // Inlined dot products. This is the hottest leaf in the engine (millions
        // of calls per predict thanks to _consolidateSemanticProtos' O(n^2)
        // sweep), and it used to pay one _fastVectorDot method call per
        // projection — pure overhead for a handful of multiply-adds.
        const numProj = this._numProjections;
        const lowDim = this._lowDim;
        let sumSim = 0;
        for (let np = 0; np < numProj; np++) {
            const a = projsA[np];
            const b = projsB[np];
            for (let i = 0; i < lowDim; i++) sumSim += a[i] * b[i];
        }
        return sumSim / numProj;
    }

};
