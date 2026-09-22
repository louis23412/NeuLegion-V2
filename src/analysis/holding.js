// Turnover attack as pure post-processing (round 26, R26-5).
//
// The round-25/26 verdict is "the ceiling is economic": the signal family's
// break-even is 0.09-3.47 bps against a real 5-10 bps taker round-trip (Binance
// spot taker 10 bps / USDⓈ-M futures taker 5 bps — `binancefees`; Frazzini et al.
// 2018 for the cost scale). The journaled raw pre-policy confidence (R26-3) makes
// the whole position policy a post-processing experiment: `restateReportAtPolicy`
// re-scores retained fold inputs without a model, so a dead-zone × scale × holding
// grid is O(bars) per policy and cannot move any scored number.
//
// The holding rule is the classical no-trade region a proportional cost makes
// optimal: enter at `|c| ≥ enter`, exit at `|c| ≤ exit` (`exit < enter`), with an
// optional minimum holding period — the reduced form of Constantinides (1986),
// Davis & Norman (1990), Gârleanu & Pedersen (2013), and the alpha-decay result
// that with costs the optimal policy uses *past* signal values (arXiv 2502.04284).
//
// Pure: no I/O, no RNG. The grid is data; `turnoverSweep` only calls the existing
// restatement + promotion functions.

import { restateReportAtPolicy, promoteDecision } from './walkforward.js';

// The default dead-zone grid spans the measured controller-confidence range (the
// round-25 windows sit in ~46-58 -> |c| ≤ 0.16) out to a very wide no-trade band,
// and the holding grid spans no-hold, a narrow band and a wide band, with and
// without a minimum holding period.
export const DEFAULT_TURNOVER_GRID = Object.freeze({
    deadZones: [0, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5],
    scales: [1],
    holdings: [
        null,
        { enter: 0.1, exit: 0.05 },
        { enter: 0.2, exit: 0.05 },
        { enter: 0.3, exit: 0.1 },
        { enter: 0.2, exit: 0.05, minHold: 3 },
        { enter: 0.3, exit: 0.1, minHold: 5 },
    ],
});

const num = (x) => (Number.isFinite(x) ? x : null);

// Sweep the policy grid over one baseline + a candidate set, returning one row per
// (candidate, policy) sorted by break-even cost (descending). The "best" policy is
// the one with the highest break-even cost that still promotes against the
// baseline; `targetMet` says whether any promoting policy clears `targetBps`.
export function turnoverSweep({
    baseline, candidates = [],
    deadZones, scales, holdings,
    costBps = 0, periodsPerYear = 252, trials = null,
    decisionOptions = {}, targetBps = 5,
} = {}) {
    if (!baseline || !Array.isArray(baseline.foldInputs) || !baseline.foldInputs.length) {
        return { available: false, reason: 'the baseline report carries no fold inputs (restatement unavailable)' };
    }
    const dz = Array.isArray(deadZones) ? deadZones : DEFAULT_TURNOVER_GRID.deadZones;
    const sc = Array.isArray(scales) ? scales : DEFAULT_TURNOVER_GRID.scales;
    const ho = Array.isArray(holdings) ? holdings : DEFAULT_TURNOVER_GRID.holdings;
    const policies = [];
    for (const deadZone of dz) {
        for (const scale of sc) {
            for (const holding of ho) policies.push({ ...(holding || {}), deadZone, scale });
        }
    }

    const rows = [];
    for (const policy of policies) {
        const base = restateReportAtPolicy(baseline, policy, { periodsPerYear, trials });
        if (!base) return { available: false, reason: 'baseline restatement unavailable' };
        for (const candidate of candidates) {
            const c = restateReportAtPolicy(candidate, policy, { periodsPerYear, trials });
            if (!c) return { available: false, reason: `candidate ${candidate.id} restatement unavailable` };
            const decision = promoteDecision(base, c, decisionOptions);
            rows.push({
                id: candidate.id,
                policy: base.policy,
                costBps,
                turnover: num(c.pooledMetrics.turnover),
                grossPnl: num(c.pooledMetrics.grossPnl),
                breakEvenCostBps: num(c.pooledMetrics.breakEvenCostBps),
                netSharpe: num(c.pooledMetrics.netSharpe),
                dsr: num(c.pooledMetrics.dsr),
                dsrAdjusted: num(c.pooledMetrics.dsrAdjusted),
                nonZeroFraction: num(c.pooledMetrics.nonZeroFraction),
                promote: decision.promote,
                reasons: decision.reasons,
            });
        }
    }
    rows.sort((a, b) => (b.breakEvenCostBps ?? -Infinity) - (a.breakEvenCostBps ?? -Infinity));

    const byId = {};
    for (const row of rows) {
        if (!byId[row.id]) byId[row.id] = { id: row.id, best: row, bestPromoting: null };
        if (!byId[row.id].bestPromoting && row.promote) byId[row.id].bestPromoting = row;
    }
    const targetMet = rows.some((r) => r.promote && Number.isFinite(r.breakEvenCostBps) && r.breakEvenCostBps >= targetBps);
    return { available: true, policies: policies.length, rows, byId, targetBps, targetMet };
}

// The grid's rank for a fixed candidate: highest break-even first, promoting rows
// preferred. Returns `null` when the candidate has no row.
export function bestTurnoverPolicy(sweep, id) {
    if (!sweep || !sweep.available || !sweep.byId || !sweep.byId[id]) return null;
    return sweep.byId[id].bestPromoting || sweep.byId[id].best || null;
}

// Render a compact block for the human summary (the machine-readable object is in
// `report.json`).
export function formatTurnoverSweep(sweep) {
    if (!sweep) return null;
    if (!sweep.available) return `turnover:  unavailable (${sweep.reason})`;
    const lines = [];
    const f = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
    for (const [id, entry] of Object.entries(sweep.byId)) {
        const b = entry.best;
        const p = b.policy;
        const hold = [p.enter != null ? `enter=${f(p.enter, 2)}` : null, p.exit != null ? `exit=${f(p.exit, 2)}` : null, p.minHold ? `minHold=${p.minHold}` : null].filter(Boolean).join(' ');
        lines.push(`turnover ${id}: best break-even=${f(b.breakEvenCostBps, 2)}bps ` +
            `turnover=${f(b.turnover, 2)} gross=${f(b.grossPnl, 2)} ` +
            `policy{dz=${f(p.deadZone, 2)}${hold ? ` ${hold}` : ''}} promote=${b.promote}`);
    }
    lines.push(`turnover: target ${f(sweep.targetBps, 0)}bps met=${sweep.targetMet} over ${sweep.policies} policies`);
    return lines.join('\n');
}
