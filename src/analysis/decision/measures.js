// src/analysis/decision/measures.js (round-97 split of src/analysis/decision.js).
// Fold concentration + confidence persistence; isNum/na exported for inter-part use only.
import { sharpeRatio, normalInvCdf } from '../performance.js';
import { strategyReturns } from '../backtest.js';

export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
export const na = (reason) => ({ available: false, reason });



// ---------------------------------------------------------------------------
// Question 3 — concentration: how much of the edge is a handful of folds?
// ---------------------------------------------------------------------------
// `sig:volume`'s best 20 of 1,136 folds carried 108% of its gross P&L: a candidate
// can win the aggregate and still be a lottery ticket on a few windows. This block
// makes that visible in the artifact (top-K share, signed sums) and measures the
// two inferential consequences directly:
//   - the delete-one-cluster range: the pooled Sharpe when each single fold-window
//     is removed (a wide range means the aggregate is carried by one window);
//   - the per-fold marginal contribution: pooled(Sharpes all) minus pooled(Sharpes
//     without fold i), i.e. what each fold buys the headline number.
// The strategy net returns are rebuilt from the retained `foldInputs` with the same
// `strategyReturns` arithmetic the scored pass used, so this is a restatement, not a
// re-scoring.
export function foldConcentration({ folds, foldInputs = null, costBps = 0, periodsPerYear = 252, topKs = [1, 5, 20] } = {}) {
    if (!Array.isArray(folds) || folds.length === 0) return na('no per-fold metrics');
    const n = folds.length;
    const gross = folds.map((f) => (f && f.metrics && isNum(f.metrics.grossPnl) ? f.metrics.grossPnl : 0));
    const grossTotal = gross.reduce((a, b) => a + b, 0);
    let positiveSum = 0;
    let negativeSum = 0;
    for (const g of gross) {
        if (g > 0) positiveSum += g;
        else if (g < 0) negativeSum += g;
    }
    const sorted = gross.slice().sort((a, b) => b - a);
    const ks = [...new Set((Array.isArray(topKs) ? topKs : []).filter((k) => isNum(k) && k > 0).map((k) => Math.min(Math.floor(k), n)))].sort((a, b) => a - b);
    const topKsOut = ks.map((k) => ({
        k,
        share: grossTotal > 0 ? sorted.slice(0, k).reduce((a, b) => a + b, 0) / grossTotal : null,
    }));
    const block = {
        available: true,
        folds: n,
        grossTotal,
        positiveSum,
        negativeSum,
        topKs: topKsOut,
        deleteOneCluster: na('per-fold inputs were not retained (delete-one-cluster readout unavailable)'),
        marginal: na('per-fold inputs were not retained (per-fold marginal contribution unavailable)'),
        reader: 'top-K share of gross P&L, signed fold sums, the pooled Sharpe range across leave-one-fold-out panels (deleteOneCluster), and each fold\'s marginal contribution to the pooled Sharpe. A candidate whose best few folds carry the gross is a lottery ticket, however strong the aggregate.',
    };
    if (!Array.isArray(foldInputs) || foldInputs.length !== n) return block;
    const usable = foldInputs.every((fi) => fi && Array.isArray(fi.returns) && Array.isArray(fi.signals) && fi.returns.length === fi.signals.length);
    if (!usable) return block;
    const nets = foldInputs.map((fi) => strategyReturns({ returns: fi.returns, signals: fi.signals, costBps }).returns);
    const pooledAll = [].concat(...nets);
    const full = sharpeRatio(pooledAll, { periodsPerYear });
    const leaveOut = [];
    for (let i = 0; i < n; i++) {
        const rest = [].concat(...nets.slice(0, i), ...nets.slice(i + 1));
        leaveOut.push(sharpeRatio(rest, { periodsPerYear }));
    }
    let loIdx = -1;
    let hiIdx = -1;
    for (let i = 0; i < n; i++) {
        if (!isNum(leaveOut[i])) continue;
        if (loIdx === -1 || leaveOut[i] < leaveOut[loIdx]) loIdx = i;
        if (hiIdx === -1 || leaveOut[i] > leaveOut[hiIdx]) hiIdx = i;
    }
    if (loIdx !== -1) {
        block.deleteOneCluster = {
            available: true,
            full,
            min: leaveOut[loIdx],
            max: leaveOut[hiIdx],
            range: leaveOut[hiIdx] - leaveOut[loIdx],
            worstIndex: loIdx,
            bestIndex: hiIdx,
        };
    } else {
        block.deleteOneCluster = na('no finite leave-one-fold-out pooled Sharpe (the pooled returns have no variance to estimate a Sharpe from)');
    }
    const values = nets.map((_, i) => (isNum(full) && isNum(leaveOut[i]) ? full - leaveOut[i] : null));
    const finiteVals = values.filter(isNum);
    if (finiteVals.length) {
        let bi = -1;
        let wi = -1;
        for (let i = 0; i < values.length; i++) {
            if (!isNum(values[i])) continue;
            if (bi === -1 || values[i] > values[bi]) bi = i;
            if (wi === -1 || values[i] < values[wi]) wi = i;
        }
        block.marginal = {
            available: true,
            mean: finiteVals.reduce((a, b) => a + b, 0) / finiteVals.length,
            min: values[wi],
            max: values[bi],
            bestIndex: bi,
            worstIndex: wi,
            values,
        };
    } else {
        block.marginal = na('no finite per-fold marginal contribution (the pooled Sharpe is not finite)');
    }
    return block;
}

