// NeuLegion observer component: the stateful snapshot collector (ROADMAP P1-2).
//
// The collector subscribes to the canonical per-batch snapshot
// (`state.onBatchSnapshot`, produced by legion/broadcast.js) and maintains the
// rolling windows the pure metrics/alerts modules need. It is READ-ONLY with
// respect to the run: it never touches controllers, the DB, or the stream.
//
// Wiring is deliberately outside the hot path — `runner.runStream` only calls
// `state.onBatchSnapshot` if something registered one, and that never happens
// unless the CLI/analyze/dryrun attaches a collector.

import {
    mean,
    brierDecomposition,
    influenceSummary,
    consensusProbability,
    ewmaSeries,
    cusum,
    shannonEntropy,
    stdev,
} from './legion_metrics.js';
import { evaluateAlerts, highestSeverity, DEFAULT_ALERT_RULES } from './alerts.js';
import { appendSnapshot, appendLog } from './report.js';
import { state as legionState } from '../legion/state.js';

const votersOf = (controllers) => [
    ...(controllers?.positive?.voters ?? []),
    ...(controllers?.negative?.voters ?? []),
];

export const createObserver = ({
    dir = null,
    maxPairs = 4000,
    maxHistory = 600,
    rules = DEFAULT_ALERT_RULES,
    startedAt = Date.now(),
} = {}) => {
    const history = {
        pairs: [],          // { prob, outcome }
        meanScore: [],
        influenceHhi: [],
        vaultSize: [],
        memberProbStd: [],
        memberProbEntropy: [],
        workerErrorRate: [],
    };

    let snapshots = 0;
    let prevProb = null;
    let prevVault = null;
    let firing = new Set();
    let alerts = [];

    const push = (arr, v) => {
        arr.push(v);
        if (arr.length > maxHistory) arr.shift();
    };

    const metrics = () => {
        const outcomes = history.pairs.map((p) => p.outcome);
        const probs = history.pairs.map((p) => p.prob);
        const decomp = brierDecomposition(outcomes, probs, 10);
        const inf = history.influenceHhi.length
            ? {
                hhi: history.influenceHhi.at(-1),
            }
            : { hhi: 0 };
        const vaultFirst = history.vaultSize[0] ?? 0;
        const vaultLast = history.vaultSize.at(-1) ?? 0;
        const batches = history.vaultSize.length;
        const lastStd = history.memberProbStd.at(-1) ?? 0;
        const lastEntropy = history.memberProbEntropy.at(-1) ?? 0;
        const lastScore = history.meanScore.at(-1) ?? 0;
        const scoreCusum = cusum(history.meanScore, { target: mean(history.meanScore), k: 0.5, h: 5, sigma: stdev(history.meanScore) || 1 });

        return {
            snapshots,
            pairs: history.pairs.length,
            brier: decomp.brier,
            reliability: decomp.reliability,
            resolution: decomp.resolution,
            uncertainty: decomp.uncertainty,
            within: decomp.within,
            baseRate: decomp.baseRate,
            hitRate: outcomes.length ? mean(outcomes) : 0,
            probabilityMean: probs.length ? mean(probs) : 0,
            influenceHhi: inf.hhi,
            effectiveVoters: inf.hhi > 0 ? 1 / inf.hhi : 0,
            memberProbStd: lastStd,
            memberProbEntropy: lastEntropy,
            meanScore: lastScore,
            scoreDrift: scoreCusum.lastPositive - scoreCusum.lastNegative,
            scoreDriftDirection: scoreCusum.direction,
            workerErrorRate: history.workerErrorRate.at(-1) ?? 0,
            quarantinedRows: 0,
            vaultSize: vaultLast,
            vaultGrowthPerBatch: batches > 1 ? (vaultLast - vaultFirst) / (batches - 1) : 0,
            batches,
        };
    };

    const onSnapshot = (snapshot) => {
        snapshots++;

        // Realized outcome (next-bar direction) from the snapshot's candles.
        let outcome = null;
        const candles = snapshot?.lastCandles;
        if (Array.isArray(candles) && candles.length >= 2) {
            const c1 = Number(candles[candles.length - 1].close);
            const c0 = Number(candles[candles.length - 2].close);
            if (Number.isFinite(c1) && Number.isFinite(c0)) outcome = c1 >= c0 ? 1 : 0;
        }

        // Calibration pair: the PREVIOUS batch's consensus probability against
        // the direction that has now been realized.
        if (prevProb != null && outcome != null) {
            history.pairs.push({ prob: prevProb, outcome });
            if (history.pairs.length > maxPairs) history.pairs.shift();
        }
        prevProb = consensusProbability(snapshot?.consensus);

        const voters = votersOf(snapshot?.controllers);

        const scores = voters.map((v) => Number(v?.stats?.accuracyScore)).filter(Number.isFinite);
        push(history.meanScore, scores.length ? mean(scores) : 0);

        const inf = influenceSummary(snapshot?.controllers);
        push(history.influenceHhi, inf.hhi);

        const probs = voters
            .map((v) => Number(v?.stats?.probability))
            .filter((p) => Number.isFinite(p) && p >= 0);
        push(history.memberProbStd, probs.length ? stdev(probs) : 0);
        push(history.memberProbEntropy, probs.length ? shannonEntropy(probs) : 0);

        const vault = voters.reduce((a, v) => a + (Number.isFinite(v?.memory?.controllerMemories) ? v.memory.controllerMemories : 0), 0);
        push(history.vaultSize, vault);
        prevVault = vault;

        const failed = Number(snapshot?.overview?.controllerFailures) || 0;
        push(history.workerErrorRate, failed / Math.max(1, voters.length));

        // Alerts (pure; hysteresis via the previous firing set).
        const m = metrics();
        m.quarantinedRows = Number(snapshot?.overview?.quarantinedRows) || 0;
        const prevFiring = firing;
        const result = evaluateAlerts(m, rules, prevFiring);
        firing = result.firingIds;
        alerts = result.firing;

        // Surface the alerts to whatever builds the next snapshot (the
        // dashboard reads them one batch behind — the observer runs after the
        // snapshot for the current batch is built).
        legionState.alerts = result.firing;

        if (dir) {
            appendSnapshot(dir, snapshot);
            for (const id of result.resolved) appendLog(dir, 'info', `alert resolved: ${id}`);
            for (const a of result.firing) {
                if (!prevFiring.has(a.id)) appendLog(dir, a.severity, a.message, { id: a.id, value: a.value });
            }
        }
    };

    const report = ({ summary = null, finishedAt = Date.now() } = {}) => {
        const m = metrics();
        const scoreSeries = ewmaSeries(history.meanScore, 0.9);
        return {
            version: 1,
            startedAt,
            finishedAt,
            durationMs: finishedAt - startedAt,
            summary,
            metrics: m,
            alerts: {
                firing,
                highest: highestSeverity(alerts),
                all: alerts,
            },
            series: {
                meanScore: history.meanScore,
                meanScoreEwma: scoreSeries,
                influenceHhi: history.influenceHhi,
                memberProbStd: history.memberProbStd,
                vaultSize: history.vaultSize,
            },
        };
    };

    return {
        onSnapshot,
        metrics,
        report,
        get snapshots() { return snapshots; },
        get history() { return history; },
    };
};
