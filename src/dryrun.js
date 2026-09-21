// NeuLegion dry run (`npm run dryrun`) — exercise the REAL pipeline end-to-end
// on a small synthetic stream before a full run (ROADMAP P0-3).
//
// It overrides CONFIG *before* the legion modules are imported (they open their
// SQLite databases at module-eval time), runs the shipped
// `runner → batch → worker → HiveMindController` path for a few batches into a
// temporary state directory, attaches the observer, and asserts a list of
// invariants. Exit code 0 when every invariant holds, 1 otherwise.
//
// Nothing here is on the hot path; it only *drives* it.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'node:url';
import { CONFIG } from './legion/config.js';

// Compact, fast defaults for a dry run. Callers may override before calling.
export const configureDryRun = ({ batches = 2, stateFolder = null, compact = true } = {}) => {
    CONFIG.stateFolder = stateFolder || fs.mkdtempSync(path.join(os.tmpdir(), 'neulegion-dryrun-'));
    CONFIG.httpEnabled = false;
    CONFIG.keepAliveAfterRun = false;
    CONFIG.maxBatches = batches;
    CONFIG.cutoff = null;
    CONFIG.seed = 12345;

    if (compact) {
        CONFIG.baseGroups = 1;
        CONFIG.baseSections = 1;
        CONFIG.baseLayers = 1;
        CONFIG.basePairs = 1;
        CONFIG.elderPairs = 1;
        CONFIG.maxTier = 1;
        CONFIG.basePop = 2;
        CONFIG.baseCache = 20;
        CONFIG.baseProcessCount = 1;
        CONFIG.maxWorkers = 2;
        CONFIG.workerTimeoutMs = 60000;
    }
    return CONFIG.stateFolder;
};

// Largest cache across the structure, matching runner.js's maxCache formula.
const maxCacheForConfig = () => {
    const mg = CONFIG.baseGroups - 1;
    const ms = CONFIG.baseSections - 1;
    const ml = CONFIG.baseLayers - 1;
    const factor = (1 + CONFIG.groupCacheBoost * mg) * (1 + CONFIG.sectionCacheBoost * ms) * (1 + CONFIG.layerCacheBoost * ml);
    return Math.round(CONFIG.baseCache * factor);
};

