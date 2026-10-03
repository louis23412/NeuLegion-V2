// p4a-legion.mjs — P4 legion-aggregation firewall on the REAL repo stack (native-only).
//
// Post-collapse (R-LEGION executed CYCLE-250): the S6 propagation stack is
// gone — computeDynamicWeights IS score-only (finalWeight = prob*score) and
// getLegionConsensus runs weights -> hierarchicalAggregate -> resolve with no
// propagation. Arms differ ONLY in finalWeight (everything else is the
// shipped pipeline):
//   production: computeDynamicWeights -> hierarchicalAggregate -> resolveConsensus
//   uniform   : same aggregate/resolve with all finalWeight = 1
//   score-only: finalWeight = prob*score, set explicitly (must equal production)
// Synthetic controllers (8: 2 groups x 2 sections x 2 layers, half positive /
// half negative polarity — polarity votes, weights decide, exactly like
// collectAndEnrichSignals). Skilled controllers raise prob when their polarity
// matches truth; noise controllers emit U(0.35,0.65).
// Frames: F-homog (all weakly skilled) | F-minority (2/8 skilled).
// Metric: consensus-direction Heidke-like skill vs base rate.
// Zero edits to locked modules, no golden moves, no repo writes: the two
// SQLite files land in a mkdtemp dir (NEULEGION_STATE honored when set),
// and resolveConsensus is called directly (never getLegionConsensus), so no
// sim rows are written — read-only probe.
//
// Usage: node scripts/p4a-legion.mjs [--bars 500 --out /tmp/p4a.json]
// Paste back: the full stdout summary. Exit non-zero on any arm error.
//
// RULE (post-collapse firewall): production≡score-only (|diff| == 0) on BOTH
// frames -> COLLAPSED-OK (the shipped path is the validated simple arm).
// Else DIVERGED (the collapse changed more than propagation — investigate).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) =>
    a.startsWith('--') ? [[a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : '1']] : []
  )
);
const T = parseInt(args.bars || '500', 10);
const OUT = args.out || path.join(os.tmpdir(), 'p4a-legion.json');
const SEEDS = [7, 8, 9];
const MARKET = { price: 100, atrProxy: 0.5, volatility: 0.005 };

const mulberry32 = (seed) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const gauss = (rnd) => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

if (!process.env.NEULEGION_STATE) {
  process.env.NEULEGION_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'p4a-'));
}
const { computeDynamicWeights, hierarchicalAggregate, resolveConsensus } =
  await import('../src/legion/signals.js');

function buildControllers(rnd, skillIdx) {
  const ctrls = [];
  let i = 0;
  for (let g = 0; g < 2; g++) for (let s = 0; s < 2; s++) for (let l = 0; l < 2; l++) {
    ctrls.push({
      id: `0-${g}-${s}-${i}`, direction: i % 2 === 0 ? 'BUY' : 'SELL',
      polaritySign: i % 2 === 0 ? 1 : -1,
      group: g, section: s, layer: l, cluster: i,
      tier: 1 + Math.floor(rnd() * 3),
      memConnections: Math.floor(rnd() * 6), childConnections: Math.floor(rnd() * 6),
      vaultMemories: 0, entryPrice: 100, exitPrice: 101, stopLoss: 99,
      compatibility: null, skilled: skillIdx.includes(i),
    });
    i++;
  }
  return ctrls;
}
function barSignals(ctrls, truth, rnd) {
  return ctrls.map((c) => {
    const match = (c.direction === 'BUY') === (truth === 1);
    let prob, score, recentPerf;
    if (c.skilled) {
      prob = (match ? 0.75 : 0.25) + gauss(rnd) * 0.05;
      score = 0.7; recentPerf = 0.7;
    } else {
      prob = 0.35 + rnd() * 0.3;
      score = 0.5; recentPerf = 0.5;
    }
    prob = Math.max(0.01, Math.min(0.99, prob));
    return { ...c, prob, score, recentPerf, signalSpeed: 1000 };
  });
}
function consensusFor(sigs, arm) {
  const weighted = computeDynamicWeights(sigs);
  if (arm === 'production') return resolveConsensus(hierarchicalAggregate(weighted), MARKET);
  if (arm === 'uniform') {
    return resolveConsensus(hierarchicalAggregate(weighted.map((s) => ({ ...s, finalWeight: 1 }))), MARKET);
  }
  return resolveConsensus(hierarchicalAggregate(weighted.map((s) => ({ ...s, finalWeight: Math.max(0.01, s.prob * s.score) }))), MARKET);
}

const FRAMES = [
  { name: 'F-homog', skilled: [0, 1, 2, 3, 4, 5, 6, 7] },
  { name: 'F-minority', skilled: [0, 3] },
];
const ARMS = ['production', 'uniform', 'score-only'];
const table = {};
for (const f of FRAMES) {
  table[f.name] = {};
  for (const a of ARMS) table[f.name][a] = [];
  for (const seed of SEEDS) {
    const rnd = mulberry32(seed * 977 + (f.name === 'F-minority' ? 13 : 0));
    const ctrls = buildControllers(rnd, f.skilled);
    const Y = [];
    const pred = { production: [], uniform: [], 'score-only': [] };
    for (let t = 0; t < T; t++) {
      const truth = rnd() < 0.5 ? 1 : 0;
      Y.push(truth);
      const sigs = barSignals(ctrls, truth, rnd);
      for (const a of ARMS) pred[a].push(consensusFor(sigs, a).direction === 'BUY' ? 1 : 0);
    }
    const base = Y.reduce((x, v) => x + v, 0) / T;
    const denom = 1 - Math.max(base, 1 - base);
    for (const a of ARMS) {
      const acc = Y.filter((v, i) => v === pred[a][i]).length / T;
      table[f.name][a].push(denom > 0 ? (acc - Math.max(base, 1 - base)) / denom : 0);
    }
  }
  for (const a of ARMS) {
    const v = table[f.name][a];
    table[f.name][a] = { seeds: v.map((x) => +x.toFixed(4)), mean: +(v.reduce((x, y) => x + y, 0) / v.length).toFixed(4) };
  }
}
const div = (f) => Math.abs(table[f]['production'].mean - table[f]['score-only'].mean);
const d1 = div('F-homog'), d2 = div('F-minority');
const verdict = (d1 === 0 && d2 === 0) ? 'COLLAPSED-OK' : `DIVERGED:homog=${d1.toFixed(4)} minority=${d2.toFixed(4)}`;

console.log('P4a legion firewall (REAL signals.js pipeline, read-only)');
for (const f of FRAMES) {
  console.log(` ${f.name}: ` + ARMS.map((a) => `${a}=${table[f.name][a].mean}`).join(' '));
}
console.log(' |production − score-only|: homog=' + d1.toFixed(4) + ' minority=' + d2.toFixed(4));
console.log(' verdict: ' + verdict);
fs.writeFileSync(OUT, JSON.stringify({ bars: T, seeds: SEEDS, table, divHomog: +d1.toFixed(4), divMinority: +d2.toFixed(4), verdict }, null, 2));
console.log(' wrote ' + OUT);
if (!Number.isFinite(d1) || !Number.isFinite(d2)) { console.error('P4a: non-finite divergence'); process.exit(1); }
