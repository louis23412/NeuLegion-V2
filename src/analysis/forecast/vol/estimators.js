// src/analysis/forecast/vol/estimators.js (round-109 split of src/analysis/forecast/vol.js).
// Vol estimators: realized vol, EWMA/AR/ridge-AR fits, MSE/QLIKE skills.
// Moved byte-exact; re-exported by the vol.js shim.
export function realizedVolatility(returns, window) {
    if (!Array.isArray(returns) || !Number.isInteger(window) || window < 1) return [];
    const n = returns.length;
    if (n < window) return [];
    const out = [];
    let sumSq = 0;
    for (let i = 0; i < window; i++) {
        const x = returns[i];
        sumSq += Number.isFinite(x) ? x * x : 0;
    }
    out.push(Math.sqrt(sumSq / window));
    for (let t = window; t < n; t++) {
        const a = returns[t];
        const d = returns[t - window];
        if (Number.isFinite(a)) sumSq += a * a;
        if (Number.isFinite(d)) sumSq -= d * d;
        out.push(Math.sqrt(Math.max(0, sumSq) / window));
    }
    return out;
}

export function ewmaVolForecast(vols, { lambda = 0.94 } = {}) {
    if (!Array.isArray(vols) || !vols.length) return [];
    if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1) throw new Error(`ewmaVolForecast: lambda must be in [0,1] (got ${lambda}) (W4b)`);
    const out = new Array(vols.length);
    out[0] = vols[0];
    for (let t = 1; t < vols.length; t++) {
        const prev = vols[t - 1];
        out[t] = lambda * out[t - 1] + (1 - lambda) * (Number.isFinite(prev) ? prev : out[t - 1]);
    }
    return out;
}

export function volForecastSkill(actual, forecast, baseline) {
    const mse = (a, f) => {
        let sum = 0;
        let n = 0;
        const len = Math.min(Array.isArray(a) ? a.length : 0, Array.isArray(f) ? f.length : 0);
        for (let i = 0; i < len; i++) {
            if (!Number.isFinite(a[i]) || !Number.isFinite(f[i])) continue;
            const d = a[i] - f[i];
            sum += d * d;
            n++;
        }
        return n ? sum / n : NaN;
    };
    const mf = mse(actual, forecast);
    const mb = mse(actual, baseline);
    if (!Number.isFinite(mf) || !Number.isFinite(mb) || !(mb > 0)) return { available: false, reason: 'insufficient finite pairs or non-positive baseline MSE (W4b)' };
    return { available: true, mseForecast: mf, mseBaseline: mb, skill: 1 - mf / mb };
}

export function fitArVolForecast(trainVols, { order = 1 } = {}) {
    if (!Array.isArray(trainVols) || !Number.isInteger(order) || order < 1) return { available: false, reason: 'order must be a positive integer (W4b-t)' };
    const p = order + 1;
    const rows = [];
    const ys = [];
    for (let t = order; t < trainVols.length; t++) {
        const yt = trainVols[t];
        if (!Number.isFinite(yt)) continue;
        const row = [1];
        let ok = true;
        for (let k = 1; k <= order; k++) {
            const v = trainVols[t - k];
            if (!Number.isFinite(v)) { ok = false; break; }
            row.push(v);
        }
        if (!ok) continue;
        rows.push(row);
        ys.push(yt);
    }
    if (rows.length < p + 1) return { available: false, reason: 'insufficient finite rows to fit AR (W4b-t)' };
    const xtx = Array.from({ length: p }, () => new Array(p).fill(0));
    const xty = new Array(p).fill(0);
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        for (let a = 0; a < p; a++) {
            xty[a] += r[a] * ys[i];
            for (let b = 0; b < p; b++) xtx[a][b] += r[a] * r[b];
        }
    }
    const aug = xtx.map((row, i) => row.concat([xty[i]]));
    for (let c = 0; c < p; c++) {
        let piv = c;
        for (let r = c + 1; r < p; r++) if (Math.abs(aug[r][c]) > Math.abs(aug[piv][c])) piv = r;
        if (!(Math.abs(aug[piv][c]) > 1e-12)) return { available: false, reason: 'singular AR normal equations (W4b-t)' };
        const tmp = aug[c]; aug[c] = aug[piv]; aug[piv] = tmp;
        const d = aug[c][c];
        for (let k = c; k <= p; k++) aug[c][k] /= d;
        for (let r = 0; r < p; r++) {
            if (r === c) continue;
            const f = aug[r][c];
            if (f === 0) continue;
            for (let k = c; k <= p; k++) aug[r][k] -= f * aug[c][k];
        }
    }
    return { available: true, order, coef: aug.map((row) => row[p]), rows: rows.length };
}

