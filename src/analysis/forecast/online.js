// Online (rolling) combination (W4c-w, round 67) — split from
// `analysis/forecast.js` in round 71 (byte-exact move; the `forecast.js`
// re-export shim keeps every import path working). Gibbs-exponential-loss
// weights, per-bar causal re-fits, the frozen-vs-rolling tournament and its
// split/panel rollups.
import { ewmaVolForecast, fitArVolForecast, predictArVolForecast, volForecastSkill } from './vol.js';
import { fitHarVolForecast, predictHarVolForecast } from './range.js';
import { fitCombineWeights, inverseMseWeights, fitLassoCombineWeights, predictCombine } from './combine.js';

// ---- W4c-w: online (rolling) combination (round 67) --------------------------
// Frozen weights assume the best blend is stationary. Online combination
// re-fits the blend on a trailing window of realised (actual, forecast)
// tuples - the rolling analogue of Bates & Granger (1969); the Gibbs
// (exponential-loss) arm is the plain member of the Generalized Gibbs
// Ensemble Weighting family (arXiv 2608.28116); the frozen-vs-rolling frame
// is the "frozen + online" simplex of the downside-controlled online
// combination literature (arXiv 2609.29096). Every weight at bar i reads only
// tuples strictly before i.
export function gibbsCombineWeights(trainActual, trainCols, { eta = 2 } = {}) {
  if (!Array.isArray(trainActual)) return { available: false, reason: 'trainActual must be an array (W4c-w)' };
  if (!Array.isArray(trainCols) || !trainCols.length) return { available: false, reason: 'need at least one forecast column (W4c-w)' };
  for (const c of trainCols) {
    if (!Array.isArray(c) || c.length !== trainActual.length) return { available: false, reason: 'forecast columns must align with actual (W4c-w)' };
  }
  if (!Number.isFinite(eta) || eta < 0) return { available: false, reason: 'eta must be a finite non-negative temperature (W4c-w)' };
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
    if (!n) return { available: false, reason: 'no finite pairs for a column (W4c-w)' };
    const mse = sum / n;
    if (!(mse > 0)) return { available: false, reason: 'a column is exact on train, no Gibbs weight (W4c-w)' };
    mses.push(mse);
  }
  const minMse = Math.min(...mses);
  const raw = mses.map((m) => Math.exp(-eta * (m / minMse - 1)));
  let total = 0;
  for (const r of raw) total += r;
  return { available: true, mses, eta, weights: raw.map((r) => r / total) };
}

const W4CW_METHODS = ['ols', 'eq', 'inv', 'gibbs', 'lasso'];

export function rollingCombineWeights(actual, cols, { window = 60, method = 'ols', lasso = {}, eta = 2 } = {}) {
  if (!Array.isArray(actual)) return { available: false, reason: 'actual must be an array (W4c-w)' };
  if (!Array.isArray(cols) || !cols.length) return { available: false, reason: 'need at least one forecast column (W4c-w)' };
  for (const c of cols) {
    if (!Array.isArray(c) || c.length !== actual.length) return { available: false, reason: 'forecast columns must align with actual (W4c-w)' };
  }
  if (!W4CW_METHODS.includes(method)) return { available: false, reason: `method must be one of ${W4CW_METHODS.join(',')} (W4c-w)` };
  const K = cols.length;
  const minBars = K + 1;
  if (!Number.isInteger(window) || window < minBars) return { available: false, reason: `window must be an integer of at least ${minBars} (W4c-w)` };
  if (actual.length <= minBars) return { available: false, reason: 'no bars beyond the fitting minimum (W4c-w)' };
  const fitAt = (lo, hi) => {
    const a = actual.slice(lo, hi);
    const cc = cols.map((c) => c.slice(lo, hi));
    if (method === 'eq') return { available: true, weights: new Array(K).fill(1 / K) };
    if (method === 'inv') return inverseMseWeights(a, cc);
    if (method === 'gibbs') return gibbsCombineWeights(a, cc, { eta });
    if (method === 'lasso') return fitLassoCombineWeights(a, cc, lasso);
    return fitCombineWeights(a, cc);
  };
  const weights = [];
  const combined = [];
  for (let i = 0; i < actual.length; i++) {
    if (i < minBars) { weights.push(null); combined.push(NaN); continue; }
    const lo = Math.max(0, i - window);
    const f = fitAt(lo, i);
    if (!f.available) { weights.push(null); combined.push(NaN); continue; }
    const fc = cols.map((c) => c[i]);
    weights.push(f.weights.slice());
    combined.push(predictCombine(fc, f.weights));
  }
  const scored = combined.filter((v) => Number.isFinite(v)).length;
  if (!scored) return { available: false, reason: 'no scorable bars (W4c-w)' };
  return { available: true, n: actual.length, window, method, minBars, weights, combined, scored };
}

