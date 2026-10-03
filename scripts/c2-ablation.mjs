// c2-ablation.mjs — C2 optimizer retire-test on the REAL repo trainer (native-only).
//
// Arms (fresh forceMin HiveMind, es=4, is=16, frozen expanding folds on
// src/data/marks_8h.json 8h returns; target = next-bar direction):
//   stock  : shipped stack (spectral-clip x 1/255-quant x dual-EMA x fractal + rank-adaptive LR)
//   plain  : stack OFF (global-norm clip only) + fixed LR
//   adamw  : stack OFF + script-side AdamW (moments in-script, decoupled decay,
//            cosine schedule) + global-norm clip
// Monkey-patches instances only — zero edits to locked modules, no golden
// moves, no repo writes (state DBs go to a tmp dir; dumpState never called).
//
// Usage: node scripts/c2-ablation.mjs [--train 1200 --test 400 --blocks 2 --out /tmp/c2.json]
// Paste back: the full stdout summary. Exit non-zero on any arm error.
//
// RULE (pre-registered, CYCLE-197/198): plain~=stock (DM ns) → DELETE the
// stack. adamw>stock (DM p<0.05) → ADOPT AdamW. Neither → keep stock, close C2.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import HiveMind from '../src/hivemind/hiveMind.js';
import { dieboldMariano } from '../src/analysis/forecast/scoring.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) =>
    a.startsWith('--') ? [[a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : '1']] : []
  )
);
const N_TRAIN = parseInt(args.train || '1200', 10);
const N_TEST = parseInt(args.test || '400', 10);
const N_BLOCKS = parseInt(args.blocks || '2', 10);
const OUT = args.out || path.join(os.tmpdir(), 'c2-ablation.json');
const P = 16, ES = 4;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const mulberry32 = (seed) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const realRandom = Math.random;
const seedRandom = (seed) => { Math.random = mulberry32(seed); };

function globalClip(hm, idx, thresh) {
  const acc = hm._gradientAccumulation[idx];
  let sum = 0;
  const visit = (n) => {
    if (typeof n === 'number') { if (isNum(n)) sum += n * n; return; }
    if (n != null && typeof n === 'object') for (const k of Object.keys(n)) visit(n[k]);
  };
  visit(acc);
  const norm = Math.sqrt(sum);
  if (!(norm > thresh)) return;
  const s = thresh / norm;
  const scale = (n) => {
    if (typeof n === 'number') return isNum(n) ? n * s : n;
    if (n != null && typeof n === 'object') {
      if (Array.isArray(n)) { for (let i = 0; i < n.length; i++) n[i] = scale(n[i]); return n; }
      for (const k of Object.keys(n)) n[k] = scale(n[k]);
    }
    return n;
  };
  scale(acc);
}

function adamState() { return { m: new Map(), v: new Map(), t: 0 }; }

