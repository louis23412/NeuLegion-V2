// p3a-sharing.mjs — P3 sharing-off A/B at the mind level (native-only).
//
// Vends the lab experiment p3a_sharing.js (CYCLE-247) VERBATIM in recipe —
// same m5g synth deterministic frame y=1{x0>0} (IS=8, NTR=80/NTE=40, frame
// 4242), same seeds 7,8,9, same e115 metrics — but with ZERO lab dependency:
// HiveMind imports from ../src, state DBs go to mkdtemp dirs (rmSync'd after;
// dumpState never called, no repo writes).
// Per seed: two FRESH minds (CYCLE-225 law), same init seed —
// ON = stock train; OFF = per-instance `_hiveMemorySharing` assignment
// (probe-only, no repo edit; post-R-SHARING-delete the method is gone so this
// is a vacuous prop-set and both arms run the identical path — |d| must be
// exactly 0, a built-in firewall for the deletion). predict-then-train on
// _updateHiveState collection on TEST (m5g convention).
// Metrics (e115 convention, Brier skill vs TRAIN base on TEST):
//   (a) member-mean prob skill; (b) ridge-on-members skill (m5g recipe).
//
// Usage: node scripts/p3a-sharing.mjs [--out /tmp/p3a.json]
// Paste back: the full stdout summary. Exit non-zero on any arm error.
//
// RULE (pre-registered, BODY-VARIANTS.md P3): |ON-OFF| < 0.02 on BOTH metrics
//   at ALL 3 seeds -> SHARING-DEAD (R-SHARING deletion executes).
//   Else SHARING-MATTERS (keep + characterize which metric moves).
//
// Honest rng note: sharing consumes Math.random (transfer noise), so OFF
// diverges from ON in downstream draws too — the arms differ by "sharing
// presence", not by one no-op; 3 seeds carry the variance. Broadcast/
// translate (controller-level, hiveMindController/bcR path) is NOT covered —
// that is P3b, only if P3a matters.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import HiveMind from '../src/hivemind/hiveMind.js';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) =>
    a.startsWith('--') ? [[a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : '1']] : []
  )
);
const OUT = args.out || path.join(os.tmpdir(), 'p3a-sharing.json');
const ES = 4, IS = 8, NTR = 80, NTE = 40, SEEDS = [7, 8, 9], FRAME = 4242;
const SIG = (x) => 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));

const mulberry32 = (seed) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const realRandom = Math.random;
const seedRandom = (seed) => { Math.random = mulberry32(seed); };
function gauss(rnd) { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function synthBars(seed, n) {
  const rnd = mulberry32(seed);
  const X = [], y = [];
  for (let t = 0; t < n; t++) {
    const row = [];
    for (let i = 0; i < IS; i++) row.push(gauss(rnd));
    X.push(row);
    y.push(row[0] > 0 ? 1 : 0);
  }
  return { X, y };
}
function brier(probs, y) { let s = 0; for (let i = 0; i < y.length; i++) { const d = probs[i] - y[i]; s += d * d; } return s / y.length; }
function skillVsBase(probs, y, base) { const bb = brier(y.map(() => base), y); return bb > 0 ? 1 - brier(probs, y) / bb : 0; }
function solveRidge(X, y, lam, d) {
  const A = Array.from({ length: d + 1 }, () => new Float64Array(d + 1));
  const b = new Float64Array(d + 1);
  for (let i = 0; i < X.length; i++) {
    const r = X[i], t = y[i];
    for (let a = 0; a <= d; a++) {
      const va = a < d ? r[a] : 1;
      b[a] += va * t;
      for (let c = 0; c <= d; c++) A[a][c] += va * (c < d ? r[c] : 1);
    }
  }
  for (let a = 0; a <= d; a++) A[a][a] += lam;
  const n = d + 1;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    const tmp = M[c]; M[c] = M[p]; M[p] = tmp;
    const div = M[c][c] || 1e-12;
    for (let k = c; k <= n; k++) M[c][k] /= div;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f !== 0) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row) => row[n]);
}
const dot = (w, x) => { let s = w[w.length - 1]; for (let i = 0; i < x.length; i++) s += w[i] * x[i]; return s; };

function runArm(Xtr, ytr, Xte, seed, sharingOn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p3a-${sharingOn ? 'on' : 'off'}-`));
  seedRandom(seed);
  try {
    const hm = new HiveMind(dir, ES, IS, 'P3A', true);
    if (!sharingOn) hm._hiveMemorySharing = () => {};
    const Mtr = [];
    for (let t = 0; t < NTR; t++) {
      const r = hm._updateHiveState(Xtr[t], null, false, false, false, true);
      Mtr.push([...r.outputs]);
      hm.train(Xtr[t], ytr[t]);
    }
    const Mte = [], Pte = [];
    for (let t = 0; t < NTE; t++) {
      const r = hm._updateHiveState(Xte[t], null, false, false, false, true);
      Mte.push([...r.outputs]);
      const mean = r.outputs.reduce((a, v) => a + v, 0) / r.outputs.length;
      Pte.push(SIG(mean));
    }
    return { Mtr, Mte, Pte };
  } finally {
    Math.random = realRandom;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const frame = synthBars(FRAME, NTR + NTE);
const Xtr = frame.X.slice(0, NTR), ytr = frame.y.slice(0, NTR);
const Xte = frame.X.slice(NTR), yte = frame.y.slice(NTR);
const base = ytr.reduce((a, v) => a + v, 0) / NTR;
if (!(base > 0.3 && base < 0.7)) { console.error('P3a: degenerate frame base=' + base); process.exit(1); }

const rows = [];
for (const seed of SEEDS) {
  const on = runArm(Xtr, ytr, Xte, seed, true);
  const off = runArm(Xtr, ytr, Xte, seed, false);
  const sMean = (arm) => skillVsBase(arm.Pte, yte, base);
  const sRidge = (arm) => {
    const w = solveRidge(arm.Mtr, ytr, 1.0, ES);
    return skillVsBase(arm.Mte.map((m) => SIG(dot(w, m))), yte, base);
  };
  rows.push({
    seed,
    onMean: +sMean(on).toFixed(4), offMean: +sMean(off).toFixed(4),
    dMean: +(sMean(on) - sMean(off)).toFixed(4),
    onRidge: +sRidge(on).toFixed(4), offRidge: +sRidge(off).toFixed(4),
    dRidge: +(sRidge(on) - sRidge(off)).toFixed(4),
  });
}
const dead = rows.every((r) => Math.abs(r.dMean) < 0.02 && Math.abs(r.dRidge) < 0.02);
const verdict = dead ? 'SHARING-DEAD' : 'SHARING-MATTERS';

console.log('P3a sharing ablation (m5g recipe, ON vs OFF, native, read-only)');
for (const r of rows) {
  console.log(` seed${r.seed}: onMean=${r.onMean} offMean=${r.offMean} dMean=${r.dMean} | onRidge=${r.onRidge} offRidge=${r.offRidge} dRidge=${r.dRidge}`);
}
console.log(' verdict: ' + verdict);
fs.writeFileSync(OUT, JSON.stringify({ frame: FRAME, seeds: SEEDS, base: +base.toFixed(4), rows, verdict }, null, 2));
console.log(' wrote ' + OUT);
for (const r of rows) {
  for (const v of [r.onMean, r.offMean, r.onRidge, r.offRidge]) {
    if (!Number.isFinite(v)) { console.error('P3a: non-finite skill'); process.exit(1); }
  }
}
