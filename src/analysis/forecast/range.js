// Range estimators + HAR (W4c, rounds 54-63) — split from
// `analysis/forecast.js` in round 71 (byte-exact move; the `forecast.js`
// re-export shim keeps every import path working). Parkinson/Garman-Klass/
// Rogers-Satchell range variance, Yang-Zhang, the HAR-RV fit, the HAR
// tournaments and the expanding-forecast grid. `w4cSolveNormal` is shared
// with `combine.js` (exported, registered — the import law forbids
// duplicating a numerical solver across modules).
import { ewmaVolForecast, fitArVolForecast, predictArVolForecast, volForecastSkill } from './vol.js';

const W4C_LN2 = Math.log(2);
const W4C_ESTIMATORS = ['cc', 'parkinson', 'garman-klass', 'rogers-satchell'];

function w4cReadBar(bar) {
  let o, h, l, c;
  if (Array.isArray(bar)) [o, h, l, c] = bar;
  else if (bar && typeof bar === 'object') {
    o = bar.o != null ? bar.o : bar.open;
    h = bar.h != null ? bar.h : bar.high;
    l = bar.l != null ? bar.l : bar.low;
    c = bar.c != null ? bar.c : bar.close;
  } else return null;
  o = Number(o); h = Number(h); l = Number(l); c = Number(c);
  if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) return null;
  if (!(o > 0) || !(h > 0) || !(l > 0) || !(c > 0)) return null;
  if (!(h >= l) || h < Math.max(o, c) || l > Math.min(o, c)) return null;
  return { o, h, l, c };
}

export function rangeBarVariance(bar, { estimator = 'parkinson' } = {}) {
  const b = w4cReadBar(bar);
  if (!b) return { available: false, reason: 'bar must be finite positive OHLC with high >= max(open, close) and low <= min(open, close) (W4c)' };
  if (!W4C_ESTIMATORS.includes(estimator)) return { available: false, reason: 'estimator must be cc, parkinson, garman-klass or rogers-satchell (W4c)' };
  const u = Math.log(b.h / b.o);
  const d = Math.log(b.l / b.o);
  const cl = Math.log(b.c / b.o);
  let variance;
  if (estimator === 'cc') variance = cl * cl;
  else if (estimator === 'parkinson') variance = ((u - d) * (u - d)) / (4 * W4C_LN2);
  else if (estimator === 'garman-klass') variance = 0.5 * (u - d) * (u - d) - (2 * W4C_LN2 - 1) * cl * cl;
  else variance = u * (u - cl) + d * (d - cl);
  if (!Number.isFinite(variance)) return { available: false, reason: 'non-finite variance (W4c)' };
  return { available: true, estimator, variance };
}

export function rangeRealizedVolatility(ohlc, window, { estimator = 'parkinson' } = {}) {
  if (!Array.isArray(ohlc) || !Number.isInteger(window) || window < 1) return [];
  if (ohlc.length < window) return [];
  const vars = [];
  for (const bar of ohlc) {
    const r = rangeBarVariance(bar, { estimator });
    if (!r.available) return [];
    vars.push(r.variance);
  }
  const out = [];
  let sum = 0;
  for (let i = 0; i < window; i++) sum += vars[i];
  out.push(Math.sqrt(Math.max(0, sum) / window));
  for (let t = window; t < vars.length; t++) {
    sum += vars[t] - vars[t - window];
    out.push(Math.sqrt(Math.max(0, sum) / window));
  }
  return out;
}

function w4cSampleVariance(xs) {
  const n = xs.length;
  if (n < 2) return NaN;
  let mean = 0;
  for (const x of xs) mean += x;
  mean /= n;
  let s = 0;
  for (const x of xs) s += (x - mean) * (x - mean);
  return s / (n - 1);
}

function w4cRsOf(b) {
  const u = Math.log(b.h / b.o);
  const d = Math.log(b.l / b.o);
  const cl = Math.log(b.c / b.o);
  return u * (u - cl) + d * (d - cl);
}

export function yangZhangVariance(ohlc) {
  if (!Array.isArray(ohlc) || ohlc.length < 3) return { available: false, reason: 'need at least 3 OHLC bars (W4c)' };
  const bars = [];
  for (const bar of ohlc) {
    const b = w4cReadBar(bar);
    if (!b) return { available: false, reason: 'non-finite or inconsistent OHLC bar (W4c)' };
    bars.push(b);
  }
  const n = bars.length;
  const overnight = [];
  for (let i = 1; i < n; i++) overnight.push(Math.log(bars[i].o / bars[i - 1].c));
  const openClose = bars.map((b) => Math.log(b.c / b.o));
  let rs = 0;
  for (const b of bars) rs += w4cRsOf(b);
  rs /= n;
  const vo = w4cSampleVariance(overnight);
  const vc = w4cSampleVariance(openClose);
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));
  const raw = vo + k * vc + (1 - k) * rs;
  if (!Number.isFinite(raw)) return { available: false, reason: 'non-finite Yang-Zhang components (W4c)' };
  return { available: true, n, k, overnight: vo, openClose: vc, rs, variance: Math.max(0, raw), rawVariance: raw };
}