export function predictArVolForecast(fit, history) {
    const coef = Array.isArray(fit) ? fit : (fit && fit.coef);
    if (!Array.isArray(coef) || !coef.length) return NaN;
    const order = coef.length - 1;
    if (!Array.isArray(history) || history.length < order) return NaN;
    let y = coef[0];
    for (let k = 1; k <= order; k++) {
        const v = history[history.length - k];
        if (!Number.isFinite(v)) return NaN;
        y += coef[k] * v;
    }
    return y;
}

export function volForecastQlike(actual, forecast, baseline) {
    const qlike = (a, f) => {
        let sum = 0;
        let n = 0;
        const len = Math.min(Array.isArray(a) ? a.length : 0, Array.isArray(f) ? f.length : 0);
        for (let i = 0; i < len; i++) {
            if (!Number.isFinite(a[i]) || !Number.isFinite(f[i]) || !(a[i] > 0) || !(f[i] > 0)) continue;
            const r = f[i] / a[i];
            sum += r - Math.log(r) - 1;
            n++;
        }
        return n ? sum / n : NaN;
    };
    const qf = qlike(actual, forecast);
    const qb = qlike(actual, baseline);
    if (!Number.isFinite(qf) || !Number.isFinite(qb) || !(qb > 0)) return { available: false, reason: 'insufficient positive pairs or non-positive baseline QLIKE (W4b-q)' };
    return { available: true, qlikeForecast: qf, qlikeBaseline: qb, skill: 1 - qf / qb };
}

export function fitRidgeArVolForecast(trainVols, { order = 1, l2 = 0 } = {}) {
    if (!Array.isArray(trainVols) || !Number.isInteger(order) || order < 1) return { available: false, reason: 'order must be a positive integer (W4b-r)' };
    if (!Number.isFinite(l2) || l2 < 0) return { available: false, reason: 'l2 must be a finite non-negative penalty (W4b-r)' };
    if (!(l2 > 0)) return { ...fitArVolForecast(trainVols, { order }), l2 };
    const p = order + 1;
    const rows = [];
    const ys = [];
    for (let t = order; t < trainVols.length; t++) {
        const yt = trainVols[t];
        if (!Number.isFinite(yt)) continue;
        const row = [1];
        let ok = true;
        for (let k = 1; k <= order; k++) {
            const v = trainVols[t - k];
            if (!Number.isFinite(v)) { ok = false; break; }
            row.push(v);
        }
        if (!ok) continue;
        rows.push(row);
        ys.push(yt);
    }
    if (rows.length < p + 1) return { available: false, reason: 'insufficient finite rows to fit ridge-AR (W4b-r)' };
    const xtx = Array.from({ length: p }, () => new Array(p).fill(0));
    const xty = new Array(p).fill(0);
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        for (let a = 0; a < p; a++) {
            xty[a] += r[a] * ys[i];
            for (let b = 0; b < p; b++) xtx[a][b] += r[a] * r[b];
        }
    }
    for (let k = 1; k < p; k++) xtx[k][k] += l2;
    const aug = xtx.map((row, i) => row.concat([xty[i]]));
    for (let c = 0; c < p; c++) {
        let piv = c;
        for (let r = c + 1; r < p; r++) if (Math.abs(aug[r][c]) > Math.abs(aug[piv][c])) piv = r;
        if (!(Math.abs(aug[piv][c]) > 1e-12)) return { available: false, reason: 'singular ridge-AR normal equations (W4b-r)' };
        const tmp = aug[c]; aug[c] = aug[piv]; aug[piv] = tmp;
        const d = aug[c][c];
        for (let k = c; k <= p; k++) aug[c][k] /= d;
        for (let r = 0; r < p; r++) {
            if (r === c) continue;
            const f = aug[r][c];
            if (f === 0) continue;
            for (let k = c; k <= p; k++) aug[r][k] -= f * aug[c][k];
        }
    }
    return { available: true, order, l2, coef: aug.map((row) => row[p]), rows: rows.length };
}
