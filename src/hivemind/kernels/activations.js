// HiveMind component: activations
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
import { isFiniteNumber } from '../utils.js';

export const activationMethods = {
    _silu (x) {
        if (!isFiniteNumber(x)) return 0;
        const sig = 1 / (1 + Math.exp(-x));
        return x * sig;
    },

    _siluDerivative (x) {
        if (!isFiniteNumber(x)) return 0;
        const sig = 1 / (1 + Math.exp(-x));
        return sig * (1 + x * (1 - sig));
    },

    _sigmoid (x) {
        return isFiniteNumber(x) ? 1 / (1 + Math.exp(-Math.min(Math.max(x, -100), 100))) : 0;
    },

    _softmax (arr, out = null) {
        const n = arr.length;
        // The validity scan and the max scan are fused into one pass. The
        // early-return-on-invalid contract is unchanged (the scan still stops
        // at the first non-finite element and yields a uniform distribution).
        // All three call sites pass arithmetic-derived number arrays, so
        // `Number.isFinite` is exactly equivalent to `isFiniteNumber` here
        // (which additionally accepts numeric strings) and is a pure intrinsic.
        let max = -Infinity;
        for (let i = 0; i < n; i++) {
            const v = arr[i];
            if (!Number.isFinite(v)) {
                const uniform = out || new Array(n);
                for (let j = 0; j < n; j++) uniform[j] = 1 / n;
                return uniform;
            }
            if (v > max) max = v;
        }
        const res = out || new Array(n);
        let sum = 0;
        for (let i = 0; i < n; i++) {
            const e = Math.exp(arr[i] - max);
            res[i] = e;
            sum += e;
        }
        sum = sum || 1;
        for (let i = 0; i < n; i++) res[i] = res[i] / sum;
        return res;
    }

};
