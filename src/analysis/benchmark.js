// P1 model-class benchmark forecasters (round 29 → 30).
//
// The round-29 diagnosis is that the controller has NEGATIVE forecast skill while
// the model-class literature says a tiny from-scratch permutation-invariant
// transformer over ~60 training bars is the wrong forecaster for this data and
// that a linear/MLP model usually dominates it (see
// `docs/research/round29-model-class.md`). P1 settles the question on THIS data:
// score the base rate, a ridge regression, a small MLP and (optionally) a
// pretrained time-series foundation model on the SAME walk-forward folds and the
// SAME causal features the existing bare path already uses, and compare them to
// the journaled controller.
//
// This module is PURE and deterministic: no I/O, no RNG outside a seeded
// `mulberry32`. A "forecaster" is `{ fit(X, y), predictProb(x) }` over a feature
// matrix; the harness in `analyze.js` owns the walk-forward split, the labels and
// the feature builder, so every model class reads byte-identical inputs.
//
// The forecast being scored is the one `analysis/forecast.js#forecastPairs`
// scores: `P(sign of the NEXT bar's return)` given information up to bar t.

import { mulberry32 } from '../legion/rng.js';

const finite = (x) => Number.isFinite(x);
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// ---------------------------------------------------------------------------
// Input standardisation (fit on the training fold only — a linear/MLP model
// cannot read raw return scales otherwise. Applying the training statistics to
// the test fold is causal; re-fitting on test would leak.)
// ---------------------------------------------------------------------------

export function fitStandardiser(X, { eps = 1e-8 } = {}) {
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

export function applyStandardiser(s, x) {
    const out = new Array(s.d);
    for (let j = 0; j < s.d; j++) out[j] = ((finite(x[j]) ? x[j] : 0) - s.mean[j]) / s.std[j];
    return out;
}

// ---------------------------------------------------------------------------
// Ridge (linear) regression — closed form, solved by Gaussian elimination with
// partial pivoting (no dependency, exact for the small `d` here).
// ---------------------------------------------------------------------------

function solveSPD(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        if (Math.abs(M[piv][col]) < 1e-12) continue;
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

export function fitRidge(X, y, { lambda = 1e-2, standardise = true } = {}) {
    const scaler = standardise ? fitStandardiser(X) : null;
    const Z = standardise ? X.map((x) => applyStandardiser(scaler, x)) : X;
    const n = Z.length;
    const d = n ? Z[0].length : 0;
    const ybar = n ? y.reduce((a, v) => a + v, 0) / n : 0;
    // Augment with an intercept column so the intercept is not penalised.
    const p = d + 1;
    const A = Array.from({ length: p }, () => new Array(p).fill(0));
    const rhs = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
        const z = Z[i];
        const row = z.concat([1]);
        const yc = y[i] - ybar;
        for (let a = 0; a < p; a++) {
            rhs[a] += row[a] * yc;
            for (let b = a; b < p; b++) A[a][b] += row[a] * row[b];
        }
    }
    for (let a = 0; a < p; a++) { for (let b = 0; b < a; b++) A[a][b] = A[b][a]; }
    for (let j = 0; j < d; j++) A[j][j] += lambda;   // no penalty on the intercept
    const w = solveSPD(A, rhs);
    return { kind: 'linear', scaler, standardise, d, ybar, w, predict: null };
}

export function predictRidge(model, x) {
    const z = model.standardise ? applyStandardiser(model.scaler, x) : x;
    let logit = 0;
    for (let j = 0; j < model.d; j++) logit += model.w[j] * z[j];
    logit += model.w[model.d];
    return sigmoid(logit);
}

// ---------------------------------------------------------------------------
// A small MLP (one hidden layer, tanh, sigmoid output), full-batch or mini-batch
// SGD with a seeded init/shuffle. This is the "MLP-mixer-class" arm of P1 in the
// sense the plan means: a generic nonlinear function approximator over a
// lagged-feature window, not a from-scratch transformer.
// ---------------------------------------------------------------------------

export function fitMLP(X, y, {
    hidden = 8, epochs = 200, lr = 0.1, seed = 1, batch = 0, l2 = 1e-5, standardise = true,
} = {}) {
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
        // Fisher–Yates with the seeded rng (deterministic).
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
    return { kind: 'mlp', scaler, standardise, d, hidden, W1, b1, W2, b2 };
}

export function predictMLP(model, x) {
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

// ---------------------------------------------------------------------------
// The base rate: predict the training fold's outcome frequency, for every bar.
// This is the reference the proper-skill readout is measured against
// (`brierBaseline = p̄(1−p̄)`), and the arm the literature says a from-scratch
// model must beat to claim any skill at all.
// ---------------------------------------------------------------------------

export function fitBaseRate(X, y) {
    const p = y.length ? y.reduce((a, v) => a + v, 0) / y.length : 0.5;
    return { kind: 'base-rate', p };
}

export function predictBaseRate(model) {
    return model.p;
}

// ---------------------------------------------------------------------------
// Uniform forecaster interface + factory.
// ---------------------------------------------------------------------------

export const BENCHMARK_KINDS = Object.freeze(['base-rate', 'linear', 'mlp', 'tsfm']);

export function makeBenchmarkForecaster(kind, opts = {}) {
    switch (kind) {
        case 'base-rate':
            return { kind, fit: (X, y) => fitBaseRate(X, y), predictProb: (m, x) => predictBaseRate(m, x) };
        case 'linear':
            return { kind, fit: (X, y) => fitRidge(X, y, opts), predictProb: (m, x) => predictRidge(m, x) };
        case 'mlp':
            return { kind, fit: (X, y) => fitMLP(X, y, opts), predictProb: (m, x) => predictMLP(m, x) };
        case 'tsfm':
            // A pretrained time-series foundation model is a pluggable arm: it is
            // "one arm, offline, and droppable" (PLAN-round29.md §8). Without a
            // bundled pretrained checkpoint there is nothing to load, so the arm
            // reports `not-run` rather than silently fitting something else.
            throw new Error('makeBenchmarkForecaster: the tsfm arm requires a pretrained checkpoint (not bundled) — run it as `not-run` in the P1 table');
        default:
            throw new Error(`makeBenchmarkForecaster: unknown kind "${kind}" (known: ${BENCHMARK_KINDS.join(', ')})`);
    }
}
