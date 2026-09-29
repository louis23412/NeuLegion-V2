// Volatility forecasting core (W4b, rounds 49-53) — split from
// `analysis/forecast.js` in round 71 (byte-exact move; the `forecast.js`
// re-export shim keeps every import path working). Realized vol, the
// EWMA/AR/ridge-AR fits, the model slot, the split/panel/ladder tournaments,
// QLIKE and the promotion decision. Self-contained: no imports.

// ---------------------------------------------------------------------------
// W4b (round 49): the winnable job — realized-volatility forecasting.
// ---------------------------------------------------------------------------
// Direction is not predictable at this horizon (G-A, F-06…F-09); volatility is
// the one documented predictability in returns, and F-16/L09 already showed a
// causal EWMA is the forecaster to use. These three pure helpers are the
// measurement the model must beat out of sample at matched exposure before it
// earns a place in the default path. Additive: no scored path reads them.
//
// `realizedVolatility(returns, window)`: causal rolling root-mean-square of
// returns — the realized-vol proxy. Returns an array of length
// max(0, n-window+1) (no null padding, so a caller can align it explicitly).
// `ewmaVolForecast(vols, {lambda})`: causal one-step-ahead EWMA (RiskMetrics
// 1996, lambda=0.94 daily): out[0] = vols[0], out[t] = lambda*out[t-1] +
// (1-lambda)*vols[t-1]. `volForecastSkill(actual, forecast, baseline)`: the
// MSE skill 1 - MSE(f)/MSE(b), NaN when either MSE is not positive-finite.
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

export function tournamentVolForecast(vols, { split = 0.5, lambda = 0.94, order = 1 } = {}) {
    if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4b-t)' };
    if (!Number.isFinite(split) || split <= 0 || split >= 1) return { available: false, reason: 'split must be in (0,1) (W4b-t)' };
    for (const v of vols) if (!Number.isFinite(v)) return { available: false, reason: 'non-finite vol (W4b-t)' };
    const n = vols.length;
    const trainN = Math.floor(n * split);
    if (!(trainN >= order + 2) || !(n - trainN >= 2)) return { available: false, reason: 'split leaves too little train or test (W4b-t)' };
    const train = vols.slice(0, trainN);
    const test = vols.slice(trainN);
    const fit = fitArVolForecast(train, { order });
    if (!fit.available) return { available: false, reason: fit.reason };
    let ewmaFull;
    try { ewmaFull = ewmaVolForecast(vols, { lambda }); } catch (e) { return { available: false, reason: String((e && e.message) || e) }; }
    let mean = 0;
    for (const v of train) mean += v;
    mean /= train.length;
    const actual = [];
    const ewma = [];
    const ar = [];
    const flat = [];
    for (let j = 0; j < test.length; j++) {
        const g = trainN + j;
        const hist = vols.slice(g - order, g);
        if (hist.length < order) continue;
        const p = predictArVolForecast(fit, hist);
        if (!Number.isFinite(p)) continue;
        actual.push(test[j]);
        ewma.push(ewmaFull[g]);
        ar.push(p);
        flat.push(mean);
    }
    if (actual.length < 2) return { available: false, reason: 'insufficient OOS points (W4b-t)' };
    const se = volForecastSkill(actual, ewma, flat);
    const sa = volForecastSkill(actual, ar, flat);
    if (!se.available || !sa.available) return { available: false, reason: 'degenerate OOS baseline (W4b-t)' };
    const ewmaSkill = se.skill;
    const arSkill = sa.skill;
    return {
        available: true, n, trainN, testN: actual.length, order, lambda,
        coef: fit.coef.slice(),
        mseBaseline: se.mseBaseline, mseEwma: se.mseForecast, mseAr: sa.mseForecast,
        ewmaSkill, arSkill,
        winner: arSkill > ewmaSkill ? 'ar' : 'ewma',
        beatsEwma: arSkill > ewmaSkill,
    };
}

