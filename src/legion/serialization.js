// NeuLegion legion component: blob/JSON/hash/distance helpers
//
// Split out of the original monolithic src/mainController.js; the bodies are
// byte-identical apart from the shared mutable state being read/written as
// properties of the `state` holder (see ./state.js). src/mainController.js is
// now just the entry point that runs ./legion/runner.js.

export const vectorToBlob = (vec) => {
    if (!Array.isArray(vec) || vec.length === 0) return Buffer.allocUnsafe(0);
    const f64 = new Float64Array(vec);
    return Buffer.from(f64.buffer, f64.byteOffset, f64.byteLength);
};

export const blobToVector = (blob) => {
    if (!Buffer.isBuffer(blob) || blob.length === 0 || blob.length % 8 !== 0) return [];
    const f64 = new Float64Array(blob.buffer, blob.byteOffset, blob.length / 8);
    return Array.from(f64);
};

export const canonicalJSON = (obj) => {
    if (obj === null || typeof obj !== 'object') {
        return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
        return '[' + obj.map(canonicalJSON).join(',') + ']';
    }
    const keys = Object.keys(obj).sort();
    const parts = keys.map(k => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`);
    return '{' + parts.join(',') + '}';
};

export const computeContentHash = (mean) => {
    let hash = 2166136261;
    for (let i = 0; i < mean.length; i++) {
        let iv = Math.floor(mean[i] * 10000 + 0.5);
        hash ^= iv;
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return ((hash >>> 0) % 0xFFFFFFFF).toString(16).padStart(8, '0');
};

export const computeGaussianDistance = (mu1, var1, mu2, var2) => {
    const d = mu1.length;
    if (d !== mu2.length || d === 0) return Infinity;

    const eps = 1e-8;
    let mahalTerm = 0;
    let logDetTerm = 0;

    for (let j = 0; j < d; j++) {
        const v1 = Math.max(var1[j], eps);
        const v2 = Math.max(var2[j], eps);
        const avgV = (v1 + v2) / 2;
        const dm = mu1[j] - mu2[j];

        mahalTerm += (dm * dm) / avgV;
        logDetTerm += Math.log(avgV / Math.sqrt(v1 * v2));
    }

    return (1/8) * mahalTerm + (1/2) * logDetTerm;
};
