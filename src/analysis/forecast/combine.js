// Forecast combination, frozen weights (W4c-y, round 64) — split from
// `analysis/forecast.js` in round 71 (byte-exact move; the `forecast.js`
// re-export shim keeps every import path working). OLS / inverse-MSE / lasso
// combinations with the weight-train/weight-test split, the seven-way
// tournament (MSE + QLIKE blocks) and its split/panel rollups.
import { ewmaVolForecast, fitArVolForecast, predictArVolForecast, volForecastSkill, volForecastQlike } from './vol.js';
import { fitHarVolForecast, predictHarVolForecast, w4cSolveNormal } from './range.js';

// ---- W4c-y: forecast combination (round 64) ---------------------------------
// Bates & Granger (1969): a combination of rival forecasts usually beats every
// rival on its own. Timmermann (2006): estimated "optimal" weights add
// estimation error, so the simple equal-weight average is the reference to
// beat (the forecast combination puzzle). Audrino & Knaus (2016, arXiv
// 1610.02653): lasso-regularised combinations win on realized-variance panels.
// Every weight below is fit on a weight-train span and scored on a LATER
// weight-test span — never the same bars.
function w4cCollectCombinePairs(actual, cols) {
  const rows = [];
  const ys = [];
  const m = actual.length;
  for (let i = 0; i < m; i++) {
    const y = actual[i];
    if (!Number.isFinite(y)) continue;
    const row = [];
    let ok = true;
    for (const c of cols) {
      const v = c[i];
      if (!Number.isFinite(v)) { ok = false; break; }
      row.push(v);
    }
    if (!ok) continue;
    rows.push(row);
    ys.push(y);
  }
  return { rows, ys };
}

export function fitCombineWeights(trainActual, trainCols, { intercept = false } = {}) {
  if (!Array.isArray(trainActual)) return { available: false, reason: 'trainActual must be an array (W4c-y)' };
  if (!Array.isArray(trainCols) || !trainCols.length) return { available: false, reason: 'need at least one forecast column (W4c-y)' };
  for (const c of trainCols) {
    if (!Array.isArray(c) || c.length !== trainActual.length) return { available: false, reason: 'forecast columns must align with actual (W4c-y)' };
  }
  const K = trainCols.length;
  const p = K + (intercept ? 1 : 0);
  const { rows, ys } = w4cCollectCombinePairs(trainActual, trainCols);
  if (rows.length < p + 1) return { available: false, reason: 'insufficient finite rows to fit combination (W4c-y)' };
  const full = rows.map((r) => (intercept ? [1, ...r] : r.slice()));
  const xtx = Array.from({ length: p }, () => new Array(p).fill(0));
  const xty = new Array(p).fill(0);
  for (let i = 0; i < full.length; i++) {
    const r = full[i];
    for (let a = 0; a < p; a++) {
      xty[a] += r[a] * ys[i];
      for (let b = 0; b < p; b++) xtx[a][b] += r[a] * r[b];
    }
  }
  const coef = w4cSolveNormal(xtx, xty);
  if (!coef) return { available: false, reason: 'singular combination normal equations (W4c-y)' };
  return {
    available: true, rows: rows.length, hasIntercept: !!intercept,
    intercept: intercept ? coef[0] : 0, weights: intercept ? coef.slice(1) : coef.slice(),
  };
}

export function inverseMseWeights(trainActual, trainCols) {
  if (!Array.isArray(trainActual)) return { available: false, reason: 'trainActual must be an array (W4c-y)' };
  if (!Array.isArray(trainCols) || !trainCols.length) return { available: false, reason: 'need at least one forecast column (W4c-y)' };
  for (const c of trainCols) {
    if (!Array.isArray(c) || c.length !== trainActual.length) return { available: false, reason: 'forecast columns must align with actual (W4c-y)' };
  }
  const mses = [];
  for (const c of trainCols) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < trainActual.length; i++) {
      const y = trainActual[i];
      const f = c[i];
      if (!Number.isFinite(y) || !Number.isFinite(f)) continue;
      const d = y - f;
      sum += d * d;
      n++;
    }
    if (!n) return { available: false, reason: 'no finite pairs for a column (W4c-y)' };
    const mse = sum / n;
    if (!(mse > 0)) return { available: false, reason: 'a column is exact on train, no inverse weight (W4c-y)' };
    mses.push(mse);
  }
  let total = 0;
  for (const m of mses) total += 1 / m;
  return { available: true, mses, weights: mses.map((m) => (1 / m) / total) };
}