export function tournamentVolForecastAcrossSplits(vols, { splits = [0.3, 0.4, 0.5, 0.6, 0.7], lambda = 0.94, order = 1 } = {}) {
    if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4b-s)' };
    if (!Array.isArray(splits) || !splits.length) return { available: false, reason: 'splits must be a non-empty array (W4b-s)' };
    for (const s of splits) if (!Number.isFinite(s) || s <= 0 || s >= 1) return { available: false, reason: 'every split must be in (0,1) (W4b-s)' };
    const perSplit = [];
    for (const s of splits) {
        const t = tournamentVolForecast(vols, { split: s, lambda, order });
        if (!t.available) return { available: false, reason: `split ${s}: ${t.reason}` };
        perSplit.push({ split: s, ewmaSkill: t.ewmaSkill, arSkill: t.arSkill, winner: t.winner });
    }
    const arWins = perSplit.filter((p) => p.winner === 'ar').length;
    return {
        available: true, n: vols.length, splits: splits.slice(), lambda, order,
        perSplit, arWins, ewmaWins: perSplit.length - arWins,
        arWinFraction: arWins / perSplit.length,
        ewmaAlwaysPositive: perSplit.every((p) => p.ewmaSkill > 0),
    };
}

export function tournamentVolModel(actual, { ewma = null, ar = null, model = null, baseline = null } = {}) {
    if (!Array.isArray(actual) || !actual.length) return { available: false, reason: 'actual must be a non-empty array (W4b-m)' };
    for (const v of actual) if (!Number.isFinite(v)) return { available: false, reason: 'non-finite actual (W4b-m)' };
    const entries = { ewma, ar, model };
    for (const [k, f] of Object.entries(entries)) {
        if (!Array.isArray(f) || f.length !== actual.length) return { available: false, reason: `${k} must match actual length (W4b-m)` };
        for (const v of f) if (!Number.isFinite(v)) return { available: false, reason: `non-finite ${k} forecast (W4b-m)` };
    }
    const n = actual.length;
    const mean = actual.reduce((a, b) => a + b, 0) / n;
    const base = Array.isArray(baseline) && baseline.length === n ? baseline : new Array(n).fill(mean);
    const skills = {};
    for (const [k, f] of Object.entries(entries)) {
        const s = volForecastSkill(actual, f, base);
        if (!s.available) return { available: false, reason: `${k}: ${s.reason}` };
        skills[k] = s.skill;
    }
    const order = ['model', 'ar', 'ewma'];
    let winner = 'ewma';
    for (const k of order) if (skills[k] > skills[winner]) winner = k;
    return {
        available: true, n,
        skillEwma: skills.ewma, skillAr: skills.ar, skillModel: skills.model,
        winner, modelBeatsReferences: skills.model > skills.ewma && skills.model > skills.ar,
    };
}

export function tournamentVolPanel(volsByStream, { splits = [0.3, 0.4, 0.5, 0.6, 0.7], lambda = 0.94, order = 1 } = {}) {
    if (!volsByStream || typeof volsByStream !== 'object' || Array.isArray(volsByStream)) return { available: false, reason: 'volsByStream must be a {id: vols} object (W4b-p)' };
    const ids = Object.keys(volsByStream);
    if (!ids.length) return { available: false, reason: 'volsByStream must not be empty (W4b-p)' };
    const perStream = {};
    for (const id of ids) {
        const t = tournamentVolForecastAcrossSplits(volsByStream[id], { splits, lambda, order });
        if (!t.available) return { available: false, reason: `${id}: ${t.reason}` };
        perStream[id] = t;
    }
    const arMajority = ids.filter((id) => perStream[id].arWinFraction > 0.5);
    const ewmaClean = ids.filter((id) => perStream[id].ewmaAlwaysPositive);
    return {
        available: true, streams: ids.length, splits: splits.slice(), lambda, order,
        perStream, arMajority: arMajority.length, ewmaClean: ewmaClean.length,
        arMajorityFraction: arMajority.length / ids.length,
        unanimousAr: arMajority.length === ids.length,
        unanimousEwma: ewmaClean.length === ids.length,
    };
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

export function tournamentVolModelAcrossSplits(vols, { splits = [0.3, 0.4, 0.5, 0.6, 0.7], lambda = 0.94, order = 1, modelFn = null } = {}) {
    if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4b-g)' };
    if (typeof modelFn !== 'function') return { available: false, reason: 'modelFn must be a function (W4b-g)' };
    if (!Array.isArray(splits) || !splits.length) return { available: false, reason: 'splits must be a non-empty array (W4b-g)' };
    for (const s of splits) if (!Number.isFinite(s) || s <= 0 || s >= 1) return { available: false, reason: 'every split must be in (0,1) (W4b-g)' };
    for (const v of vols) if (!Number.isFinite(v)) return { available: false, reason: 'non-finite vol (W4b-g)' };
    let ewmaFull;
    try { ewmaFull = ewmaVolForecast(vols, { lambda }); } catch (e) { return { available: false, reason: String((e && e.message) || e) }; }
    const perSplit = [];
    for (const s of splits) {
        const n = vols.length;
        const trainN = Math.floor(n * s);
        if (!(trainN >= order + 2) || !(n - trainN >= 2)) return { available: false, reason: `split ${s} leaves too little train or test (W4b-g)` };
        const train = vols.slice(0, trainN);
        const test = vols.slice(trainN);
        const fit = fitArVolForecast(train, { order });
        if (!fit.available) return { available: false, reason: `split ${s}: ${fit.reason}` };
        let mean = 0;
        for (const v of train) mean += v;
        mean /= train.length;
        const actual = [];
        const ewma = [];
        const ar = [];
        const model = [];
        const flat = [];
        for (let j = 0; j < test.length; j++) {
            const g = trainN + j;
            const hist = vols.slice(g - order, g);
            if (hist.length < order) continue;
            const pa = predictArVolForecast(fit, hist);
            let pm;
            try { pm = modelFn(train, hist); } catch (e) { return { available: false, reason: `split ${s}: modelFn threw (${String((e && e.message) || e)})` }; }
            if (!Number.isFinite(pa) || !Number.isFinite(pm)) continue;
            actual.push(test[j]);
            ewma.push(ewmaFull[g]);
            ar.push(pa);
            model.push(pm);
            flat.push(mean);
        }
        if (actual.length < 2) return { available: false, reason: `split ${s}: insufficient OOS points (W4b-g)` };
        const t = tournamentVolModel(actual, { ewma, ar, model, baseline: flat });
        if (!t.available) return { available: false, reason: `split ${s}: ${t.reason}` };
        perSplit.push({ split: s, skillEwma: t.skillEwma, skillAr: t.skillAr, skillModel: t.skillModel, winner: t.winner });
    }
    const modelWins = perSplit.filter((p) => p.winner === 'model').length;
    return {
        available: true, n: vols.length, splits: splits.slice(), lambda, order,
        perSplit, modelWins, arWins: perSplit.filter((p) => p.winner === 'ar').length,
        modelWinFraction: modelWins / perSplit.length,
    };
}