export const writeSyntheticStream = (file, candleCount, { seed = 7 } = {}) => {
    let a = seed >>> 0;
    const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const lines = [];
    let price = 100;
    const base = Date.parse('2024-01-01T00:00:00Z');
    for (let i = 0; i < candleCount; i++) {
        const open = price;
        price = Math.max(1, price + (rnd() - 0.5) * 2);
        const close = price;
        const high = Math.max(open, close) + rnd();
        const low = Math.min(open, close) - rnd();
        lines.push(JSON.stringify({
            timestamp: new Date(base + i * 3600000).toISOString(),
            open: Number(open.toFixed(4)),
            high: Number(high.toFixed(4)),
            low: Number(low.toFixed(4)),
            close: Number(close.toFixed(4)),
            volume: Math.round(1000 + rnd() * 5000),
        }));
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
};

const finiteSignal = (sig) => sig && ['entryPrice', 'sellPrice', 'stopLoss', 'prob', 'score'].every((k) => Number.isFinite(sig[k]));

export const runDryRun = async ({ batches = 2, keepTmp = false } = {}) => {
    const stateFolder = configureDryRun({ batches });
    const file = path.join(stateFolder, 'dryrun-candles.jsonl');
    const candleCount = maxCacheForConfig() + batches + 2;
    writeSyntheticStream(file, candleCount);

    // Dynamic imports AFTER the CONFIG override: the legion DBs open at
    // module-eval time from CONFIG.stateFolder.
    const { runStream } = await import('./legion/runner.js');
    const { state } = await import('./legion/state.js');
    const { initLegion } = await import('./legion/init.js');
    const { createObserver } = await import('./observer/collector.js');
    const { makeRunId, createRunDirectory, writeReport } = await import('./observer/report.js');

    const runDir = createRunDirectory(CONFIG.stateFolder, makeRunId({ seed: CONFIG.seed }));
    const observer = createObserver({ dir: runDir });
    state.onBatchSnapshot = observer.onSnapshot;

    let summary = null;
    let error = null;
    try {
        summary = await runStream({ file, keepAlive: false });
    } catch (err) {
        error = err;
    }

    const metrics = observer.metrics();
    const report = observer.report({ summary: summary || { stopped: 'error' }, error: error ? error.message : null });
    writeReport(runDir, report);

    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    check('stream completed without throwing', !error, error ? error.message : `stopped=${summary && summary.stopped}`);
    check('ran the requested number of batches', !!summary && summary.completedBatches === batches, `completed=${summary && summary.completedBatches}/${batches}`);
    check('no failed batches', !!summary && summary.failedBatches === 0, `failedBatches=${summary && summary.failedBatches}`);
    check('no controller failures (or within budget)', !!summary && summary.totalControllerFailures === 0, `failures=${summary && summary.totalControllerFailures}`);
    check('no consolidation failures', !!summary && summary.totalConsolidationFailures === 0, `failures=${summary && summary.totalConsolidationFailures}`);
    check('no malformed candle lines', !!summary && summary.malformedCandleLines === 0, `malformed=${summary && summary.malformedCandleLines}`);

    const controllers = state.structureMap ? state.structureMap.flat(3) : [];
    const badSignals = controllers.filter((c) => c.lastSignal && Object.keys(c.lastSignal).length > 0 && !finiteSignal(c.lastSignal));
    check('every produced signal is finite', badSignals.length === 0, `${badSignals.length} non-finite (e.g. ${badSignals[0] && badSignals[0].lastSignal && badSignals[0].lastSignal.controllerId})`);

    check('observer recorded snapshots', observer.snapshots === batches, `snapshots=${observer.snapshots}`);
    check('observer metrics finite', Number.isFinite(metrics.brier) && Number.isFinite(metrics.influenceHhi) && Number.isFinite(metrics.meanScore), JSON.stringify({ brier: metrics.brier, hhi: metrics.influenceHhi }));
    check('report written', fs.existsSync(path.join(runDir, 'report.json')));
    check('snapshot spool written', fs.existsSync(path.join(runDir, 'snapshots.jsonl')));

    // Persistence / resume: re-init on the same dir must return the same counter.
    const resumed = initLegion();
    check('state resumes at the same counter', resumed === summary.candleCounter, `resumed=${resumed} expected=${summary.candleCounter}`);

    const result = {
        runDir: keepTmp ? runDir : null,
        batches,
        candleCount,
        summary,
        metrics,
        alerts: report.alerts,
        checks,
        failed: checks.filter((c) => !c.pass).length,
    };

    if (!keepTmp) {
        try { fs.rmSync(CONFIG.stateFolder, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    return result;
};

export const formatDryRun = (result) => {
    const lines = [];
    lines.push(`dry run: ${result.batches} batch(es), ${result.candleCount} candles`);
    if (result.summary) {
        lines.push(`  stopped=${result.summary.stopped} completed=${result.summary.completedBatches} controllerFailures=${result.summary.totalControllerFailures} lastBatch=${result.summary.lastBatchDurationMs == null ? '-' : result.summary.lastBatchDurationMs.toFixed(1) + 'ms'}`);
    }
    lines.push(`  metrics: brier=${result.metrics.brier.toFixed(4)} hhi=${result.metrics.influenceHhi.toFixed(4)} effectiveVoters=${result.metrics.effectiveVoters.toFixed(2)} meanScore=${result.metrics.meanScore.toFixed(2)}`);
    if (result.alerts && result.alerts.all && result.alerts.all.length) {
        lines.push(`  alerts: ${result.alerts.all.map((a) => `${a.severity}:${a.id}`).join(', ')}`);
    }
    for (const c of result.checks) lines.push(`[${c.pass ? 'PASS' : 'FAIL'}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    return lines.join('\n');
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    const result = await runDryRun({ batches: 2 });
    console.log(formatDryRun(result));
    if (result.failed) {
        console.error(`\ndry run FAILED: ${result.failed} invariant(s) violated.`);
        process.exit(1);
    }
    console.log('\ndry run OK.');
}
