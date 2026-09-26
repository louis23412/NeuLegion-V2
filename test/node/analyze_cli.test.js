// Node-only suite: the `analyze` CLI surface, which the browser harness cannot
// exercise (the browser entry imports `runAnalysis` directly, so the `isMain`
// argument-parsing block and the process exit path are never run).
//
// R26-5 landed two new flags (`--turnover-sweep`, `--turnover-target`). A typo in
// the flag name, a missing usage line, or a flag that is parsed but not threaded
// into `runAnalysis` would all pass the browser suite and only surface when a user
// runs `npm run analyze`. This suite spawns the real CLI: once for `--help`, and
// once for a tiny real run that must persist the turnover block to
// `run.json`/`report.json` and render it in the summary.
//
// Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const analyzePath = path.join(projectRoot, 'src', 'analyze.js');

function writeCandles(file, n) {
    const rows = [];
    let close = 100;
    const base = Date.parse('2024-01-01T00:00:00Z');
    for (let i = 0; i < n; i++) {
        const open = close;
        close = Math.max(1, close * (1 + Math.sin(i * 0.3) * 0.012 + 0.0005));
        rows.push(JSON.stringify({
            timestamp: new Date(base + i * 3600000).toISOString(),
            open,
            high: Math.max(open, close) + 0.2,
            low: Math.min(open, close) - 0.2,
            close,
            volume: 100 + (i % 7),
        }));
    }
    fs.writeFileSync(file, rows.join('\n'));
}

