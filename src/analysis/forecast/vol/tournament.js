// src/analysis/forecast/vol/tournament.js (round-109 split of src/analysis/forecast/vol.js).
// Tournaments: split/panel/ladder AR-vs-EWMA contests, the model slot, the promotion decision.
// Moved byte-exact; re-exported by the vol.js shim.
import { realizedVolatility, ewmaVolForecast, volForecastSkill, fitArVolForecast, predictArVolForecast } from './estimators.js';
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
