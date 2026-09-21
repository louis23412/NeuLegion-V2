// HiveMind component: sampling
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
export const samplingMethods = {
    _randomNormal (mean = 0, stdDev = 1) {
        let sum = 0;
        for (let i = 0; i < 12; i += 1) {
            sum += Math.random();
        }
        return mean + stdDev * (sum - 6);
    },

    _sampleDirichlet (count) {
        if (count < 1) return [];
        const gammas = [];
        for (let i = 0; i < count; i++) {
            let g = 0;
            while (g <= 0) g = -Math.log(Math.random() || 1e-10);
            gammas.push(g);
        }
        const sum = gammas.reduce((a, b) => a + b, 0);
        return gammas.map(g => g / sum);
    },

    _generateProjectionMatrix () {
        const invSqrtLow = 1 / Math.sqrt(this._lowDim);
        const matrix = new Array(this._hiddenSize);
        for (let d = 0; d < this._hiddenSize; d++) {
            const row = new Float32Array(this._lowDim);
            for (let l = 0; l < this._lowDim; l++) {
                const u = 1 - Math.random();
                const v = Math.random();
                const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
                row[l] = g * invSqrtLow;
            }
            matrix[d] = row;
        }
        return matrix;
    },

    _generateLshHyperplanesLow () {
        return Array.from({length: this._lshNumTables}, () =>
            Array.from({length: this._lshHashBits}, () => {
                const vec = new Float32Array(this._lowDim);
                let normSq = 0;
                for (let d = 0; d < this._lowDim; d++) {
                    vec[d] = this._randomNormal(0, 1);
                    normSq += vec[d] * vec[d];
                }
                const norm = Math.sqrt(normSq) || 1;
                for (let d = 0; d < this._lowDim; d++) {
                    vec[d] /= norm;
                }
                return vec;
            })
        );
    },

    _dynamicInit (rows, cols, layerIndex, totalLayers, customK = null) {
        let baseK = customK !== null ? customK : 2.2;
        let fanInScale = Math.min(1.0, 1000 / rows);
        let depthScale = Math.pow(totalLayers, -layerIndex / totalLayers);
        let k = baseK * fanInScale * depthScale;
        k = Math.max(1.5, Math.min(k, 3.0));

        return Array(rows).fill().map(() =>
            Array(cols).fill().map(() => (Math.random() - 0.5) * Math.sqrt(k / rows))
        );
    }

};