export function fitLassoCombineWeights(trainActual, trainCols, { l1 = 0.01, iters = 200 } = {}) {
  // Scale-free penalty: columns and target are RMS-normalised before the
  // coordinate descent and the weights mapped back, so one l1 means the same
  // shrinkage on vols of any magnitude (round 66 — a raw l1 is dominated by
  // the series scale and zeroes out small-magnitude panels).
  if (!Array.isArray(trainActual)) return { available: false, reason: 'trainActual must be an array (W4c-y)' };
  if (!Array.isArray(trainCols) || !trainCols.length) return { available: false, reason: 'need at least one forecast column (W4c-y)' };
  for (const c of trainCols) {
    if (!Array.isArray(c) || c.length !== trainActual.length) return { available: false, reason: 'forecast columns must align with actual (W4c-y)' };
  }
  if (!Number.isFinite(l1) || l1 < 0) return { available: false, reason: 'l1 must be a finite non-negative penalty (W4c-y)' };
  if (!Number.isInteger(iters) || iters < 1) return { available: false, reason: 'iters must be a positive integer (W4c-y)' };
  const { rows, ys } = w4cCollectCombinePairs(trainActual, trainCols);
  if (rows.length < 2) return { available: false, reason: 'insufficient finite rows to fit lasso combination (W4c-y)' };
  const n = rows.length;
  const K = trainCols.length;
  const z = new Array(K).fill(0);
  for (let j = 0; j < K; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += rows[i][j] * rows[i][j];
    z[j] = s / n;
  }
  const sc = z.map((v) => (v > 0 ? Math.sqrt(v) : 0));
  let sy = 0;
  for (const y of ys) sy += y * y;
  sy = Math.sqrt(sy / n);
  if (!(sy > 0)) return { available: true, rows: n, l1, iters, weights: new Array(K).fill(0) };
  const yn = ys.map((y) => y / sy);
  const xs = rows.map((r) => r.map((v, j) => (sc[j] > 0 ? v / sc[j] : 0)));
  const w = new Array(K).fill(0);
  const resid = yn.slice();
  for (let it = 0; it < iters; it++) {
    for (let j = 0; j < K; j++) {
      if (!(sc[j] > 0)) { w[j] = 0; continue; }
      let rho = 0;
      for (let i = 0; i < n; i++) rho += xs[i][j] * (resid[i] + w[j] * xs[i][j]);
      rho /= n;
      const nw = Math.sign(rho) * Math.max(0, Math.abs(rho) - l1);
      const dw = nw - w[j];
      if (dw !== 0) {
        w[j] = nw;
        for (let i = 0; i < n; i++) resid[i] -= dw * xs[i][j];
      }
    }
  }
  const weights = w.map((v, j) => (sc[j] > 0 ? (v * sy) / sc[j] : 0));
  return { available: true, rows: n, l1, iters, weights };
}

export function predictCombine(forecasts, weights) {
  if (!Array.isArray(forecasts) || !Array.isArray(weights)) return NaN;
  if (!forecasts.length || forecasts.length !== weights.length) return NaN;
  let s = 0;
  for (let k = 0; k < forecasts.length; k++) {
    const f = forecasts[k];
    const w = weights[k];
    if (!Number.isFinite(f) || !Number.isFinite(w)) return NaN;
    s += f * w;
  }
  return s;
}

const W4CY_ORDER = ['ewma', 'ar', 'har', 'eq', 'inv', 'ols', 'lasso'];