export function yangZhangRealizedVolatility(ohlc, window) {
  if (!Array.isArray(ohlc) || !Number.isInteger(window) || window < 1) return [];
  if (ohlc.length < window || window < 3) return [];
  const bars = [];
  for (const bar of ohlc) {
    const b = w4cReadBar(bar);
    if (!b) return [];
    bars.push(b);
  }
  const n = bars.length;
  const oc = bars.map((b) => Math.log(b.c / b.o));
  const rs = bars.map(w4cRsOf);
  const k = 0.34 / (1.34 + (window + 1) / (window - 1));
  const out = [];
  for (let s = 0; s + window <= n; s++) {
    const on = [];
    for (let i = s; i < s + window; i++) on.push(i === 0 ? 0 : Math.log(bars[i].o / bars[i - 1].c));
    const vo = w4cSampleVariance(on);
    const vc = w4cSampleVariance(oc.slice(s, s + window));
    let vr = 0;
    for (let i = s; i < s + window; i++) vr += rs[i];
    vr /= window;
    const raw = vo + k * vc + (1 - k) * vr;
    if (!Number.isFinite(raw)) return [];
    out.push(Math.sqrt(Math.max(0, raw)));
  }
  return out;
}

export function w4cSolveNormal(xtx, xty) {
  const p = xty.length;
  const aug = xtx.map((row, i) => row.concat([xty[i]]));
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(aug[r][c]) > Math.abs(aug[piv][c])) piv = r;
    if (!(Math.abs(aug[piv][c]) > 1e-12)) return null;
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
  return aug.map((row) => row[p]);
}

function w4cHarFeatures(history, daily, weekly, monthly) {
  const tail = (w) => {
    let sum = 0;
    for (let i = history.length - w; i < history.length; i++) sum += history[i];
    return sum / w;
  };
  return [1, tail(daily), tail(weekly), tail(monthly)];
}

export function fitHarVolForecast(trainVols, { daily = 1, weekly = 5, monthly = 22 } = {}) {
  for (const [name, v] of [['daily', daily], ['weekly', weekly], ['monthly', monthly]]) {
    if (!Number.isInteger(v) || v < 1) return { available: false, reason: `${name} must be a positive integer (W4c)` };
  }
  if (!(daily <= weekly && weekly <= monthly)) return { available: false, reason: 'need daily <= weekly <= monthly (W4c)' };
  if (!Array.isArray(trainVols)) return { available: false, reason: 'trainVols must be an array (W4c)' };
  for (const v of trainVols) if (!Number.isFinite(v)) return { available: false, reason: 'non-finite vol (W4c)' };
  const p = 4;
  const rows = [];
  const ys = [];
  for (let t = monthly; t < trainVols.length; t++) {
    rows.push(w4cHarFeatures(trainVols.slice(0, t), daily, weekly, monthly));
    ys.push(trainVols[t]);
  }
  if (rows.length < p + 1) return { available: false, reason: 'insufficient rows to fit HAR (W4c)' };
  const xtx = Array.from({ length: p }, () => new Array(p).fill(0));
  const xty = new Array(p).fill(0);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    for (let a = 0; a < p; a++) {
      xty[a] += r[a] * ys[i];
      for (let b = 0; b < p; b++) xtx[a][b] += r[a] * r[b];
    }
  }
  const coef = w4cSolveNormal(xtx, xty);
  if (!coef) return { available: false, reason: 'singular HAR normal equations (W4c)' };
  return { available: true, daily, weekly, monthly, coef, rows: rows.length };
}

export function predictHarVolForecast(fit, history) {
  const coef = Array.isArray(fit) ? fit : (fit && fit.coef);
  const daily = Array.isArray(fit) ? 1 : Number((fit && fit.daily) || 1);
  const weekly = Array.isArray(fit) ? 5 : Number((fit && fit.weekly) || 5);
  const monthly = Array.isArray(fit) ? 22 : Number((fit && fit.monthly) || 22);
  if (!Array.isArray(coef) || coef.length !== 4) return NaN;
  if (!Array.isArray(history) || history.length < monthly) return NaN;
  for (const v of history.slice(history.length - monthly)) if (!Number.isFinite(v)) return NaN;
  const f = w4cHarFeatures(history, daily, weekly, monthly);
  return coef[0] * f[0] + coef[1] * f[1] + coef[2] * f[2] + coef[3] * f[3];
}

