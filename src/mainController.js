// NeuLegion entry point (`npm run train` -> `node ./src/mainController.js`).
//
// This used to be a ~2.5k-line monolith. It is now just the runnable shell: the
// legion orchestration lives in ./legion/*, split by concern (config, state,
// database, statements, signals, accuracy, broadcast, structure, persistence,
// init, batch, workers, net, runner).
//
// Run integrity (ROADMAP P0-1/P0-2): this shell also
//   * creates a per-run directory (`state/runs/<id>/`) with a run manifest,
//     a snapshot spool and a report (see observer/report.js);
//   * attaches the read-only observer so the run's internal health is measured;
//   * checkpoints and writes the report on SIGINT/SIGTERM, so Ctrl-C does not
//     lose the last batch.
//
// Importing ./legion/runner.js transitively builds the databases, prepares the
// statements and defines every function before the stream starts.

import path from 'path';
import { runStream } from './legion/runner.js';
import { state } from './legion/state.js';
import { CONFIG } from './legion/config.js';
import { saveLegionState } from './legion/persistence.js';
import { createObserver } from './observer/collector.js';
import {
    makeRunId, createRunDirectory, pruneRunDirectories, writeJson, writeReport, appendLog,
} from './observer/report.js';
import { configFingerprint } from './legion/sanitize.js';

const startedAt = Date.now();
const runId = makeRunId({ seed: CONFIG.seed, startedAt });
const reportPath = () => (runDir ? path.join(runDir, 'report.json') : null);

let runDir = null;
let observer = null;

try {
    runDir = createRunDirectory(CONFIG.stateFolder, runId);
    pruneRunDirectories(CONFIG.stateFolder, CONFIG.maxRunDirectories);
    writeJson(runDir, 'run.json', {
        runId,
        startedAt,
        seed: CONFIG.seed,
        configFingerprint: configFingerprint(CONFIG),
        file: CONFIG.file,
        stateFolder: CONFIG.stateFolder,
        node: process.version,
        platform: process.platform,
    });
    observer = createObserver({ dir: runDir, startedAt });
    state.onBatchSnapshot = observer.onSnapshot;
    appendLog(runDir, 'info', `run ${runId} started`, { file: CONFIG.file, seed: CONFIG.seed });
} catch (err) {
    console.error('[run] could not create the run directory:', err && err.message ? err.message : err);
}

const buildReport = (summary) => {
    if (!observer) return null;
    try {
        return observer.report({ summary, finishedAt: Date.now() });
    } catch (err) {
        console.error('[run] could not build the report:', err && err.message ? err.message : err);
        return null;
    }
};

const checkpoint = (reason) => {
    try {
        if (state.structureMap) saveLegionState();
    } catch (err) {
        console.error(`[run] checkpoint (${reason}) failed:`, err && err.message ? err.message : err);
    }
};

const shutdown = async (signal) => {
    console.log(`\n[run] received ${signal}; checkpointing and writing the report...`);
    checkpoint(signal);
    const report = buildReport({ stopped: `signal:${signal}` });
    if (report && runDir) writeReport(runDir, report);
    if (runDir) appendLog(runDir, 'warning', `shutdown (${signal})`);
    try { await state.httpWorker?.terminate(); } catch { /* already gone */ }
    process.exit(0);
};

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });

try {
    const summary = await runStream({ keepAlive: false, reportPath: reportPath() });
    if (runDir) appendLog(runDir, 'info', 'stream stopped', summary);
    const report = buildReport(summary);
    if (report && runDir) writeReport(runDir, report);

    if (CONFIG.keepAliveAfterRun) {
        // Historical behaviour: the dashboard keeps the process alive after the
        // stream ends so the final state can be inspected.
        await new Promise(() => {});
    }
} catch (err) {
    console.error('Unexpected error during processing:', err);
    if (runDir) {
        try { appendLog(runDir, 'error', err && err.message ? err.message : String(err)); } catch { /* noop */ }
    }
    checkpoint('error');
    const report = buildReport({ stopped: 'error', error: err && err.message ? err.message : String(err) });
    if (report && runDir) writeReport(runDir, report);
    process.exitCode = 1;
}
