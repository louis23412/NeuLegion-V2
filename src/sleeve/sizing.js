// Sleeve sizing composition (round-81 split): trailing vol, adaptive /
// drawdown targets, sized re-score through the vol-target risk plugin. Pure.
import './registry.js';
import { scoreSleeve } from './scoring.js';
import { volTargetRisk } from '../plugins/risk/vol-target.js';
import { scoreBookReturns, stressHalves, worstBlock } from '../analysis/portfolio.js';
import { factorNeutralSharpe } from '../analysis/dependence.js';

// The `--sleeve-sizing` composition (round 69): the scored sleeve book, sized
// through the vol-target risk plugin behind the driver seam.
//
// Sizing is a risk result (F-16/F-106/F-112/F-115): the vol forecast is a
// causal trailing RMS of the sleeve's own gross book (strictly-before-t, the
// e105 convention, default window 24 eight-hour bars); the TARGET is
// caller-supplied (a measurement the operator chooses per run, never banked —
// the plugin takes it as input for the same reason). Skipped bars (no history
// yet, dead vol) run flat — scale 0 on both the return and the weight row —
// so the re-score's turnover prices the exposure actually traded and
// `scoreBookReturns` keeps the gate's own arithmetic untouched. Open-loop
// vol-targeting is documented to spike turnover/leverage under estimation
// error (Devanathan et al. 2026, `voltarget2603`); the registered per-sleeve
// cap (4x) is the guard, and a feedback-control sizing rule is the recorded
// follow-up, not this round.
export const SIZED_SLEEVE_DEFAULTS = Object.freeze({ window: 24, ddCap: 0.05 });

export function trailingBookVol(gross, { window = SIZED_SLEEVE_DEFAULTS.window } = {}) {
    if (!Array.isArray(gross)) return null;
    const w = Number(window);
    if (!Number.isInteger(w) || !(w > 0)) throw new Error('trailingBookVol: window must be a positive integer');
    const out = new Array(gross.length);
    for (let t = 0; t < gross.length; t++) {
        let sumSq = 0;
        let n = 0;
        for (let k = Math.max(0, t - w); k < t; k++) {
            const r = gross[k];
            if (!Number.isFinite(r)) continue;
            sumSq += r * r;
            n++;
        }
        out[t] = n ? Math.sqrt(sumSq / n) : NaN;
    }
    return out;
}

// The pure `--sleeve-sizing` option parser (pinned by §P, called by the CLI):
// absent means the default unsized report (byte-identical path); present is a
// positive per-bar vol target, the string `adaptive` (any case) for the
// trailing-mean target (the F-115/F-117 convention: the target re-estimated
// causally at ≈ book vol, mean scale ≈ 1 — a scalar far above book vol just
// levers to the cap, F-116), or the string `drawdown` (any case) for the
// adaptive target closed through the drawdown governor below (F-118). The
// window defaults to 24.

export function parseSleeveSizing({ sizing, window } = {}) {
    if (sizing == null) return { sized: false, target: null, window: SIZED_SLEEVE_DEFAULTS.window };
    const w = window == null ? SIZED_SLEEVE_DEFAULTS.window : Number(window);
    if (!Number.isInteger(w) || !(w > 0)) {
        throw new Error(`analyze: --sleeve-sizing-window must be a positive integer (got "${String(window)}")`);
    }
    if (typeof sizing === 'string') {
        const mode = sizing.trim().toLowerCase();
        if (mode === 'adaptive' || mode === 'drawdown') return { sized: true, target: mode, window: w };
    }
    const target = Number(sizing);
    if (!Number.isFinite(target) || !(target > 0)) {
        throw new Error(`analyze: --sleeve-sizing needs a positive per-bar vol target, "adaptive" or "drawdown" (got "${String(sizing)}" — BUGS.md #69)`);
    }
    return { sized: true, target, window: w };
}

// The adaptive target series (round 70): the expanding causal mean of the
// vol forecast — targets[t] reads only vols[0..t], each of which reads only
// returns strictly before its bar, so the whole chain is causal. A bar with
// no finite-positive vol history yet carries NaN, which the plugin skips
// (never an infinite scale). This is the e105 convention with the lab's
// WARMUP span choice removed: the mean runs over every scored bar, not over
// bars past an arbitrary cutoff.

export function adaptiveTargets(vols) {
    if (!Array.isArray(vols)) return null;
    const out = new Array(vols.length);
    let sum = 0;
    let n = 0;
    for (let t = 0; t < vols.length; t++) {
        const v = vols[t];
        if (Number.isFinite(v) && v > 0) { sum += v; n++; }
        out[t] = n ? sum / n : NaN;
    }
    return out;
}

