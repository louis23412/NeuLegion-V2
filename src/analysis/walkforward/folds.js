// Walk-forward fold aggregation — split from `analysis/walkforward.js` in
// round 74 (byte-exact move): per-fold pooling, the R2 window-robustness
// statistic, the R1 long-sample scorers and the fold-win fraction.

import { strategyReturns, backtestMetrics, poolFolds } from '../backtest.js';
import { positionAt } from '../features.js';
import { sharpeRatio } from '../performance.js';
import { barReturns } from './returns.js';


// summary. `positiveFraction` = fraction of folds with a positive metric.
export function aggregateFolds(perFold, key = 'netSharpe') {
    const vals = perFold
        .map((f) => (f && f.metrics ? f.metrics[key] : f && f[key]))
        .filter((v) => Number.isFinite(v));
    const n = vals.length;
    if (n === 0) return { n: 0, mean: NaN, median: NaN, std: NaN, positiveFraction: NaN, min: NaN, max: NaN };
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const sorted = [...vals].sort((a, b) => a - b);
    const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    const variance = n > 1 ? vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
    return {
        n,
        mean,
        median,
        std: Math.sqrt(variance),
        positiveFraction: vals.filter((v) => v > 0).length / n,
        min: sorted[0],
        max: sorted[n - 1],
    };
}

// Round 32 (lab R2, F-01/J2): window robustness as a pure statistic. Split the
// scored series into `blocks` disjoint TRAILING windows (the leading
// `n - blocks*size` bars are unused, exactly like the lab), score each window's
// Sharpe, and report the per-window Sharpes, the positive fraction and the
// min/max. Ported from the lab's `e2_arm_sweep.js#blockStability` (same layout,
// same non-finite→0 mean convention, same default k=6); the only addition is
// the `periodsPerYear` parameter, which defaults to the lab's PERIODS_PER_YEAR
// (252), so the repo's numbers match the lab's on the same input. The gate
// reads `positiveFraction`: `accel-16` is 6/6 positive while `mom-48` is 5/6
// with a sign flip between windows — the cheap statistic that catches J1 at
// the source. A degenerate input (empty panel, `blocks` < 1, or a series too
// short to form one bar per block) returns the NaN shape rather than a
// fabricated fraction.
export function blockStability(netByStream, blocks = 6, { periodsPerYear = 252 } = {}) {
    const k = Number.isInteger(blocks) ? blocks : Math.floor(blocks);
    const bad = !Array.isArray(netByStream) || netByStream.length === 0 || !Number.isFinite(k) || k < 1;
    const n = bad ? 0 : netByStream[0] ? netByStream[0].length : 0;
    const size = bad ? 0 : Math.floor(n / k);
    if (bad || !Number.isFinite(n) || n < 1 || size < 1) {
        return { blocks: bad ? blocks : k, blockSharpes: [], positiveFraction: NaN, min: NaN, max: NaN };
    }
    const perBlockMean = [];
    for (let b = 0; b < k; b++) {
        const from = n - (k - b) * size;
        const vals = netByStream.map((s) => sharpeRatio(s.slice(from, from + size), { periodsPerYear }));
        perBlockMean.push(vals.reduce((a, x) => a + (Number.isFinite(x) ? x : 0), 0) / vals.length);
    }
    return {
        blocks: k,
        blockSharpes: perBlockMean,
        positiveFraction: perBlockMean.filter((v) => v > 0).length / perBlockMean.length,
        min: Math.min(...perBlockMean),
        max: Math.max(...perBlockMean),
    };
}

// Round 33 (lab R1, F-01/J1): the model-free long-sample scorer. A parameter-free
// signal scored contiguously over the whole history is EQUIVALENT to the
// walk-forward path (lab F-13: the fold boundaries add no information when there
// is nothing to fit), so this bypasses folds entirely: positions are emitted bar
// by bar through the same `positionAt` pipeline the A/B scores, then measured
// with the same `backtestMetrics` at the run's cost plus the 5/10 bps reporter
// (the lab R3 full-history half) and the round-32 `blockStability` over the net
// series. `net`/`gross` are retained BY REFERENCE (no copies, like
// `purgedCVBacktest`'s `foldInputs`) so a caller can pool streams without
// re-scoring. `panel` is the verdict-shaped cross-section (`{ streamIndex,
// labels, returnsByStream }`) or null; a panel read past a shorter stream's end
// is NaN and abstains, exactly like the verdict path. A degenerate input (no
// candidate, fewer than 2 closes) returns the `{ available:false, reason }`
// shape rather than a fabricated row.
export function scoreSignalFullHistory({
    closes, volumes = null, candidate, panel = null,
    costBps = 0, periodsPerYear = 252, trials = 1, blocks = 6,
} = {}) {
    if (!candidate || typeof candidate.fn !== 'function') {
        return { available: false, reason: 'no signal candidate (a model arm has no parameter-free position function)', bars: 0, metrics: null, net: null, gross: null, blockStability: null };
    }
    if (!Array.isArray(closes) || closes.length < 2) {
        return { available: false, reason: 'fewer than 2 closes (no return series to score)', bars: 0, metrics: null, net: null, gross: null, blockStability: null };
    }
    const returns = barReturns(closes);
    const vols = Array.isArray(volumes) && volumes.length === closes.length ? volumes : null;
    const series = { closes, returns, volumes: vols, panel };
    const signals = closes.map((_, t) => positionAt(candidate, series, t));
    const at = (c) => backtestMetrics({ returns, signals, costBps: c, periodsPerYear, trials });
    const metrics = at(costBps);
    const net = strategyReturns({ returns, signals, costBps }).returns;
    const gross = strategyReturns({ returns, signals, costBps: 0 }).gross;
    return {
        available: true,
        bars: closes.length,
        metrics,
        netSharpeAt5bps: at(5).netSharpe,
        netSharpeAt10bps: at(10).netSharpe,
        net,
        gross,
        signals,
        returns,
        blockStability: blockStability([net], blocks, { periodsPerYear }),
    };
}