function adamApply(hm, idx, st, grad, lr, wd, beta1 = 0.9, beta2 = 0.999, eps = 1e-8) {
  const tr = hm._transformers[idx];
  const pairs = [
    [grad.attentionBias, hm._attentionBias[idx]],
    [grad.attentionWeightMatrix, hm._attentionWeightMatrix[idx]],
    [grad.specializationWeights, hm._specializationWeights[idx]],
    [grad.outputWeights, tr.outputWeights],
    [grad.outputBias, tr.outputBias],
  ];
  for (let L = 0; L < hm._numLayers; L++) {
    for (const k of ['Wq', 'Wk', 'Wv', 'Wo']) pairs.push([grad.attentionWeights[L][k], tr.attentionWeights[L][k]]);
    for (const k of ['gate_proj', 'up_proj', 'down_proj']) pairs.push([grad.ffnWeights[L][k], tr.ffnWeights[L][k]]);
    pairs.push([grad.layerNormWeights[L].gamma1, tr.layerNormWeights[L].gamma1]);
    pairs.push([grad.layerNormWeights[L].gamma2, tr.layerNormWeights[L].gamma2]);
  }
  const bc1 = 1 - Math.pow(beta1, st.t), bc2 = 1 - Math.pow(beta2, st.t);
  const upd = hm._setGradientStructure()[idx];
  const updPairs = [
    [grad.attentionBias, upd.attentionBias],
    [grad.attentionWeightMatrix, upd.attentionWeightMatrix],
    [grad.specializationWeights, upd.specializationWeights],
    [grad.outputWeights, upd.outputWeights],
    [grad.outputBias, upd.outputBias],
  ];
  for (let L = 0; L < hm._numLayers; L++) {
    for (const k of ['Wq', 'Wk', 'Wv', 'Wo']) updPairs.push([grad.attentionWeights[L][k], upd.attentionWeights[L][k]]);
    for (const k of ['gate_proj', 'up_proj', 'down_proj']) updPairs.push([grad.ffnWeights[L][k], upd.ffnWeights[L][k]]);
    updPairs.push([grad.layerNormWeights[L].gamma1, upd.layerNormWeights[L].gamma1]);
    updPairs.push([grad.layerNormWeights[L].gamma2, upd.layerNormWeights[L].gamma2]);
  }
  for (let pi = 0; pi < pairs.length; pi++) {
    const rec = (aChild, wPar, uPar, key, mid) => {
      if (typeof aChild === 'number') {
        if (!isNum(aChild)) return;
        const m = (st.m.get(mid) || 0) * beta1 + (1 - beta1) * aChild;
        const v = (st.v.get(mid) || 0) * beta2 + (1 - beta2) * aChild * aChild;
        st.m.set(mid, m); st.v.set(mid, v);
        const mh = m / bc1, vh = v / bc2;
        const d = lr * (mh / (Math.sqrt(vh) + eps) + wd * wPar[key]);
        wPar[key] = wPar[key] - d;
        uPar[key] = d;
        return;
      }
      if (aChild != null && typeof aChild === 'object') {
        for (const k of Object.keys(aChild)) rec(aChild[k], wPar[key], uPar[key], k, `${mid}.${k}`);
      }
    };
    const [aNode, wNode] = pairs[pi];
    const uNode = updPairs[pi][1];
    if (aNode != null && typeof aNode === 'object') for (const k of Object.keys(aNode)) rec(aNode[k], wNode, uNode, k, `${idx}:${k}`);
  }
  hm._specWeightCache[idx] = null;
  return upd;
}

function scaleTree(n, s) {
  if (typeof n === 'number') return isNum(n) ? n * s : n;
  if (Array.isArray(n)) return n.map((v) => scaleTree(v, s));
  if (n != null && typeof n === 'object') {
    const o = {};
    for (const k of Object.keys(n)) o[k] = scaleTree(n[k], s);
    return o;
  }
  return n;
}

