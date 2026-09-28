import { CAPABILITIES } from '../../core/contracts/base.js';
import { isLearnerPlugin } from '../../core/contracts/learner.js';

export const MLP_DEFAULTS = Object.freeze({ hidden: 8, epochs: 200, lr: 0.1, seed: 1, batch: 0, l2: 1e-5, standardise: true });

const finite = (x) => Number.isFinite(x);
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function fitStandardiser(X, { eps = 1e-8 } = {}) {
    const n = X.length;
    const d = n ? X[0].length : 0;
    const mean = new Array(d).fill(0);
    const std = new Array(d).fill(0);
    for (const x of X) for (let j = 0; j < d; j++) mean[j] += finite(x[j]) ? x[j] : 0;
    for (let j = 0; j < d; j++) mean[j] /= Math.max(1, n);
    for (const x of X) for (let j = 0; j < d; j++) { const dv = (finite(x[j]) ? x[j] : 0) - mean[j]; std[j] += dv * dv; }
    for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / Math.max(1, n)) + eps;
    return { mean, std, d };
}

function applyStandardiser(s, x) {
    const out = new Array(s.d);
    for (let j = 0; j < s.d; j++) out[j] = ((finite(x[j]) ? x[j] : 0) - s.mean[j]) / s.std[j];
    return out;
}

function fitBatch(X, y, { hidden, epochs, lr, seed, batch, l2, standardise }) {
    const scaler = standardise ? fitStandardiser(X) : null;
    const Z = standardise ? X.map((x) => applyStandardiser(scaler, x)) : X;
    const n = Z.length;
    const d = n ? Z[0].length : 0;
    const rng = mulberry32(seed >>> 0);
    const randn = () => {
        const u = Math.max(1e-9, rng());
        const v = rng();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const W1 = Array.from({ length: hidden }, () => Array.from({ length: d }, () => randn() * (1 / Math.sqrt(Math.max(1, d)))));
    const b1 = new Array(hidden).fill(0);
    const W2 = new Array(hidden).fill(0).map(() => randn() * (1 / Math.sqrt(Math.max(1, hidden))));
    let b2 = 0;
    const order = Array.from({ length: n }, (_, i) => i);
    const bs = Number.isFinite(batch) && batch > 0 ? Math.floor(batch) : n;
    for (let epoch = 0; epoch < epochs; epoch++) {
        for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
        for (let start = 0; start < n; start += bs) {
            const idx = order.slice(start, start + bs);
            const gW1 = Array.from({ length: hidden }, () => new Array(d).fill(0));
            const gb1 = new Array(hidden).fill(0);
            const gW2 = new Array(hidden).fill(0);
            let gb2 = 0;
            for (const i of idx) {
                const z = Z[i];
                const h = new Array(hidden);
                for (let k = 0; k < hidden; k++) {
                    let a = b1[k];
                    for (let j = 0; j < d; j++) a += W1[k][j] * z[j];
                    h[k] = Math.tanh(a);
                }
                let o = b2;
                for (let k = 0; k < hidden; k++) o += W2[k] * h[k];
                const p = sigmoid(o);
                const dz = p - y[i];
                for (let k = 0; k < hidden; k++) {
                    gW2[k] += dz * h[k];
                    const dh = dz * W2[k] * (1 - h[k] * h[k]);
                    gb1[k] += dh;
                    for (let j = 0; j < d; j++) gW1[k][j] += dh * z[j];
                }
                gb2 += dz;
            }
            const m = Math.max(1, idx.length);
            for (let k = 0; k < hidden; k++) {
                W2[k] -= lr * (gW2[k] / m + l2 * W2[k]);
                b1[k] -= lr * (gb1[k] / m);
                for (let j = 0; j < d; j++) W1[k][j] -= lr * (gW1[k][j] / m + l2 * W1[k][j]);
            }
            b2 -= lr * (gb2 / m);
        }
    }
    return { scaler, standardise, d, hidden, W1, b1, W2, b2 };
}

function predictBatch(model, x) {
    const z = model.standardise ? applyStandardiser(model.scaler, x) : x;
    let o = model.b2;
    for (let k = 0; k < model.hidden; k++) {
        let a = model.b1[k];
        const row = model.W1[k];
        for (let j = 0; j < model.d; j++) a += row[j] * z[j];
        o += model.W2[k] * Math.tanh(a);
    }
    return sigmoid(o);
}

export const mlpLearner = {
    id: 'mlp',
    capability: CAPABILITIES.MODEL,
    legacy: false,
    defaults: MLP_DEFAULTS,

    create(options = {}) {
        const cfg = { ...MLP_DEFAULTS, ...options };
        const hidden = Math.floor(Number(cfg.hidden));
        const epochs = Math.floor(Number(cfg.epochs));
        const lr = Number(cfg.lr);
        const seed = Number(cfg.seed) >>> 0;
        const batch = Number(cfg.batch);
        const l2 = Number(cfg.l2);
        const standardise = cfg.standardise !== false;
        if (!Number.isInteger(hidden) || hidden < 1) throw new Error('mlp needs a positive integer hidden');
        if (!Number.isInteger(epochs) || epochs < 1) throw new Error('mlp needs a positive integer epochs');
        if (!Number.isFinite(lr) || !(lr > 0)) throw new Error('mlp needs a positive finite lr');
        if (!Number.isFinite(l2) || !(l2 >= 0)) throw new Error('mlp needs a finite non-negative l2');
        const X = [];
        const y = [];
        let dim = -1;
        return {
            fit: (input, target, sampleWeight = 1) => {
                const w = Number(sampleWeight);
                if (!Array.isArray(input) || !Number.isFinite(Number(target))) return X.length;
                if (dim < 0) dim = input.length;
                if (input.length !== dim || dim < 1) return X.length;
                for (const v of input) if (!finite(v)) return X.length;
                if (!Number.isFinite(w) || !(w > 0) || w !== 1) return X.length;
                X.push(input.slice()); y.push(Number(target));
                return X.length;
            },
            predict: (input) => {
                if (!X.length || !Array.isArray(input) || input.length !== dim) return 0;
                for (const v of input) if (!finite(v)) return 0;
                const model = fitBatch(X, y, { hidden, epochs, lr, seed, batch, l2, standardise });
                return 2 * predictBatch(model, input) - 1;
            },
            diagnostics: () => ({ n: X.length, dim, hidden, epochs, seed }),
        };
    },
};

export const isMlp = (impl) => isLearnerPlugin(impl) && impl.id === mlpLearner.id;