export function decideVolPromotion(summary, { minModelMajority = 0.6 } = {}) {
    if (!summary || summary.available !== true || !Array.isArray(summary.perSplit) || !summary.perSplit.length) {
        return { decision: 'park', reasons: ['tournament unavailable'] };
    }
    if (!Number.isFinite(minModelMajority) || minModelMajority <= 0 || minModelMajority > 1) {
        return { decision: 'park', reasons: ['minModelMajority must be in (0,1]'] };
    }
    const need = Math.ceil(summary.perSplit.length * minModelMajority);
    if (summary.modelWins >= need) {
        return { decision: 'promote', reasons: [`model wins ${summary.modelWins}/${summary.perSplit.length} splits (needs ${need})`] };
    }
    return { decision: 'park', reasons: [`model wins ${summary.modelWins}/${summary.perSplit.length} splits (needs ${need})`] };
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

export function tournamentVolLadder(returns, { windows = [12, 24, 48], splits = [0.3, 0.4, 0.5, 0.6, 0.7], lambda = 0.94, order = 1 } = {}) {
    if (!Array.isArray(returns) || returns.length < 8) return { available: false, reason: 'returns must be an array of at least 8 bars (W4b-w)' };
    for (const r of returns) if (!Number.isFinite(r)) return { available: false, reason: 'non-finite return (W4b-w)' };
    if (!Array.isArray(windows) || !windows.length) return { available: false, reason: 'windows must be a non-empty array (W4b-w)' };
    for (const w of windows) if (!Number.isInteger(w) || w < 1) return { available: false, reason: 'every window must be a positive integer (W4b-w)' };
    const perWindow = {};
    for (const w of windows) {
        const vols = realizedVolatility(returns, w);
        const t = tournamentVolForecastAcrossSplits(vols, { splits, lambda, order });
        if (!t.available) return { available: false, reason: `window ${w}: ${t.reason}` };
        perWindow[w] = t;
    }
    const keys = Object.keys(perWindow);
    const arClean = keys.filter((w) => perWindow[w].arWinFraction > 0.5);
    return {
        available: true, n: returns.length, windows: windows.slice(), splits: splits.slice(), lambda, order,
        perWindow, arClean: arClean.length,
        arCleanFraction: arClean.length / keys.length,
        unanimousAr: arClean.length === keys.length,
    };
}