// Pool one scored stream per symbol into a single long-sample row. The streams
// are tail-aligned to the shortest (the verdict path aligns by bar index on the
// same convention) and averaged per bar — the equal-weight basket the P4 sleeve
// reader already uses — then pooled with EXACTLY the `poolFolds` arithmetic
// (one stream is the identity, like one report). Deliberately
// dependence-free: on a full history the cluster jackknife dominates the cost
// (lab F-14: ~155 s at 3 562 folds, ~600x the scoring), so the long-sample path
// reports the raw DSR at the run's K and leaves the dependence correction to
// the verdict window. Returns the pooled row plus the per-stream rows it was
// built from.
export function poolSignalFullHistory(streams, { costBps = 0, periodsPerYear = 252, trials = 1, blocks = 6 } = {}) {
    const rows = (Array.isArray(streams) ? streams : []).filter((s) => s && s.available && Array.isArray(s.net) && Array.isArray(s.gross));
    if (!rows.length) {
        return { available: false, reason: 'no scored streams to pool', bars: 0, streams: 0, pooledMetrics: null, blockStability: null, perStream: [] };
    }
    const len = Math.min(...rows.map((s) => s.net.length));
    if (!Number.isFinite(len) || len < 1) {
        return { available: false, reason: 'scored streams are empty', bars: 0, streams: rows.length, pooledMetrics: null, blockStability: null, perStream: [] };
    }
    const tail = (a) => a.slice(a.length - len);
    const mean = (arrs) => {
        const out = new Array(len).fill(0);
        for (let t = 0; t < len; t++) {
            let acc = 0;
            for (const a of arrs) acc += a[t];
            out[t] = acc / arrs.length;
        }
        return out;
    };
    const pooledNet = mean(rows.map((s) => tail(s.net)));
    const pooledGross = mean(rows.map((s) => tail(s.gross)));
    const { pooledMetrics, meanFoldSharpe } = poolFolds(
        rows.map((s) => ({ metrics: s.metrics })),
        pooledNet,
        pooledGross,
        { periodsPerYear, trials },
    );
    const at = (c) => {
        const nets = rows
            .filter((s) => Array.isArray(s.returns) && Array.isArray(s.signals) && s.returns.length === s.signals.length)
            .map((s) => strategyReturns({ returns: s.returns, signals: s.signals, costBps: c }).returns);
        if (!nets.length) return NaN;
        return sharpeRatio(mean(nets.map(tail)), { periodsPerYear });
    };
    return {
        available: true,
        bars: len,
        streams: rows.length,
        pooledMetrics,
        meanStreamSharpe: meanFoldSharpe,
        netSharpeAt5bps: at(5),
        netSharpeAt10bps: at(10),
        net: pooledNet,
        blockStability: blockStability([pooledNet], blocks, { periodsPerYear }),
        perStream: rows.map((s) => ({ label: s.label || null, bars: s.bars, metrics: s.metrics, blockStability: s.blockStability })),
    };
}

