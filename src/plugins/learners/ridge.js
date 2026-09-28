import { CAPABILITIES } from '../../core/contracts/base.js';
import { isLearnerPlugin } from '../../core/contracts/learner.js';

export const RIDGE_DEFAULTS = Object.freeze({ lambda: 1e-2, standardise: true });

const finite = (x) => Number.isFinite(x);
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

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

function solveNormal(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        if (!(Math.abs(M[piv][col]) > 1e-12)) return null;
        if (piv !== col) { const tmp = M[piv]; M[piv] = M[col]; M[col] = tmp; }
        const pv = M[col][col];
        for (let c = col; c <= n; c++) M[col][c] /= pv;
        for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const f = M[r][col];
            if (f === 0) continue;
            for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
        }
    }
    return M.map((row) => row[n]);
}

function fitBatch(X, y, wt, lambda, standardise) {
    const scaler = standardise ? fitStandardiser(X) : null;
    const Z = standardise ? X.map((x) => applyStandardiser(scaler, x)) : X;
    const n = Z.length;
    const d = n ? Z[0].length : 0;
    let ybar = 0;
    let wsum = 0;
    for (let i = 0; i < n; i++) { ybar += y[i] * wt[i]; wsum += wt[i]; }
    ybar /= Math.max(1e-300, wsum);
    const p = d + 1;
    const A = Array.from({ length: p }, () => new Array(p).fill(0));
    const rhs = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
        const row = Z[i].concat([1]);
        const yc = (y[i] - ybar) * wt[i];
        for (let a = 0; a < p; a++) {
            rhs[a] += row[a] * yc;
            for (let b = a; b < p; b++) A[a][b] += row[a] * row[b] * wt[i];
        }
    }
    for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
    for (let j = 0; j < d; j++) A[j][j] += lambda;
    const w = solveNormal(A, rhs);
    if (!w) return null;
    return { scaler, standardise, d, ybar, w };
}

function predictBatch(model, x) {
    const z = model.standardise ? applyStandardiser(model.scaler, x) : x;
    let logit = 0;
    for (let j = 0; j < model.d; j++) logit += model.w[j] * z[j];
    logit += model.w[model.d];
    const base = sigmoid(logit);
    if (!Number.isFinite(model.ybar)) return base;
    const p = base + model.ybar - 0.5;
    return p < 0 ? 0 : p > 1 ? 1 : p;
}

export const ridgeLearner = {
    id: 'ridge',
    capability: CAPABILITIES.MODEL,
    legacy: false,
    defaults: RIDGE_DEFAULTS,

    create(options = {}) {
        const lambda = Number(options.lambda != null ? options.lambda : RIDGE_DEFAULTS.lambda);
        const standardise = options.standardise != null ? options.standardise !== false : true;
        if (!Number.isFinite(lambda) || !(lambda >= 0)) throw new Error('ridge needs a finite non-negative lambda');
        const X = [];
        const y = [];
        const wts = [];
        let dim = -1;
        const usable = (input, target) => {
            if (!Array.isArray(input) || !Number.isFinite(Number(target))) return false;
            if (dim < 0) dim = input.length;
            if (input.length !== dim || dim < 1) return false;
            for (const v of input) if (!finite(v)) return false;
            return true;
        };
        return {
            fit: (input, target, sampleWeight = 1) => {
                const w = Number(sampleWeight);
                if (!usable(input, target) || !Number.isFinite(w) || !(w > 0)) return X.length;
                X.push(input.slice()); y.push(Number(target)); wts.push(w);
                return X.length;
            },
            predict: (input) => {
                if (!X.length || !Array.isArray(input) || input.length !== dim) return 0;
                for (const v of input) if (!finite(v)) return 0;
                const model = fitBatch(X, y, wts, lambda, standardise);
                if (!model) return 0;
                return 2 * predictBatch(model, input) - 1;
            },
            diagnostics: () => ({ n: X.length, dim }),
        };
    },
};

export const isRidge = (impl) => isLearnerPlugin(impl) && impl.id === ridgeLearner.id;