export function tournamentCombineVolForecast(vols, { split = 0.5, lambda = 0.94, order = 1, har = {}, lasso = {} } = {}) {
  if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4c-y)' };
  if (!Number.isFinite(split) || split <= 0 || split >= 1) return { available: false, reason: 'split must be in (0,1) (W4c-y)' };
  for (const v of vols) if (!Number.isFinite(v)) return { available: false, reason: 'non-finite vol (W4c-y)' };
  if (!Number.isInteger(order) || order < 1) return { available: false, reason: 'order must be a positive integer (W4c-y)' };
  const hh = { daily: 1, weekly: 5, monthly: 22, ...(har || {}) };
  const n = vols.length;
  const trainN = Math.floor(n * split);
  const need = Math.max(order + 2, hh.monthly + 1);
  if (!(trainN >= need) || !(n - trainN >= 2)) return { available: false, reason: 'split leaves too little train or test (W4c-y)' };
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
  }
  if (actual.length < 8) return { available: false, reason: 'insufficient OOS points for a weight split (W4c-y)' };
  const cut = Math.floor(actual.length / 2);
  const wTrain = (arr) => arr.slice(0, cut);
  const wTest = (arr) => arr.slice(cut);
  const wTrainCols = [wTrain(ewma), wTrain(ar), wTrain(harF)];
  const inv = inverseMseWeights(wTrain(actual), wTrainCols);
  if (!inv.available) return { available: false, reason: `inverse-MSE weights: ${inv.reason}` };
  const ols = fitCombineWeights(wTrain(actual), wTrainCols);
  if (!ols.available) return { available: false, reason: `OLS weights: ${ols.reason}` };
  const las = fitLassoCombineWeights(wTrain(actual), wTrainCols, lasso);
  if (!las.available) return { available: false, reason: `lasso weights: ${las.reason}` };
  const eqW = [1 / 3, 1 / 3, 1 / 3];
  const testCols = [wTest(ewma), wTest(ar), wTest(harF)];
  const flat = wTest(actual).map(() => mean);
  const series = {
    ewma: wTest(ewma), ar: wTest(ar), har: wTest(harF),
    eq: [], inv: [], ols: [], lasso: [],
  };
  for (let i = 0; i < wTest(actual).length; i++) {
    const f = [testCols[0][i], testCols[1][i], testCols[2][i]];
    series.eq.push((f[0] + f[1] + f[2]) / 3);
    series.inv.push(predictCombine(f, inv.weights));
    series.ols.push(predictCombine(f, ols.weights));
    series.lasso.push(predictCombine(f, las.weights));
  }
  const skills = {};
  const mses = {};
  for (const k of W4CY_ORDER) {
    const s = volForecastSkill(wTest(actual), series[k], flat);
    if (!s.available) return { available: false, reason: `degenerate weight-test baseline for ${k} (W4c-y)` };
    skills[k] = s.skill;
    mses[k] = s.mseForecast;
  }
  let winner = W4CY_ORDER[0];
  for (const k of W4CY_ORDER) if (skills[k] > skills[winner]) winner = k;
  const bestCombineSkill = Math.max(skills.eq, skills.inv, skills.ols, skills.lasso);
  const bestCombine = W4CY_ORDER.filter((k) => k === 'eq' || k === 'inv' || k === 'ols' || k === 'lasso')
    .find((k) => skills[k] === bestCombineSkill);
  const wta = wTest(actual);
  const qi = [];
  for (let i = 0; i < wta.length; i++) {
    if (!(wta[i] > 0)) continue;
    let ok = true;
    for (const k of W4CY_ORDER) if (!(series[k][i] > 0)) { ok = false; break; }
    if (ok) qi.push(i);
  }
  let qlike = null;
  if (qi.length >= 2) {
    const qSkills = {};
    let qOk = true;
    for (const k of W4CY_ORDER) {
      const s = volForecastQlike(qi.map((i) => wta[i]), qi.map((i) => series[k][i]), qi.map(() => mean));
      if (!s.available) { qOk = false; break; }
      qSkills[k] = s.skill;
    }
    if (qOk) {
      let qw = W4CY_ORDER[0];
      for (const k of W4CY_ORDER) if (qSkills[k] > qSkills[qw]) qw = k;
      const qBest = Math.max(qSkills.eq, qSkills.inv, qSkills.ols, qSkills.lasso);
      qlike = { available: true, n: qi.length, skills: qSkills, winner: qw, bestCombineSkill: qBest, beatsHar: qBest > qSkills.har };
    }
  }
  return {
    available: true, n, trainN, testN: actual.length,
    weightTrainN: cut, weightTestN: actual.length - cut,
    order, lambda, daily: harFit.daily, weekly: harFit.weekly, monthly: harFit.monthly,
    skills, mses, mseBaseline: volForecastSkill(wTest(actual), series[winner], flat).mseBaseline,
    weights: { eq: eqW, inv: inv.weights.slice(), ols: ols.weights.slice(), lasso: las.weights.slice() },
    olsIntercept: ols.intercept, lassoL1: las.l1,
    winner, bestCombine, bestCombineSkill,
    beatsHar: bestCombineSkill > skills.har,
    qlike: qlike || { available: false, reason: 'insufficient all-positive weight-test bars (W4c-yq)' },
  };
}