const W4CR_ORDER = ['ewma', 'ar', 'har', 'eq', 'frozen', 'rols', 'rinv', 'rgibbs'];

export function tournamentRollingCombineVolForecast(vols, { split = 0.5, window = 60, lambda = 0.94, order = 1, har = {}, lasso = {}, eta = 2 } = {}) {
  if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4c-w)' };
  if (!Number.isFinite(split) || split <= 0 || split >= 1) return { available: false, reason: 'split must be in (0,1) (W4c-w)' };
  for (const v of vols) if (!Number.isFinite(v)) return { available: false, reason: 'non-finite vol (W4c-w)' };
  if (!Number.isInteger(order) || order < 1) return { available: false, reason: 'order must be a positive integer (W4c-w)' };
  const hh = { daily: 1, weekly: 5, monthly: 22, ...(har || {}) };
  const n = vols.length;
  const trainN = Math.floor(n * split);
  const need = Math.max(order + 2, hh.monthly + 1);
  if (!(trainN >= need) || !(n - trainN >= 2)) return { available: false, reason: 'split leaves too little train or test (W4c-w)' };
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
  if (actual.length < 8) return { available: false, reason: 'insufficient OOS points for a weight split (W4c-w)' };
  const cut = Math.floor(actual.length / 2);
  const frozen = fitCombineWeights(actual.slice(0, cut), [ewma.slice(0, cut), ar.slice(0, cut), harF.slice(0, cut)]);
  if (!frozen.available) return { available: false, reason: `frozen weights: ${frozen.reason}` };
  const roll = {};
  for (const m of ['ols', 'inv', 'gibbs']) {
    const r = rollingCombineWeights(actual, [ewma, ar, harF], { window, method: m, lasso, eta });
    if (!r.available) return { available: false, reason: `rolling ${m}: ${r.reason}` };
    roll[m] = r;
  }
  const K = 3;
  const minBars = K + 1;
  const scoreIdx = [];
  for (let i = Math.max(cut, minBars); i < actual.length; i++) {
    if (Number.isFinite(roll.ols.combined[i]) && Number.isFinite(roll.inv.combined[i]) && Number.isFinite(roll.gibbs.combined[i])) scoreIdx.push(i);
  }
  if (scoreIdx.length < 2) return { available: false, reason: 'insufficient jointly-scored bars (W4c-w)' };
  const at = (arr) => scoreIdx.map((i) => arr[i]);
  const flat = scoreIdx.map(() => mean);
  const series = {
    ewma: at(ewma), ar: at(ar), har: at(harF),
    eq: scoreIdx.map((i) => (ewma[i] + ar[i] + harF[i]) / 3),
    frozen: scoreIdx.map((i) => predictCombine([ewma[i], ar[i], harF[i]], frozen.weights)),
    rols: at(roll.ols.combined), rinv: at(roll.inv.combined), rgibbs: at(roll.gibbs.combined),
  };
  const skills = {};
  const mses = {};
  for (const k of W4CR_ORDER) {
    const s = volForecastSkill(at(actual), series[k], flat);
    if (!s.available) return { available: false, reason: `degenerate scoring span for ${k} (W4c-w)` };
    skills[k] = s.skill;
    mses[k] = s.mseForecast;
  }
  let winner = W4CR_ORDER[0];
  for (const k of W4CR_ORDER) if (skills[k] > skills[winner]) winner = k;
  const bestRollingSkill = Math.max(skills.rols, skills.rinv, skills.rgibbs);
  return {
    available: true, n, trainN, testN: actual.length, scoredN: scoreIdx.length,
    order, lambda, window,
    daily: harFit.daily, weekly: harFit.weekly, monthly: harFit.monthly,
    skills, mses, mseBaseline: volForecastSkill(at(actual), series[winner], flat).mseBaseline,
    frozenWeights: frozen.weights.slice(),
    winner,
    beatsFrozen: { rols: skills.rols > skills.frozen, rinv: skills.rinv > skills.frozen, rgibbs: skills.rgibbs > skills.frozen },
    bestRollingSkill,
    anyRollingBeatsFrozen: bestRollingSkill > skills.frozen,
  };
}