test('the analyze CLI documents the R26-5 turnover flags and wires them into the run', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neulegion-analyze-cli-'));
    try {
        // (1) `--help` must advertise both new flags — a flag no one can discover
        //     is a flag that does not exist as far as the user is concerned.
        const help = spawnSync(process.execPath, [analyzePath, '--help'], { cwd: projectRoot, encoding: 'utf8' });
        assert.equal(help.status, 0, `--help exited ${help.status}: ${help.stderr}`);
        assert.match(help.stdout, /--turnover-sweep/, '--help does not document --turnover-sweep');
        assert.match(help.stdout, /--turnover-target=<bps>/, '--help does not document --turnover-target');

        // (2) A tiny real run through the CLI must thread the flags into the report.
        //     The roster is narrowed to a pure signal candidate so the cost is one
        //     baseline controller fit per fold (a few seconds).
        const file = path.join(root, 'candles.jsonl');
        writeCandles(file, 100);
        const stateDir = path.join(root, 'state');
        const res = spawnSync(process.execPath, [
            analyzePath,
            `--file=${file}`,
            '--bars=100', '--train=20', '--test=5', '--interval=2',
            '--model=controller', '--variants=sig-momentum',
            '--audit=0', '--progress-ms=-1',
            '--turnover-sweep', '--turnover-target=7', '--select-streams',
        ], {
            cwd: projectRoot,
            encoding: 'utf8',
            env: { ...process.env, NEULEGION_STATE: stateDir },
        });
        assert.equal(res.status, 0, `the CLI run exited ${res.status}:\n${res.stderr}`);
        assert.match(res.stdout, /turnover /, 'the CLI summary does not render the turnover block');
        assert.match(res.stdout, /target 7bps/, 'the CLI summary does not state the requested turnover target');
        assert.match(res.stdout, /intervalBars=2/, 'the CLI summary does not state the resampling factor');

        const runsDir = path.join(stateDir, 'runs');
        const runDirs = fs.readdirSync(runsDir);
        assert.equal(runDirs.length, 1, `expected exactly one run directory, got ${runDirs.length}`);
        const runDir = path.join(runsDir, runDirs[0]);
        const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
        const report = JSON.parse(fs.readFileSync(path.join(runDir, 'report.json'), 'utf8'));

        assert.equal(run.turnoverSweep, true, 'run.json does not record the turnover attack as on');
        assert.equal(run.turnoverTarget, 7, 'run.json does not record the turnover target');
        assert.ok(report.turnoverSweep && report.turnoverSweep.available === true,
            `report.json carries no available turnover block: ${JSON.stringify(report.turnoverSweep)}`);
        assert.equal(report.turnoverTargetBps, 7);
        assert.equal(report.turnoverSweep.targetBps, 7);
        assert.equal(report.turnoverSweep.rows.length, 48, 'the default grid is 8 dead zones x 1 scale x 6 holdings');
        assert.ok(report.turnoverSweep.rows.every((r) => r.id === 'sig-momentum'));
        assert.equal(typeof report.turnoverSweep.targetMet, 'boolean');

        // R26-6: `--interval=2` resampled the 100 raw bars to 50, and
        // `--select-streams` measured the (single-stream) basket.
        assert.equal(run.intervalBars, 2, 'run.json does not record the demotion factor');
        assert.equal(report.intervalBars, 2);
        assert.equal(report.candles, 50, `expected 50 resampled bars, got ${report.candles}`);
        assert.equal(run.streamSelect, true, 'run.json does not record the stream selection');
        assert.ok(report.streamSelection && report.streamSelection.available === true,
            `report.json carries no stream-selection block: ${JSON.stringify(report.streamSelection)}`);
        assert.equal(report.streamSelection.order.length, 1);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the analyze CLI documents the R26-13 CRN/replication flags and writes the seed aggregate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neulegion-analyze-seeds-'));
    try {
        // (1) `--help` must advertise the R26-13 surface.
        const help = spawnSync(process.execPath, [analyzePath, '--help'], { cwd: projectRoot, encoding: 'utf8' });
        assert.equal(help.status, 0, `--help exited ${help.status}: ${help.stderr}`);
        assert.match(help.stdout, /--seeds=a,b,c/, '--help does not document --seeds');
        assert.match(help.stdout, /--crn=0/, '--help does not document --crn');
        assert.match(help.stdout, /--forecast=0/, '--help does not document --forecast');

        // (2) `--seeds=1,2` replicates with CRN and aggregates each variant's seed
        //     distribution into `replication.json` beside the first run dir.
        const file = path.join(root, 'candles.jsonl');
        writeCandles(file, 100);
        const stateDir = path.join(root, 'state');
        const res = spawnSync(process.execPath, [
            analyzePath,
            `--file=${file}`,
            '--bars=100', '--train=20', '--test=5',
            '--model=controller', '--variants=sig-momentum',
            '--audit=0', '--progress-ms=-1',
            '--seeds=1,2',
        ], {
            cwd: projectRoot,
            encoding: 'utf8',
            env: { ...process.env, NEULEGION_STATE: stateDir },
        });
        assert.equal(res.status, 0, `the CLI run exited ${res.status}:\n${res.stderr}`);
        assert.match(res.stdout, /replicated 2 seeds \(1,2\)/, 'the CLI does not report the replication');
        assert.match(res.stdout, /seeds baseline:/, 'the CLI does not render the per-variant seed distribution');
        assert.match(res.stdout, /IQM=/, 'the seed summary does not report the IQM');
        assert.match(res.stdout, /crn=true/, 'the run summary does not record CRN on');

        const runsDir = path.join(stateDir, 'runs');
        const runDirs = fs.readdirSync(runsDir);
        assert.equal(runDirs.length, 1, `expected exactly one run directory (only the first seed writes), got ${runDirs.length}`);
        const runDir = path.join(runsDir, runDirs[0]);
        const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
        const report = JSON.parse(fs.readFileSync(path.join(runDir, 'report.json'), 'utf8'));
        assert.equal(run.commonRandomNumbers, true, 'run.json does not record CRN');
        assert.equal(report.commonRandomNumbers, true, 'report.json does not record CRN');
        assert.ok(Array.isArray(report.baseline.foldSharpes) && report.baseline.foldSharpes.length === report.folds,
            'the baseline row does not carry the per-fold net-Sharpe series');
        assert.ok(report.candidates.every((c) => Array.isArray(c.foldSharpes) && c.foldSharpes.length === report.folds),
            'a candidate row does not carry the per-fold net-Sharpe series');

        const replication = JSON.parse(fs.readFileSync(path.join(runDir, 'replication.json'), 'utf8'));
        assert.deepEqual(replication.seeds, [1, 2], 'replication.json does not record the seed list');
        assert.equal(replication.commonRandomNumbers, true, 'replication.json does not record CRN');
        assert.ok(replication.byVariant.baseline && replication.byVariant.baseline.available === true,
            'replication.json has no baseline distribution');
        assert.deepEqual(replication.byVariant.baseline.seeds, [1, 2]);
        assert.ok(replication.byVariant.baseline.ci.available === true, 'the baseline distribution has no bootstrap CI');
        assert.ok(replication.byVariant.baseline.components.available === true, 'the baseline distribution has no variance split');
        assert.ok(replication.byVariant['sig-momentum'], 'replication.json has no candidate distribution');

        // (3) `--crn=0` (without --seeds) restores the historical per-variant seed
        //     and records it honestly.
        const offDir = path.join(root, 'state-off');
        const off = spawnSync(process.execPath, [
            analyzePath,
            `--file=${file}`,
            '--bars=100', '--train=20', '--test=5',
            '--model=controller', '--variants=sig-momentum',
            '--audit=0', '--progress-ms=-1',
            '--crn=0',
        ], {
            cwd: projectRoot,
            encoding: 'utf8',
            env: { ...process.env, NEULEGION_STATE: offDir },
        });
        assert.equal(off.status, 0, `the CRN-off run exited ${off.status}:\n${off.stderr}`);
        assert.match(off.stdout, /crn=false/, 'the CRN-off summary does not record crn=false');
        const offRuns = fs.readdirSync(path.join(offDir, 'runs'));
        const offReport = JSON.parse(fs.readFileSync(path.join(offDir, 'runs', offRuns[0], 'report.json'), 'utf8'));
        assert.equal(offReport.commonRandomNumbers, false, 'report.json does not record CRN off');

        // (4) `--forecast=0` (R26-14) nulls the forecast block and drops its summary
        //     line, changing no scored number.
        const fcDir = path.join(root, 'state-fc');
        const fcOff = spawnSync(process.execPath, [
            analyzePath,
            `--file=${file}`,
            '--bars=100', '--train=20', '--test=5',
            '--model=controller', '--variants=sig-momentum',
            '--audit=0', '--progress-ms=-1',
            '--forecast=0',
        ], {
            cwd: projectRoot,
            encoding: 'utf8',
            env: { ...process.env, NEULEGION_STATE: fcDir },
        });
        assert.equal(fcOff.status, 0, `the --forecast=0 run exited ${fcOff.status}:\n${fcOff.stderr}`);
        assert.doesNotMatch(fcOff.stdout, /mcs90=/, '--forecast=0 still rendered the forecast line');
        const fcRuns = fs.readdirSync(path.join(fcDir, 'runs'));
        const fcRunDir = path.join(fcDir, 'runs', fcRuns[0]);
        const fcRun = JSON.parse(fs.readFileSync(path.join(fcRunDir, 'run.json'), 'utf8'));
        const fcReport = JSON.parse(fs.readFileSync(path.join(fcRunDir, 'report.json'), 'utf8'));
        assert.equal(fcRun.forecast, false, 'run.json does not record forecast off');
        assert.equal(fcReport.forecast, null, 'report.json still carries a forecast block under --forecast=0');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the analyze CLI documents and threads the R26-8 decision-grade report flag', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neulegion-analyze-decision-'));
    try {
        // (1) `--help` must advertise the R26-8 flag.
        const help = spawnSync(process.execPath, [analyzePath, '--help'], { cwd: projectRoot, encoding: 'utf8' });
        assert.equal(help.status, 0, `--help exited ${help.status}: ${help.stderr}`);
        assert.match(help.stdout, /--decision=0/, '--help does not document --decision');

        const file = path.join(root, 'candles.jsonl');
        writeCandles(file, 100);
        const runArgs = [
            `--file=${file}`,
            '--bars=100', '--train=20', '--test=5',
            '--model=controller', '--variants=sig-momentum',
            '--audit=0', '--progress-ms=-1',
        ];

        // (2) By default the decision block is present, has the six questions and
        //     the summary renders the decision/concentration/nextRun lines.
        const onDir = path.join(root, 'state-on');
        const on = spawnSync(process.execPath, [analyzePath, ...runArgs], {
            cwd: projectRoot,
            encoding: 'utf8',
            env: { ...process.env, NEULEGION_STATE: onDir },
        });
        assert.equal(on.status, 0, `the default run exited ${on.status}:\n${on.stderr}`);
        assert.match(on.stdout, /decision: /, 'the summary does not render the decision verdict');
        assert.match(on.stdout, /concentration: /, 'the summary does not render the concentration readout');
        assert.match(on.stdout, /nextRun: /, 'the summary does not render the next-run knobs');
        const onRuns = fs.readdirSync(path.join(onDir, 'runs'));
        const onRunDir = path.join(onDir, 'runs', onRuns[0]);
        const onRun = JSON.parse(fs.readFileSync(path.join(onRunDir, 'run.json'), 'utf8'));
        const onReport = JSON.parse(fs.readFileSync(path.join(onRunDir, 'report.json'), 'utf8'));
        assert.equal(onRun.decision, true, 'run.json does not record the decision block as on');
        assert.equal(onReport.decisionEnabled, true, 'report.json does not record the decision block as on');
        assert.ok(onReport.decision && onReport.decision.schema === 'nl.decision.v1',
            'report.json carries no decision block');
        assert.ok(onReport.decision.training && onReport.decision.edge && onReport.decision.concentration &&
            onReport.decision.economics && onReport.decision.family && onReport.decision.nextRun,
            'the decision block is missing one of the six questions');
        assert.ok(onReport.candidates.some((c) => c.id === onReport.decision.verdict.candidateId),
            'the decision block names a featured candidate that is not in the roster');
        assert.ok(onReport.decision.concentration.available === true,
            'the concentration readout is unexpectedly unavailable for a real run');

        // (3) `--decision=0` nulls the block, drops the summary lines and moves no
        //     scored number.
        const offDir = path.join(root, 'state-off');
        const off = spawnSync(process.execPath, [analyzePath, ...runArgs, '--decision=0'], {
            cwd: projectRoot,
            encoding: 'utf8',
            env: { ...process.env, NEULEGION_STATE: offDir },
        });
        assert.equal(off.status, 0, `the --decision=0 run exited ${off.status}:\n${off.stderr}`);
        assert.doesNotMatch(off.stdout, /nextRun: /, '--decision=0 still rendered the next-run line');
        const offRuns = fs.readdirSync(path.join(offDir, 'runs'));
        const offRunDir = path.join(offDir, 'runs', offRuns[0]);
        const offRun = JSON.parse(fs.readFileSync(path.join(offRunDir, 'run.json'), 'utf8'));
        const offReport = JSON.parse(fs.readFileSync(path.join(offRunDir, 'report.json'), 'utf8'));
        assert.equal(offRun.decision, false, 'run.json does not record the decision block as off');
        assert.equal(offReport.decisionEnabled, false, 'report.json does not record the decision block as off');
        assert.equal(offReport.decision, null, 'report.json still carries a decision block under --decision=0');
        const scored = (r) => JSON.stringify(r.candidates.map((c) => [c.id, c.promote, c.pooledMetrics.netSharpe]));
        assert.equal(scored(offReport), scored(onReport), '--decision=0 changed a scored number');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the analyze CLI documents and threads the R27-9 flag surface', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neulegion-analyze-r27-'));
    try {
        // (1) `--help` advertises the round-27 surface.
        const help = spawnSync(process.execPath, [analyzePath, '--help'], { cwd: projectRoot, encoding: 'utf8' });
        assert.equal(help.status, 0, `--help exited ${help.status}: ${help.stderr}`);
        assert.match(help.stdout, /--list-variants/, '--help does not document --list-variants');
        assert.match(help.stdout, /--reachable=0/, '--help does not document --reachable=0');
        assert.match(help.stdout, /--min-training-steps=<n>/, '--help does not document --min-training-steps');
        assert.match(help.stdout, /--audit-probes=<n>/, '--help does not document --audit-probes');

        // (2) `--list-variants` prints the resolvable taxonomy (id/kind/applies-to/
        //     default?/applicable-here) and exits WITHOUT starting a run. The
        //     taxonomy is the only place an operator can see why a variant is
        //     `not-applicable` on the controller (R27-2).
        const listState = path.join(root, 'state-list');
        const lv = spawnSync(process.execPath, [analyzePath, '--list-variants'], {
            cwd: projectRoot,
            encoding: 'utf8',
            env: { ...process.env, NEULEGION_STATE: listState },
        });
        assert.equal(lv.status, 0, `--list-variants exited ${lv.status}:\n${lv.stderr}`);
        assert.match(lv.stdout, /applies-to/, '--list-variants does not print the taxonomy header');
        assert.match(lv.stdout, /not-applicable:/, '--list-variants does not explain the not-applicable variants');
        for (const id of ['multiprobe', 'querymod', 'sample-weights', 'pca-hash', 'sig-momentum']) {
            assert.ok(lv.stdout.includes(id), `--list-variants does not list ${id}`);
        }
        assert.ok(!fs.existsSync(path.join(listState, 'runs')), '--list-variants must not start a run');

        // (3) The R27-9 defaults: reachability ON, one audit probe per fold, the
        //     under-trained floor at 1 — recorded in BOTH the manifest and the report.
        const file = path.join(root, 'candles.jsonl');
        writeCandles(file, 100);
        const tiny = [
            `--file=${file}`,
            '--bars=100', '--train=20', '--test=5',
            '--model=controller', '--variants=sig-momentum',
            '--audit=0', '--progress-ms=-1',
        ];
        const defDir = path.join(root, 'state-def');
        const def = spawnSync(process.execPath, [analyzePath, ...tiny], {
            cwd: projectRoot,
            encoding: 'utf8',
            env: { ...process.env, NEULEGION_STATE: defDir },
        });
        assert.equal(def.status, 0, `the default run exited ${def.status}:\n${def.stderr}`);
        const defRuns = fs.readdirSync(path.join(defDir, 'runs'));
        assert.equal(defRuns.length, 1, `expected exactly one run directory, got ${defRuns.length}`);
        const defDirPath = path.join(defDir, 'runs', defRuns[0]);
        const defManifest = JSON.parse(fs.readFileSync(path.join(defDirPath, 'run.json'), 'utf8'));
        const defReport = JSON.parse(fs.readFileSync(path.join(defDirPath, 'report.json'), 'utf8'));
        assert.equal(defManifest.requireReachable, true, 'run.json does not default requireReachable to true');
        assert.equal(defManifest.auditProbesPerFold, 1, 'run.json does not default auditProbesPerFold to 1');
        assert.equal(defManifest.minTrainingSteps, 1, 'run.json does not default minTrainingSteps to 1');
        assert.equal(defReport.requireReachable, true, 'report.json does not record requireReachable');
        assert.equal(defReport.auditProbesPerFold, 1, 'report.json does not record auditProbesPerFold');
        assert.equal(defReport.minTrainingSteps, 1, 'report.json does not record minTrainingSteps');

        // (4) The overrides thread through, and — being config/diagnostic knobs, not
        //     scoring knobs — move no scored number.
        const offDir = path.join(root, 'state-off');
        const off = spawnSync(process.execPath, [
            analyzePath, ...tiny,
            '--reachable=0', '--min-training-steps=5', '--audit-probes=3',
        ], {
            cwd: projectRoot,
            encoding: 'utf8',
            env: { ...process.env, NEULEGION_STATE: offDir },
        });
        assert.equal(off.status, 0, `the override run exited ${off.status}:\n${off.stderr}`);
        const offRuns = fs.readdirSync(path.join(offDir, 'runs'));
        const offDirPath = path.join(offDir, 'runs', offRuns[0]);
        const offManifest = JSON.parse(fs.readFileSync(path.join(offDirPath, 'run.json'), 'utf8'));
        const offReport = JSON.parse(fs.readFileSync(path.join(offDirPath, 'report.json'), 'utf8'));
        assert.equal(offManifest.requireReachable, false, '--reachable=0 was not recorded');
        assert.equal(offManifest.minTrainingSteps, 5, '--min-training-steps was not recorded');
        assert.equal(offManifest.auditProbesPerFold, 3, '--audit-probes was not recorded');
        assert.equal(offReport.requireReachable, false, 'report.json did not honour --reachable=0');
        assert.equal(offReport.minTrainingSteps, 5, 'report.json did not honour --min-training-steps');
        const scored = (r) => JSON.stringify(r.candidates.map((c) => [c.id, c.promote, c.pooledMetrics.netSharpe]));
        assert.equal(scored(offReport), scored(defReport), 'an R27-9 config knob changed a scored number');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the analyze CLI refuses a present-but-empty list flag (--files/--carry-files/--symbols/--variants/--seeds) (BUGS.md #69)', () => {
    // Round 30: `--files=` used to be indistinguishable from an absent flag, so a
    // shell typo silently scored the DEFAULT dataset and the run read as if the
    // intended experiment had happened. The corrected P3/P4 acceptance commands
    // (`round29-TESTING.md` §5) depend on this refusal, because their off-spec runs
    // expanded empty shell variables. The audit pass extends the same guard to the
    // other list flags whose empty form has no documented meaning.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neulegion-analyze-69-'));
    try {
        const cases = [
            ['--file=', /--file= was provided but names no files/],
            ['--files=', /--files= was provided but names no files/],
            ['--files=,', /--files= was provided but names no files/],
            ['--carry-files=', /--carry-files= was provided but names no files/],
            ['--symbols=', /--symbols= was provided but names no files/],
            ['--variants=', /--variants= was provided but names no files/],
            ['--seeds=', /--seeds= was provided but names no files/],
        ];
        for (const [flag, re] of cases) {
            const res = spawnSync(process.execPath, [
                analyzePath, flag, '--model=controller', '--variants=sig-momentum',
                '--bars=60', '--train=20', '--test=5', '--audit=0', '--progress-ms=-1',
            ], {
                cwd: projectRoot,
                encoding: 'utf8',
                env: { ...process.env, NEULEGION_STATE: path.join(root, `state-${flag.replace(/[^a-z]/gi, '')}`) },
            });
            assert.notEqual(res.status, 0, `${flag} should have failed but exited 0`);
            assert.match(res.stderr + res.stdout, re, `${flag} did not report the BUGS.md #69 refusal`);
        }

        // The guard must not over-reject: a non-empty --files list still runs.
        const file = path.join(root, 'candles.jsonl');
        writeCandles(file, 90);
        const ok = spawnSync(process.execPath, [
            analyzePath, `--files=${file}`, '--model=controller', '--variants=sig-momentum',
            '--bars=90', '--train=20', '--test=5', '--audit=0', '--progress-ms=-1',
        ], {
            cwd: projectRoot,
            encoding: 'utf8',
            env: { ...process.env, NEULEGION_STATE: path.join(root, 'state-ok') },
        });
        assert.equal(ok.status, 0, `a non-empty --files run exited ${ok.status}:\n${ok.stderr}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