export function tournamentCombineVolForecastAcrossSplits(vols, { splits = [0.3, 0.4, 0.5, 0.6, 0.7], lambda = 0.94, order = 1, har = {}, lasso = {} } = {}) {
  if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4c-y)' };
  if (!Array.isArray(splits) || !splits.length) return { available: false, reason: 'splits must be a non-empty array (W4c-y)' };
  for (const s of splits) if (!Number.isFinite(s) || s <= 0 || s >= 1) return { available: false, reason: 'every split must be in (0,1) (W4c-y)' };
  const perSplit = [];
  for (const s of splits) {
    const t = tournamentCombineVolForecast(vols, { split: s, lambda, order, har, lasso });
    if (!t.available) return { available: false, reason: `split ${s}: ${t.reason}` };
    perSplit.push({ split: s, winner: t.winner, skills: { ...t.skills }, beatsHar: t.beatsHar, qlikeWinner: t.qlike.available ? t.qlike.winner : null, qlikeSkills: t.qlike.available ? { ...t.qlike.skills } : null });
  }
  const wins = {};
  for (const k of W4CY_ORDER) wins[k] = perSplit.filter((p) => p.winner === k).length;
  const combineWins = wins.eq + wins.inv + wins.ols + wins.lasso;
  const qDecided = perSplit.filter((p) => p.qlikeWinner !== null);
  const qWins = {};
  for (const k of W4CY_ORDER) qWins[k] = qDecided.filter((p) => p.qlikeWinner === k).length;
  const qCombineWins = qWins.eq + qWins.inv + qWins.ols + qWins.lasso;
  return {
    available: true, n: vols.length, splits: splits.slice(), lambda, order,
    perSplit, wins, combineWins,
    combineWinFraction: combineWins / perSplit.length,
    harWins: wins.har,
    harWinFraction: wins.har / perSplit.length,
    qlikeDecided: qDecided.length, qlikeAbstained: perSplit.length - qDecided.length,
    qlikeWins: qWins, qlikeCombineWins: qCombineWins,
    qlikeCombineWinFraction: qCombineWins / perSplit.length,
    qlikeHarWins: qWins.har,
  };
}

export function tournamentCombineVolPanel(volsByStream, { splits = [0.3, 0.4, 0.5, 0.6, 0.7], lambda = 0.94, order = 1, har = {}, lasso = {} } = {}) {
  if (!volsByStream || typeof volsByStream !== 'object' || Array.isArray(volsByStream)) return { available: false, reason: 'volsByStream must be a {id: vols} object (W4c-y)' };
  const ids = Object.keys(volsByStream);
  if (!ids.length) return { available: false, reason: 'volsByStream must not be empty (W4c-y)' };
  const perStream = {};
  for (const id of ids) {
    const t = tournamentCombineVolForecastAcrossSplits(volsByStream[id], { splits, lambda, order, har, lasso });
    if (!t.available) return { available: false, reason: `${id}: ${t.reason}` };
    perStream[id] = t;
  }
  const majority = (k) => ids.filter((id) => perStream[id].wins[k] / perStream[id].perSplit.length > 0.5);
  const harMaj = majority('har');
  const combineMaj = ids.filter((id) => {
    const w = perStream[id].wins;
    return (w.eq + w.inv + w.ols + w.lasso) / perStream[id].perSplit.length > 0.5;
  });
  const qMaj = (get) => ids.filter((id) => {
    const t = perStream[id];
    if (!t.qlikeDecided) return false;
    return get(t) / t.perSplit.length > 0.5;
  });
  const qCombineMaj = qMaj((t) => t.qlikeCombineWins);
  const qHarMaj = qMaj((t) => t.qlikeHarWins);
  return {
    available: true, streams: ids.length, splits: splits.slice(), lambda, order,
    perStream,
    harMajority: harMaj.length, harMajorityFraction: harMaj.length / ids.length,
    unanimousHar: harMaj.length === ids.length,
    combineMajority: combineMaj.length, combineMajorityFraction: combineMaj.length / ids.length,
    unanimousCombine: combineMaj.length === ids.length,
    qlikeCombineMajority: qCombineMaj.length,
    qlikeCombineMajorityFraction: qCombineMaj.length / ids.length,
    unanimousQlikeCombine: qCombineMaj.length === ids.length,
    qlikeHarMajority: qHarMaj.length,
    qlikeHarMajorityFraction: qHarMaj.length / ids.length,
  };
}