export function tournamentHarVolForecast(vols, { split = 0.5, lambda = 0.94, order = 1, har = {} } = {}) {
  if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4c)' };
  if (!Number.isFinite(split) || split <= 0 || split >= 1) return { available: false, reason: 'split must be in (0,1) (W4c)' };
  for (const v of vols) if (!Number.isFinite(v)) return { available: false, reason: 'non-finite vol (W4c)' };
  const hh = { daily: 1, weekly: 5, monthly: 22, ...(har || {}) };
  if (!Number.isInteger(order) || order < 1) return { available: false, reason: 'order must be a positive integer (W4c)' };
  const n = vols.length;
  const trainN = Math.floor(n * split);
  const need = Math.max(order + 2, hh.monthly + 1);
  if (!(trainN >= need) || !(n - trainN >= 2)) return { available: false, reason: 'split leaves too little train or test (W4c)' };
  const train = vols.slice(0, trainN);
  const test = vols.slice(trainN);
  const arFit = fitArVolForecast(train, { order });
  if (!arFit.available) return { available: false, reason: arFit.reason };
  const harFit = fitHarVolForecast(train, hh);
  if (!harFit.available) return { available: false, reason: harFit.reason };
  let ewmaFull;
  try { ewmaFull = ewmaVolForecast(vols, { lambda }); } catch (e) { return { available: false, reason: String((e && e.message) || e) }; }
  let mean = 0;
  for (const v of train) mean += v;
  mean /= train.length;
  const histNeed = Math.max(order, harFit.monthly);
  const actual = [];
  const ewma = [];
  const ar = [];
  const harF = [];
  const flat = [];
  for (let j = 0; j < test.length; j++) {
    const g = trainN + j;
    const hist = vols.slice(g - histNeed, g);
    if (hist.length < histNeed) continue;
    const pa = predictArVolForecast(arFit, hist.slice(hist.length - order));
    const ph = predictHarVolForecast(harFit, hist);
    if (!Number.isFinite(pa) || !Number.isFinite(ph)) continue;
    actual.push(test[j]);
    ewma.push(ewmaFull[g]);
    ar.push(pa);
    harF.push(ph);
    flat.push(mean);
  }
  if (actual.length < 2) return { available: false, reason: 'insufficient OOS points (W4c)' };
  const se = volForecastSkill(actual, ewma, flat);
  const sa = volForecastSkill(actual, ar, flat);
  const sh = volForecastSkill(actual, harF, flat);
  if (!se.available || !sa.available || !sh.available) return { available: false, reason: 'degenerate OOS baseline (W4c)' };
  const skills = { ewma: se.skill, ar: sa.skill, har: sh.skill };
  let winner = 'ewma';
  if (skills.ar > skills[winner]) winner = 'ar';
  if (skills.har > skills[winner]) winner = 'har';
  return {
    available: true, n, trainN, testN: actual.length, order, lambda,
    daily: harFit.daily, weekly: harFit.weekly, monthly: harFit.monthly,
    coef: arFit.coef.slice(), harCoef: harFit.coef.slice(),
    mseBaseline: se.mseBaseline, mseEwma: se.mseForecast, mseAr: sa.mseForecast, mseHar: sh.mseForecast,
    ewmaSkill: se.skill, arSkill: sa.skill, harSkill: sh.skill,
    winner, beatsAr: sh.skill > sa.skill,
  };
}

export function tournamentHarVolForecastAcrossSplits(vols, { splits = [0.3, 0.4, 0.5, 0.6, 0.7], lambda = 0.94, order = 1, har = {} } = {}) {
  if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4c)' };
  if (!Array.isArray(splits) || !splits.length) return { available: false, reason: 'splits must be a non-empty array (W4c)' };
  for (const s of splits) if (!Number.isFinite(s) || s <= 0 || s >= 1) return { available: false, reason: 'every split must be in (0,1) (W4c)' };
  const perSplit = [];
  for (const s of splits) {
    const t = tournamentHarVolForecast(vols, { split: s, lambda, order, har });
    if (!t.available) return { available: false, reason: `split ${s}: ${t.reason}` };
    perSplit.push({ split: s, ewmaSkill: t.ewmaSkill, arSkill: t.arSkill, harSkill: t.harSkill, winner: t.winner });
  }
  const harWins = perSplit.filter((p) => p.winner === 'har').length;
  const arWins = perSplit.filter((p) => p.winner === 'ar').length;
  return {
    available: true, n: vols.length, splits: splits.slice(), lambda, order,
    perSplit, harWins, arWins, ewmaWins: perSplit.length - harWins - arWins,
    harWinFraction: harWins / perSplit.length,
    arWinFraction: arWins / perSplit.length,
  };
}