function makeHive(arm, dir, totalSamples) {
  const hm = new HiveMind(dir, ES, P, `c2-${arm}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, true);
  const baseLR = hm._learningRate;
  if (arm !== 'stock') {
    hm._adaptiveLearningRate = new Array(ES).fill(baseLR);
    hm._updateAdaptiveLearningRates = () => {};
    const st = adamState();
    if (arm === 'plain') {
      const origApply = hm._applyGradients.bind(hm);
      hm._applyGradients = (shouldScale, shouldClone, steps) => {
        for (let i = 0; i < ES; i++) globalClip(hm, i, 1.0);
        return origApply(false, shouldClone, steps);
      };
    } else if (arm === 'adamw') {
      const ctr = { seen: 0 };
      const origTrain = hm.train.bind(hm);
      hm.train = (x, y, w) => { ctr.seen++; return origTrain(x, y, w); };
      hm._applyGradients = (shouldScale, shouldClone, steps) => {
        st.t++;
        let clones = null;
        if (shouldClone) clones = hm._setGradientStructure();
        const prog = Math.min(1, ctr.seen / Math.max(1, totalSamples));
        const lr = baseLR * (1 + Math.cos(Math.PI * prog));
        const norm = 1 / (Math.max(1, steps) * baseLR);
        for (let i = 0; i < ES; i++) {
          globalClip(hm, i, 1.0);
          const grad = scaleTree(hm._gradientAccumulation[i], norm);
          const upd = adamApply(hm, i, st, grad, lr, 0.01);
          if (shouldClone) clones[i] = upd;
        }
        if (shouldClone) return clones;
      };
    }
  }
  return hm;
}

function main() {
  const marks = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/marks_8h.json'), 'utf8'));
  const syms = Object.keys(marks.symbols);
  const rets = syms.map((s) => {
    const v = marks.symbols[s].v.filter((x) => typeof x === 'number' && x > 0);
    const o = [];
    for (let t = 1; t < v.length; t++) o.push(Math.log(v[t] / v[t - 1]));
    return o;
  });
  const T = Math.min(...rets.map((r) => r.length));
  const rows = [];
  for (let j = 0; j < syms.length; j++)
    for (let t = P; t < T - 1; t++) rows.push({ x: rets[j].slice(t - P, t), y: rets[j][t + 1] > 0 ? 1 : 0 });
  const arms = ['stock', 'plain', 'adamw'];
  const losses = { stock: [], plain: [], adamw: [] };
  const briers = {};
  for (let b = 0; b < N_BLOCKS; b++) {
    const te0 = Math.floor((rows.length * (b + 1)) / (N_BLOCKS + 1));
    const tr = rows.slice(Math.max(0, te0 - N_TRAIN), te0);
    const te = rows.slice(te0, te0 + N_TEST);
    if (tr.length < 100 || te.length < 50) continue;
    for (const arm of arms) {
      seedRandom(777 + b);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `c2-${arm}-`));
      const hm = makeHive(arm, dir, N_TRAIN * N_BLOCKS);
      for (const r of tr) hm.train(r.x, r.y, 1);
      let s = 0;
      for (const r of te) {
        const p = hm.predict(r.x);
        const prob = isNum(p) ? Math.min(0.99, Math.max(0.01, p)) : 0.5;
        losses[arm].push((prob - r.y) ** 2);
        s += (prob - r.y) ** 2;
      }
      briers[`${arm}_b${b}`] = s / te.length;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const summary = {
    arms, nTrain: N_TRAIN, nTest: N_TEST, blocks: N_BLOCKS, n: rows.length,
    brier: Object.fromEntries(arms.map((a) => [a, +mean(losses[a]).toFixed(5)])),
    perBlock: Object.fromEntries(Object.entries(briers).map(([k, v]) => [k, +v.toFixed(5)])),
  };
  const dm = {};
  for (const [a, bb] of [['plain', 'stock'], ['adamw', 'stock'], ['adamw', 'plain']]) {
    try { dm[`${a}_vs_${bb}`] = dieboldMariano({ lossA: losses[a], lossB: losses[bb] }); }
    catch (e) { dm[`${a}_vs_${bb}`] = { error: String(e).slice(0, 120) }; }
  }
  summary.dm = dm;
  summary.losses = Object.fromEntries(arms.map((a) => [a, losses[a].length]));
  Math.random = realRandom;
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(`c2-ablation: n=${summary.n} train=${N_TRAIN} test=${N_TEST} blocks=${N_BLOCKS}`);
  console.log(`brier ${JSON.stringify(summary.brier)}`);
  console.log(`lossCounts ${JSON.stringify(summary.losses)}`);
  for (const [k, v] of Object.entries(dm)) {
    if (v && v.available) console.log(`dm ${k}: n=${v.n} meanDiff=${v.meanDifferential} p=${v.pValue} favored=${v.favored}`);
    else console.log(`dm ${k}: UNAVAILABLE ${JSON.stringify(v).slice(0, 160)}`);
  }
  console.log(`wrote ${OUT}`);
}

try { main(); } catch (e) { console.error(`c2-ablation FATAL: ${e && e.stack ? e.stack : e}`.slice(0, 2000)); process.exit(1); }