export function tournamentRollingCombineVolForecastAcrossSplits(vols, { splits = [0.3, 0.4, 0.5, 0.6, 0.7], window = 60, lambda = 0.94, order = 1, har = {}, lasso = {}, eta = 2 } = {}) {
  if (!Array.isArray(vols) || vols.length < 8) return { available: false, reason: 'need at least 8 finite vols (W4c-w)' };
  if (!Array.isArray(splits) || !splits.length) return { available: false, reason: 'splits must be a non-empty array (W4c-w)' };
  for (const s of splits) if (!Number.isFinite(s) || s <= 0 || s >= 1) return { available: false, reason: 'every split must be in (0,1) (W4c-w)' };
  const perSplit = [];
  for (const s of splits) {
    const t = tournamentRollingCombineVolForecast(vols, { split: s, window, lambda, order, har, lasso, eta });
    if (!t.available) return { available: false, reason: `split ${s}: ${t.reason}` };
    perSplit.push({ split: s, winner: t.winner, skills: { ...t.skills }, beatsFrozen: { ...t.beatsFrozen }, anyRollingBeatsFrozen: t.anyRollingBeatsFrozen });
  }
  const wins = {};
  for (const k of W4CR_ORDER) wins[k] = perSplit.filter((p) => p.winner === k).length;
  const rollingWins = wins.rols + wins.rinv + wins.rgibbs;
  return {
    available: true, n: vols.length, splits: splits.slice(), lambda, order, window,
    perSplit, wins, rollingWins, frozenWins: wins.frozen,
    rollingWinFraction: rollingWins / perSplit.length,
    frozenWinFraction: wins.frozen / perSplit.length,
  };
}

export function tournamentRollingCombineVolPanel(volsByStream, { splits = [0.3, 0.4, 0.5, 0.6, 0.7], window = 60, lambda = 0.94, order = 1, har = {}, lasso = {}, eta = 2 } = {}) {
  if (!volsByStream || typeof volsByStream !== 'object' || Array.isArray(volsByStream)) return { available: false, reason: 'volsByStream must be a {id: vols} object (W4c-w)' };
  const ids = Object.keys(volsByStream);
  if (!ids.length) return { available: false, reason: 'volsByStream must not be empty (W4c-w)' };
  const perStream = {};
  for (const id of ids) {
    const t = tournamentRollingCombineVolForecastAcrossSplits(volsByStream[id], { splits, window, lambda, order, har, lasso, eta });
    if (!t.available) return { available: false, reason: `${id}: ${t.reason}` };
    perStream[id] = t;
  }
  const rollingMaj = ids.filter((id) => perStream[id].rollingWins / perStream[id].perSplit.length > 0.5);
  const frozenMaj = ids.filter((id) => perStream[id].frozenWins / perStream[id].perSplit.length > 0.5);
  return {
    available: true, streams: ids.length, splits: splits.slice(), lambda, order, window,
    perStream,
    rollingMajority: rollingMaj.length, rollingMajorityFraction: rollingMaj.length / ids.length,
    unanimousRolling: rollingMaj.length === ids.length,
    frozenMajority: frozenMaj.length, frozenMajorityFraction: frozenMaj.length / ids.length,
  };
}