export function expandingVolForecasts(vols, { minTrain = 100, step = 1, lambda = 0.94, order = 1, har = {} } = {}) {
  if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4c-x)' };
  for (const v of vols) if (!Number.isFinite(v)) return { available: false, reason: 'non-finite vol (W4c-x)' };
  if (!Number.isInteger(minTrain) || minTrain < 8) return { available: false, reason: 'minTrain must be an integer of at least 8 (W4c-x)' };
  if (!Number.isInteger(step) || step < 1) return { available: false, reason: 'step must be a positive integer (W4c-x)' };
  if (!Number.isInteger(order) || order < 1) return { available: false, reason: 'order must be a positive integer (W4c-x)' };
  const hh = { daily: 1, weekly: 5, monthly: 22, ...(har || {}) };
  const histNeed = Math.max(order, hh.monthly);
  if (!(minTrain > histNeed)) return { available: false, reason: 'minTrain must exceed the longest lag (W4c-x)' };
  if (!(vols.length > minTrain)) return { available: false, reason: 'no out-of-sample points beyond minTrain (W4c-x)' };
  let ewmaFull;
  try { ewmaFull = ewmaVolForecast(vols, { lambda }); } catch (e) { return { available: false, reason: String((e && e.message) || e) }; }
  const actual = [];
  const ewma = [];
  const ar = [];
  const harF = [];
  const flat = [];
  for (let g = minTrain; g < vols.length; g += step) {
    const train = vols.slice(0, g);
    const arFit = fitArVolForecast(train, { order });
    const harFit = fitHarVolForecast(train, hh);
    if (!arFit.available || !harFit.available) continue;
    const hist = vols.slice(g - histNeed, g);
    const pa = predictArVolForecast(arFit, hist.slice(hist.length - order));
    const ph = predictHarVolForecast(harFit, hist);
    if (!Number.isFinite(pa) || !Number.isFinite(ph)) continue;
    let mean = 0;
    for (const v of train) mean += v;
    mean /= train.length;
    actual.push(vols[g]);
    ewma.push(ewmaFull[g]);
    ar.push(pa);
    harF.push(ph);
    flat.push(mean);
  }
  if (actual.length < 2) return { available: false, reason: 'insufficient out-of-sample points (W4c-x)' };
  const se = volForecastSkill(actual, ewma, flat);
  const sa = volForecastSkill(actual, ar, flat);
  const sh = volForecastSkill(actual, harF, flat);
  if (!se.available || !sa.available || !sh.available) return { available: false, reason: 'degenerate out-of-sample baseline (W4c-x)' };
  const skills = { ewma: se.skill, ar: sa.skill, har: sh.skill };
  let winner = 'ewma';
  if (skills.ar > skills[winner]) winner = 'ar';
  if (skills.har > skills[winner]) winner = 'har';
  return {
    available: true, n: vols.length, minTrain, step, order, lambda,
    daily: hh.daily, weekly: hh.weekly, monthly: hh.monthly,
    points: actual.length, actual, ewma, ar, har: harF, baseline: flat,
    mseBaseline: se.mseBaseline, mseEwma: se.mseForecast, mseAr: sa.mseForecast, mseHar: sh.mseForecast,
    ewmaSkill: se.skill, arSkill: sa.skill, harSkill: sh.skill,
    winner, beatsAr: sh.skill > sa.skill,
  };
}

export function tournamentHarVolPanel(volsByStream, { splits = [0.3, 0.4, 0.5, 0.6, 0.7], lambda = 0.94, order = 1, har = {} } = {}) {  if (!volsByStream || typeof volsByStream !== 'object' || Array.isArray(volsByStream)) return { available: false, reason: 'volsByStream must be a {id: vols} object (W4c)' };
  const ids = Object.keys(volsByStream);
  if (!ids.length) return { available: false, reason: 'volsByStream must not be empty (W4c)' };
  const perStream = {};
  for (const id of ids) {
    const t = tournamentHarVolForecastAcrossSplits(volsByStream[id], { splits, lambda, order, har });
    if (!t.available) return { available: false, reason: `${id}: ${t.reason}` };
    perStream[id] = t;
  }
  const harMajority = ids.filter((id) => perStream[id].harWinFraction > 0.5);
  const arMajority = ids.filter((id) => perStream[id].arWinFraction > 0.5);
  return {
    available: true, streams: ids.length, splits: splits.slice(), lambda, order,
    perStream, harMajority: harMajority.length, arMajority: arMajority.length,
    harMajorityFraction: harMajority.length / ids.length,
    arMajorityFraction: arMajority.length / ids.length,
    unanimousHar: harMajority.length === ids.length,
    unanimousAr: arMajority.length === ids.length,
  };
}