// ---------------------------------------------------------------------------
// Question 4b — how perishable is the raw confidence?
// ---------------------------------------------------------------------------
// The alpha-decay ranking input (arXiv 2502.04284): the lag-1 autocorrelation of
// the journaled raw pre-policy confidence, computed WITHIN each fold (a fold
// boundary is not a real time step), and the implied exponential half-life in bars.
// Straight-through confidence (half-life ~0) turns over every bar; a persistent
// confidence holds a position longer.
export function confidencePersistence({ foldInputs } = {}) {
    if (!Array.isArray(foldInputs) || foldInputs.length === 0) return na('no journaled confidence');
    let pairs = 0;
    let bars = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const fi of foldInputs) {
        const c = fi && fi.confidence;
        if (!Array.isArray(c)) continue;
        bars += c.length;
        for (let t = 1; t < c.length; t++) {
            const a = c[t - 1];
            const b = c[t];
            if (!isNum(a) || !isNum(b)) continue;
            pairs += 1;
            sx += a;
            sy += b;
            sxx += a * a;
            syy += b * b;
            sxy += a * b;
        }
    }
    if (pairs < 2) return na('fewer than two adjacent finite confidence pairs');
    const mx = sx / pairs;
    const my = sy / pairs;
    const vx = sxx / pairs - mx * mx;
    const vy = syy / pairs - my * my;
    if (!(vx > 0 && vy > 0)) {
        return { available: true, bars, pairs, lag1: null, halfLife: null, note: 'the journaled confidence is constant (zero variance), so it has no decay rate' };
    }
    const lag1 = (sxy / pairs - mx * my) / Math.sqrt(vx * vy);
    // A lag-1 of exactly 1 is a perfectly persistent (or, with floating error,
    // numerically 1) series — there is no decay rate to report, so guard the
    // 1e-12 neighbourhood rather than emit an astronomically large half-life.
    const halfLife = lag1 > 0 && lag1 < 1 - 1e-12 ? Math.log(0.5) / Math.log(lag1) : null;
    return {
        available: true,
        bars,
        pairs,
        lag1,
        halfLife,
        note: 'lag-1 autocorrelation of the journaled raw pre-policy confidence within folds; halfLife = ln(0.5)/ln(lag1) bars (null when lag1 <= 0 or lag1 within 1e-12 of 1)',
    };
}
