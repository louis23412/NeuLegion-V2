// HiveMind component: statistics
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.

export const statisticsMethods = {
    _computeVariance (arr) {
        if (arr.length < 2) return 0;

        const median = arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
        const mad = arr.reduce((sum, val) => sum + Math.abs(val - median), 0) / Math.max(arr.length, 1);

        return Math.min(mad, 10);
    },

    _computeEMA (arr, beta) {
        if (arr.length === 0) return 0;

        let ema = arr[0];
        for (let i = 1; i < arr.length; i++) {
            ema = beta * ema + (1 - beta) * arr[i];
        }

        return ema;
    },

    _computeDualEMA (arr, betaShort, betaLong) {
        const shortEMA = this._computeEMA(arr, betaShort);
        const longEMA = this._computeEMA(arr, betaLong);
        const variance = this._computeVariance(arr.slice(-10));
        const svrWeight = Math.min(0.8, Math.max(0.2, 0.5 * (1 - variance / (variance + 1))));

        return svrWeight * shortEMA + (1 - svrWeight) * longEMA;
    },

    _computeGradientConformity (norms) {
        if (norms.length < 2) return 1;

        const directions = norms.slice(1).map((val, i) => Math.sign(val - norms[i]));
        const consistency = directions.reduce((sum, val, i, arr) => sum + (i > 0 && val === arr[i - 1] ? 1 : 0), 0) / (directions.length || 1);

        return Math.min(1, Math.max(0.5, consistency));
    },

    _computeKernelRate (history) {
        // NOTE: index the *window* (last 10) rather than the full history. The
        // original used Math.floor(history.length / 2) against a 10-element
        // slice, so once history exceeded 19 entries the index fell out of
        // bounds, `|| 0` forced the median to 0, and the normalised values blew
        // up — pinning the adaptive EMA betas at their maximum.
        const recent = history.slice(-10);
        const median = recent.slice().sort((a, b) => a - b)[Math.floor(recent.length / 2)] || 0;
        const scaledHistory = recent.map(val => (val - median) / (Math.abs(median) + 1e-10));
        const kernel = scaledHistory.map((val, i) => Math.exp(-0.1 * (scaledHistory.length - i - 1) ** 2));
        const kernelSum = kernel.reduce((sum, val) => sum + val, 0);

        return kernelSum > 0 ? kernel.reduce((sum, val, i) => sum + val * scaledHistory[i], 0) / kernelSum + 0.9 : 0.9;
    },

    _computeFractalDimension (arr) {
        if (arr.length < 2) return 1;

        const diffs = arr.slice(1).map((val, i) => Math.abs(val - arr[i]));
        const logDiffs = diffs.map(d => Math.log(Math.max(d, 1e-10)));
        const logScale = Math.log(arr.length);
        const fractalDim = logDiffs.length > 0 ? Math.abs(logDiffs.reduce((sum, val) => sum + val, 0) / logScale) : 1;

        return Math.min(2, Math.max(1, fractalDim));
    },

    _computePercentile (norms, percentile) {
        const sortedNorms = [...norms].sort((a, b) => a - b);
        const index = Math.floor(percentile * (sortedNorms.length - 1));

        return sortedNorms[index] || 1.0;
    },

    _computeNTKStability (norms, lossVariance) {
        if (norms.length < 2) return 1;

        const average = (arr) => arr.reduce((sum, val) => sum + val, 0) / Math.max(arr.length, 1);

        const recentNorms = norms.slice(-10);
        const medianNorm = recentNorms.slice().sort((a, b) => a - b)[Math.floor(recentNorms.length / 2)] || 1;
        const bandwidth = Math.min(-0.01, Math.max(-0.1, -0.05 / (1 + lossVariance * medianNorm)));
        const kernel = recentNorms.map((val) => Math.exp(bandwidth * (val - average(norms)) ** 2));
        const stability = kernel.reduce((sum, val) => sum + val, 0) / kernel.length;

        return Math.min(1.5, Math.max(0.5, stability));
    },

    _computeDynamicPercentile (norms, basePercentile) {
        const mad = this._computeVariance(norms);
        const smoothness = this._computeGradientConformity(norms);
        const adjustment = Math.min(0.05, (mad + 0.1 * smoothness) / (mad + smoothness + 1));

        return Math.min(0.99, Math.max(0.75, basePercentile - adjustment));
    },

    _computeSparseThreshold (norms) {
        const mad = this._computeVariance(norms);

        return Math.max(1e-6, Math.min(1e-4, mad / 10));
    },

    _computeSpectralNorm (matrix) {
        const fail = (message) => {
            const error = new Error(message);
            console.error('Error:', message, '\nStack:', error.stack);
            throw error;
        };

        if (!Array.isArray(matrix)) fail('Input is not an array');
        const rows = matrix.length;
        if (rows === 0) fail('Matrix is empty');
        if (!Array.isArray(matrix[0])) fail('Matrix rows are not arrays');
        const cols = matrix[0].length;
        if (cols === 0) fail('Matrix has no columns');
        for (let i = 0; i < rows; i++) {
            const row = matrix[i];
            if (!Array.isArray(row)) fail('Matrix rows are not arrays');
            if (row.length !== cols) fail('Matrix rows have inconsistent lengths');
            for (let j = 0; j < cols; j++) {
                if (typeof row[j] !== 'number' || !Number.isFinite(row[j])) fail('Matrix contains invalid numbers');
            }
        }

        // Power iteration on the (small) gradient matrix. Entries were validated
        // above, so the inner loops use plain arithmetic instead of isValidNumber
        // -- this method sits in the per-step training hot path.
        const u = new Float64Array(cols);
        const v = new Float64Array(rows);
        const temp = new Float64Array(rows);

        for (let j = 0; j < cols; j++) u[j] = Math.random();
        let uNorm = 0;
        for (let j = 0; j < cols; j++) uNorm += u[j] * u[j];
        uNorm = Math.sqrt(uNorm) || 1;
        for (let j = 0; j < cols; j++) u[j] /= uNorm;

        const maxIter = 20;
        const tolerance = 1e-6;
        let prevNorm = 0;
        let currentNorm = 0;

        for (let iter = 0; iter < maxIter; iter++) {
            // v = A u
            for (let i = 0; i < rows; i++) {
                const row = matrix[i];
                let sum = 0;
                for (let j = 0; j < cols; j++) sum += row[j] * u[j];
                v[i] = sum;
            }
            let vNorm = 0;
            for (let i = 0; i < rows; i++) vNorm += v[i] * v[i];
            vNorm = Math.sqrt(vNorm) || 1;
            for (let i = 0; i < rows; i++) v[i] /= vNorm;

            // u = A^T v
            for (let j = 0; j < cols; j++) u[j] = 0;
            for (let i = 0; i < rows; i++) {
                const row = matrix[i];
                const vi = v[i];
                for (let j = 0; j < cols; j++) u[j] += row[j] * vi;
            }
            let newUNorm = 0;
            for (let j = 0; j < cols; j++) newUNorm += u[j] * u[j];
            newUNorm = Math.sqrt(newUNorm) || 1;
            for (let j = 0; j < cols; j++) u[j] /= newUNorm;

            // Rayleigh quotient estimate of the spectral norm.
            for (let i = 0; i < rows; i++) {
                const row = matrix[i];
                let sum = 0;
                for (let j = 0; j < cols; j++) sum += row[j] * u[j];
                temp[i] = sum;
            }
            let norm = 0;
            for (let i = 0; i < rows; i++) norm += temp[i] * v[i];
            currentNorm = Math.abs(norm) || 1;

            if (iter > 0 && Math.abs(currentNorm - prevNorm) < tolerance * Math.max(1, currentNorm)) {
                return currentNorm;
            }
            prevNorm = currentNorm;
        }

        return currentNorm || 1;
    },

    _computeGradientNorm (grad, isMatrix) {
        let sum = 0;
        if (isMatrix) {
            for (let i = 0; i < grad.length; i++) {
                const row = grad[i];
                if (!Array.isArray(row)) continue;
                for (let j = 0; j < row.length; j++) {
                    const val = row[j];
                    if (typeof val === 'number' && Number.isFinite(val)) sum += val * val;
                }
            }
        } else {
            for (let i = 0; i < grad.length; i++) {
                const val = grad[i];
                if (typeof val === 'number' && Number.isFinite(val)) sum += val * val;
            }
        }
        return Math.sqrt(sum) || 1;
    },

    _detectSuddenDrop (transformerIdx) {
        const hist = this._historicalPerformance[transformerIdx];

        const minHistDrop = Math.max(6, Math.round(this._contextWindow * 0.06));
        if (hist.length < minHistDrop) return 1.0;

        const current = this._performanceScores[transformerIdx] ?? 0.5;

        const recentFraction = 0.06 + 0.04 * this._memoryFactor;
        const numRecentPoints = Math.max(5, Math.round(this._maxPerformanceHistory * recentFraction));

        let prevSum = 0;
        let count = 0;
        const startIdx = Math.max(0, hist.length - numRecentPoints - 2);
        for (let i = startIdx; i < hist.length - 2; i++) {
            if (i >= 0 && i < hist.length) {
                prevSum += hist[i];
                count++;
            }
        }
        const prevMean = count > 0 ? prevSum / count : current;

        const drop = prevMean - current;

        const severeDropThresh = 0.10 + 0.08 * (1 - this._protoCapacityFactor);
        const moderateDropThresh = 0.05 + 0.05 * (1 - this._protoCapacityFactor);
        const adaptiveAllowance = 0.06 + 0.06 * (1 - this._protoCapacityFactor);

        if (drop > severeDropThresh + adaptiveAllowance * (1 - prevMean)) return 3.0;
        if (drop > moderateDropThresh) return 1.8;
        return 1.0;
    },

    _isStagnating (transformerIdx) {
        const history = this._historicalPerformance[transformerIdx];

        const minHistStag = Math.max(5, Math.round(this._contextWindow * 0.05));
        if (history.length < minHistStag) return false;

        const recent = history.slice(-minHistStag);
        const currentPerf = this._performanceScores[transformerIdx] ?? 0.5;
        const meanRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((a, v) => a + (v - meanRecent) ** 2, 0) / recent.length;
        const trend = currentPerf - recent[0];

        const lowVarianceThreshold = 0.004 + 0.008 * (1 - this._protoCapacityFactor);
        const noProgressThreshold = 0.005 + 0.01 * (1 - this._protoCapacityFactor);

        const lowVariance = variance < lowVarianceThreshold;
        const noProgress = trend < noProgressThreshold;

        const avgProtoVar = this._getAvgProtoVariance(transformerIdx);
        const protoVarThreshold = this._maxVariancePerDim * 0.12;
        const lowProtoVariance = avgProtoVar < protoVarThreshold;

        return lowVariance || noProgress || lowProtoVariance;
    }

};