// Round 33 (lab R1): the long-sample readout as one report block. `fullStreams`
// are the UNSLICED per-symbol series (`{ label, closes, volumes }`); `variants`
// are the run's ACTIVE candidates in roster order. Every `kind:'signal'` arm is
// scored contiguously over each stream's full history and pooled with
// `poolSignalFullHistory` at the run's K; any other kind lands
// `{ available:false }` with the reason (model arms keep `--bars`). The pooled
// row carries no raw series — only metrics, the 5/10 bps restatements and the
// block readout — so the block is report.json-safe at any history length.
export function buildFullHistoryBlock({ fullStreams, variants, trials = 1, costBps = 0, periodsPerYear = 252, blocks = 6 } = {}) {
    const streams = (Array.isArray(fullStreams) ? fullStreams : [])
        .filter((s) => s && Array.isArray(s.closes) && s.closes.length >= 2)
        .map((s) => ({ label: s.label || null, closes: s.closes, volumes: s.volumes || null, returns: barReturns(s.closes) }));
    const arms = {};
    for (const v of (Array.isArray(variants) ? variants : [])) {
        const id = v && v.id != null ? v.id : 'unknown';
        if (!v || v.kind !== 'signal' || typeof v.fn !== 'function') {
            arms[id] = { id, label: (v && v.label) || null, available: false, reason: 'not a parameter-free signal arm — model arms keep --bars (a controller fit replays all history per fold, O(n^2) per stream; audit A10)' };
            continue;
        }
        if (!streams.length) {
            arms[id] = { id, label: v.label || null, available: false, reason: 'no full-history stream (every stream was too short to score)' };
            continue;
        }
        const panel = streams.length >= 2
            ? { streamIndex: -1, label: 'full', labels: streams.map((s) => s.label), returnsByStream: streams.map((s) => s.returns) }
            : null;
        const perStream = streams.map((s, i) => ({
            label: s.label,
            ...scoreSignalFullHistory({
                closes: s.closes,
                volumes: s.volumes,
                candidate: v,
                panel: panel ? { ...panel, streamIndex: i } : null,
                costBps,
                periodsPerYear,
                trials,
                blocks,
            }),
        }));
        const pooled = poolSignalFullHistory(perStream, { costBps, periodsPerYear, trials, blocks });
        arms[id] = {
            id,
            label: v.label || null,
            available: pooled.available,
            reason: pooled.reason || null,
            bars: pooled.bars,
            streams: pooled.streams,
            pooledMetrics: pooled.pooledMetrics,
            meanStreamSharpe: pooled.meanStreamSharpe,
            netSharpeAt5bps: pooled.netSharpeAt5bps,
            netSharpeAt10bps: pooled.netSharpeAt10bps,
            blockStability: pooled.blockStability,
            perStream: pooled.perStream,
        };
    }
    return {
        available: true,
        mode: 'contiguous',
        trials,
        costBps,
        streams: streams.map((s) => ({ label: s.label, bars: s.closes.length })),
        arms,
        reader: 'the long-sample readout (lab R1): every parameter-free signal arm scored contiguously over each stream\u2019s FULL history (no folds — F-13 equivalence) and pooled as an equal-weight basket tail-aligned to the shortest stream, at the run\u2019s K. Deliberately dependence-free (the cluster jackknife dominates the cost at full-history lengths — lab F-14), so this column is a DIAGNOSTIC beside the verdict, not a second gate. A verdict that disagrees with this column was read off the --bars window (F-01).',
    };
}

// Fraction of folds on which the candidate's metric strictly beats the
// baseline's (paired by fold index). The "did it win almost everywhere, or just
// on average?" guard.
export function foldWinFraction(candidateFolds, baselineFolds, key = 'netSharpe') {    const m = Math.min(candidateFolds.length, baselineFolds.length);
    let wins = 0;
    let n = 0;
    for (let i = 0; i < m; i++) {
        const c = candidateFolds[i] && candidateFolds[i].metrics ? candidateFolds[i].metrics[key] : NaN;
        const b = baselineFolds[i] && baselineFolds[i].metrics ? baselineFolds[i].metrics[key] : NaN;
        if (!Number.isFinite(c) || !Number.isFinite(b)) continue;
        n++;
        if (c > b) wins++;
    }
    return n ? wins / n : NaN;
}

// The lookahead audit.
//
// For every test bar t in every fold we perturb every value at index > t, re-run
// `signalForFold` on the perturbed view, and compare the signal emitted *at t*.
// If it moves, the signal at t used information from after t — lookahead. Report
// every offending (fold, index) pair, not just the first, so a partial leak is
// visible.
//
// Contract: `signalForFold` must read the information from `view`, and that
// information must be derived from the array the audit perturbs. Signals may
// legitimately depend on bars with index <= t (including earlier test bars): at
// bar t only the close at t is known, and the position it decides is realised at
// t+1.
//
// `viewFor(returns, perturb)` — optional. `perturb` is `null` for the base pass,
// or `{ after, probe, returns }` for a probe pass (`returns` is the perturbed
// array, provided for callers that consume the return series directly). A model
// whose features come from candles (the shipped `HiveMindController`) is immune
// to a returns-only perturbation, so its audit used to pass VACUOUSLY
// (docs/BUGS.md #22): supplying `viewFor` lets the caller build the view the
// model actually reads and derive it from the perturbed series. The audit then
//
//   * enforces the structural fix: when `viewFor` is supplied, the base and
//     perturbed views MUST differ, otherwise the perturbation cannot reach the
//     model and the result is reported `vacuous` (never `clean`);
//   * optionally enforces the behavioural one: with `requireReachable`, at least
//     one probe must move a *later* position, i.e. the model demonstrably reads
//     the perturbed input.
//
// `auditProbesPerFold` (0 = all) samples the decision points at that budget. The
// full sweep re-runs `signalForFold` once per test bar, which for a
// controller-backed model means a full refit per probe; sampling is a documented