// The drawdown governor (round 73, F-118): the feedback-control follow-up the
// open-loop vol-targeting literature records (`voltarget2603`) — CLOSE the
// loop on the base book's own trailing drawdown instead of scaling blindly.
// `governor[t]` multiplies the adaptive target: 1 at (or above) the trailing
// peak, ramping linearly to 0 at a DDCAP drawdown, so a sagging book is
// progressively de-sized before the cap binds. Causal by construction (bar t
// reads only the equity compounded from bars strictly before t; pinned by a
// prefix-identity check). The 5% cap is pre-registered from the lab (the
// adaptive book's own DD is ~3%, the unsized ~8% — e108): the crash-brake
// frame is the cash-overlay V-shape brake (`cashoverlay2606`), and the
// restart variant stays lab-side until it is cost-accounted (`ddrestart2303`).

export function drawdownGovernor(returns, { cap = SIZED_SLEEVE_DEFAULTS.ddCap } = {}) {
    if (!Array.isArray(returns)) return null;
    const c = Number(cap);
    if (!Number.isFinite(c) || !(c > 0)) throw new Error('drawdownGovernor: cap must be a positive fraction');
    const out = new Array(returns.length);
    let eq = 1;
    let peak = 1;
    for (let t = 0; t < returns.length; t++) {
        const dd = peak > 0 ? (peak - eq) / peak : 0;
        out[t] = Math.min(1, Math.max(0, 1 - dd / c));
        const r = returns[t];
        if (Number.isFinite(r)) eq = eq * (1 + r);
        if (eq > peak) peak = eq;
    }
    return out;
}


export function scoreSleeveSized(sleeveId, view, { costBps = 0, target, window = SIZED_SLEEVE_DEFAULTS.window, panel = null } = {}) {
    const adaptive = target === 'adaptive';
    const drawdown = target === 'drawdown';
    const t = (adaptive || drawdown) ? NaN : Number(target);
    if (!adaptive && !drawdown && (!Number.isFinite(t) || !(t > 0))) {
        return { sleeveId, available: false, reason: 'sizing needs a positive per-bar vol target, "adaptive" or "drawdown"', costBps };
    }
    const base = scoreSleeve(sleeveId, view, { costBps });
    if (!base.available) return { ...base, sizing: null };
    const vols = trailingBookVol(base.gross, { window });
    const adapt = adaptiveTargets(vols);
    const gov = drawdown ? drawdownGovernor(base.gross) : null;
    const targets = adaptive ? adapt : drawdown ? adapt.map((a, i) => a * gov[i]) : t;
    const sized = volTargetRisk.sizingForSleeve(base.gross, vols, sleeveId, targets);
    if (!sized.available) return { sleeveId, available: false, reason: sized.reason, costBps };
    const byIndex = new Map(sized.index.map((bar, i) => [bar, sized.scales[i]]));
    const scales = base.gross.map((_, bar) => (byIndex.has(bar) ? byIndex.get(bar) : 0));
    const scaledGross = base.gross.map((r, bar) => scales[bar] * r);
    const scaledWeights = base.weightRows.map((row, bar) => row.map((w) => scales[bar] * w));
    const rescored = scoreBookReturns(scaledGross, scaledWeights, { costBps });
    if (!rescored) {
        return { sleeveId, available: false, reason: 'the sized sleeve book did not score', costBps };
    }
    const fn = Array.isArray(panel) && panel.length
        ? factorNeutralSharpe(rescored.net, panel)
        : { raw: rescored.netSharpe, neutral: NaN, residual: null };
    let bookVolSum = 0;
    for (const bar of sized.index) bookVolSum += vols[bar];
    return {
        sleeveId, available: true, costBps, target: adaptive ? 'adaptive' : drawdown ? 'drawdown' : t, window,
        baseNetSharpe: base.netSharpe, baseTurnover: base.turnover,
        baseBreakEvenCostBps: base.breakEvenCostBps,
        skipped: sized.skipped, scoredBars: sized.scored,
        bookVolMean: bookVolSum / sized.scored,
        gross: rescored.gross, net: rescored.net,
        grossSharpe: rescored.grossSharpe, netSharpe: rescored.netSharpe,
        turnover: rescored.turnover, turnoverPerYear: rescored.turnoverPerYear,
        breakEvenCostBps: rescored.breakEvenCostBps,
        rawSharpe: fn.raw, neutralSharpe: fn.neutral,
        panelStreams: Array.isArray(panel) ? panel.length : 0,
        stress: stressHalves(rescored.net), worstBlock: worstBlock(rescored.net),
    };
}

