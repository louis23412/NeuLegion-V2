// src/analyze/cli/main.js (round-95 split of src/analyze/cli.js).
// replicateAnalysis, ANALYZE_USAGE, analyzeMain.
import path from 'path';
import { performance } from 'node:perf_hooks';
import { CONFIG } from '../../legion/config.js';
import { seedDistribution, formatSeedReplication } from '../../analysis/replication.js';
import { DEFAULT_SHOCK } from '../../analysis/world.js';
import { CANDLE_MANIFEST } from '../../candles_audit.js';
import { parseSleeveSizing, SLEEVE_IDS } from '../../sleeve_score.js';
import { makeRunId, createRunDirectory, writeJson, writeReport } from '../../observer/report.js';
import { emptyListFlagError, listVariants, formatVariantList } from '../roster.js';
import { runAnalysis, runSleeveAnalysis } from './run.js';


// Round 26 (R26-13): run the A/B under several master seeds and summarize the
// per-variant distribution (mean / IQM / stratified-bootstrap CI / variance
// decomposition) with common random numbers ON, so the variant differences are
// paired on the random draws. A single-seed point estimate is not a family
// decision (Bouthillier et al. 2019; Henderson et al. 2018). Only the first seed
// writes a run directory; the aggregate is written beside it as `replication.json`.
export async function replicateAnalysis({ seeds = [1, 2, 3], writeFiles = true, log = () => {}, ...options } = {}) {
    const list = (Array.isArray(seeds) ? seeds : []).filter((s) => Number.isFinite(s));
    if (!list.length) throw new Error('replicateAnalysis: at least one numeric seed is required');
    const runs = [];
    for (let i = 0; i < list.length; i++) {
        runs.push(await runAnalysis({ ...options, seed: list[i], writeFiles: writeFiles && i === 0, commonRandomNumbers: true, log }));
    }
    const first = runs[0].report;
    const ids = ['baseline', ...first.candidates.map((c) => c.id)];
    const seriesOf = (report, id) => {
        const row = id === 'baseline' ? report.baseline : report.candidates.find((c) => c.id === id);
        return row && Array.isArray(row.foldSharpes) ? row.foldSharpes : [];
    };
    const byVariant = {};
    for (const id of ids) {
        byVariant[id] = seedDistribution({ perSeed: runs.map((r) => ({ seed: r.report.seed, values: seriesOf(r.report, id) })) });
    }
    const replication = {
        seeds: list,
        variants: ids,
        byVariant,
        commonRandomNumbers: true,
        reader: 'per-variant seed distribution over the same fold grid: mean, IQM (Agarwal et al. 2021), stratified-bootstrap CI resampling within each seed stratum, and the seed/fold variance fractions. CRN on => the variant differences are paired on the random draws (Glasserman & Yao 1992); a single seed is not a ranking.',
    };
    if (writeFiles && runs[0].runDir) writeJson(runs[0].runDir, 'replication.json', replication);
    return { runs, replication, runDir: runs[0].runDir || null, durationMs: runs.reduce((a, r) => a + r.durationMs, 0) };
}

export const ANALYZE_USAGE = [
    'npm run analyze [-- <flags>]        (this text: --help / -h)',
    '',
    '  --file=<path>            single candle JSONL stream (default CONFIG.file; a',
    '                           present-but-empty value is an error — BUGS.md #69)',
    '  --files=<a,b>            explicit list of candle JSONL streams (a present-but-',
    '                           empty list is an error, not a fallback — BUGS.md #69)',
    '  --symbols=a,b|all        manifest symbols to pool (8 available; a present-but-',
    '                           empty list is an error — BUGS.md #69)',
    '  --carry-files=<a,b>      funding JSONL per stream (P4 carry sleeve; positional;',
    '                           a present-but-empty list is an error — BUGS.md #69)',
    '  --carry-marks=<file>     ext mark history ({scale, symbols:{sym:{t0,stepMs,v}}}) substituting',
    '                           per-row where a funding row carries no mark (round 78,',
    '                           TODO 95: scores the basis-marked book, not just the',
    '                           shipped-marks window; selected by symbol name, so it',
    '                           needs --symbols with one name per stream; shipped',
    '                           marks are kept where positive; needs --sleeve; a',
    '                           present-but-empty value is an error — BUGS.md #69)',
    '  --oi-file=<file>         open-interest file ({symbols:{sym:{t0,stepMs,oiVal[],topLS[]}}})',
    '                           projecting the oiValue/topLS/spotRet panels (round 80,',
    '                           TODO 110; needs a positioning --sleeve plus --symbols',
    '                           with one name per stream; refused when empty, on the',
    '                           carry sleeve, or without --sleeve — BUGS.md #69)',
    '  --sleeve=<id>            score a structural sleeve as a book instead of the A/B',
    '                           (W2 acceptance; needs --carry-files plus --files/--symbols;',
    '                           carry-dispersion runs on shipped data; the positioning',
    '                           sleeves (oi-change, toptrader-fade) need --oi-file;',
    '                           a present-but-empty value is an error — BUGS.md #69)',
    '  --sleeve-sizing=<vol|adaptive|drawdown>',
    '                           ALSO score the sleeve book sized to a per-bar vol',
    '                           target through the vol-target risk policy (round 69;',
    '                           causal trailing-RMS vols, skipped bars run flat, the',
    '                           target is caller-supplied, never banked — pick it at',
    '                           the book\'s own vol scale (the report prints bookVol;',
    '                           a target far above it just levers to the 4x cap;',
    '                           `adaptive` re-estimates the target causally as the',
    '                           trailing mean vol — the F-115/F-117 payoff mode;',
    '                           `drawdown` closes the loop: the adaptive target',
    '                           times the trailing-drawdown governor (F-118);',
    '                           a present-but-empty value is an error — BUGS.md #69)',
    '  --sleeve-sizing-window=<n>',
    '                           trailing-RMS window in bars for --sleeve-sizing',
    '                           (default 24; needs --sleeve-sizing)',
    '  --cadences=a,b,c         re-score every active candidate on each fold-grid cadence',
    '                           (P2 fixed-position restatement, no model) and report the',
    '                           majority-pass + catastrophic-veto verdict across the grid',
    '  --exposure-match         also quote each active candidate against the baseline at a',
    '                           MATCHED in-market share (P2 exposure matching; no model)',
    '  --model=controller|bare  shipped controller (default) or the round-22 proxy',
    '  --history=window|full    score the verdict window only (default), or ALSO score',
    '                           every active signal arm contiguously over each stream\u2019s',
    '                           FULL history beside the verdict (lab R1; no folds, no',
    '                           model — model arms keep --bars)',
    '  --train=<n> --test=<n>   walk-forward sizes (default 60 / 15)',
    '  --bars=<n>               bars per stream, most recent (default 300)',
    '  --seed=<n>               seed (default 1)',
    '  --probe=<x>              audit shock size (default 0.05)',
    '  --audit-probes=<n>       probe passes per fold (default 1; the audit is the',
    '                           dominant per-fold cost, and one probe per fold is ample)',
    '  --audit=0                skip the look-ahead audit (no promotion is defensible then)',
    '  --reachable=0            disable the behavioural non-vacuity requirement (default:',
    '                           ON — an audit that cannot differ cannot certify a promotion)',
    '  --min-training-steps=<n> floor below which a fold counts as under-trained',
    '                           (default 1; a fold with 0 steps is not-trained, not under-trained)',
    '  --list-variants          print the resolvable variant taxonomy (id/kind/applies-to/',
    '                           default?/applicable-here) and exit',
    '  --cost-bps=<n>           transaction cost in bps per unit turnover (default 0;',
    '                           the report always states the break-even cost per candidate)',
    '  --reuse-base             reuse the scored pass as the audit base pass (one fewer',
    '                           refit per fold; the verdict is unchanged)',
    '  --variants=a,b           narrow the candidate family (baseline is always first;',
    '                           a present-but-empty list is an error — BUGS.md #69)',
    '  --gate=classic|dependence promotion gate (default dependence: adds the paired',
    '                           cluster Sharpe-difference t-test, the exact sign test over',
    '                           fold windows, and the DSR floor on design-effect-adjusted',
    '                           bars; all skipped on a single-stream run)',
    '  --gate-alpha=<a>         alpha for the dependence hurdles (default = --alpha)',
    '  --cost-ladder=0,2,5,10   cost levels (bps of turnover) the whole verdict is',
    '                           restated at (default 0,2,5,10; empty disables)',
    '  --turnover-sweep         restate the journaled confidence under a no-trade band',
    '                           x entry/exit hysteresis x minimum-holding grid (pure',
    '                           post-processing, no model) and report which policy',
    '                           clears the target taker cost',
    '  --turnover-target=<bps>  break-even cost the turnover attack tries to clear',
    '                           (default 5 bps — the Binance USD-M futures taker fee)',
    '  --interval=<n>           resample every stream by n bars (e.g. 4 = 4h bars from',
    '                           1h data); a genuinely different horizon, not a copy',
    '  --select-streams[=<n>]   measure the basket\'s effective independence (Kish',
    '                           design effect over the streams\' returns) and report',
    '                           the greedy most-diversifying order; with =<n> keep only',
    '                           the first n streams of that order',
    '  --crn=0                  disable common random numbers (R26-13): use the',
    '                           historical per-variant fold seed instead of the paired',
    '                           variant-independent one (default: CRN on)',
    '  --forecast=0             skip the forecast-comparison block (R26-14): the',
    '                           proper scores, the Diebold-Mariano test vs baseline',
    '                           and the family Model Confidence Set (default: on;',
    '                           pure post-processing of the journaled confidence)',
    '  --decision=0             skip the decision-grade report block (R26-8): the',
    '                           six-question composition (training / edge /',
    '                           concentration / economics / family / nextRun); the',
    '                           concentration readout is a leave-one-fold-out Sharpe',
    '                           sweep, so this saves that pass (default: on)',
    '  --seeds=a,b,c            replicate the A/B under several master seeds with CRN and',
    '                           aggregate each variant\'s mean/IQM/stratified-bootstrap CI',
    '                           + seed/fold variance split (writes replication.json',
    '                           beside the first run dir; a present-but-empty list is an',
    '                           error — BUGS.md #69)',
    '  --keep-models            keep each fit\'s SQLite state dir (forensics; large)',
    '  --fold-log=all|score|off what folds.jsonl records (default all)',
    '  --save-interval=<n>      full-state checkpoint every n getSignal calls',
    '                           (default Infinity: the A/B never reads it back;',
    '                           use 1 for the historical per-call dump)',
    '  --label-policy=optimistic|conservative|triple',
    '                           trade-label policy for every controller (default',
    '                           optimistic = the shipped labeler, bit-identical)',
    '  --label-horizon=<n>      time barrier in bars for --label-policy=triple',
    '                           (required for the triple barrier to expire a trade)',
    '  --sample-weight-horizon=<n>',
    '                           fixed span horizon in bars for the opt-in',
    '                           `sample-weights` causal ring (default: the label',
    '                           horizon when it has a real time barrier, else the',
    '                           causal MEASURED estimate — R28/BUGS.md #58)',
    '  --label-policies         add the opt-in label variants (conservative, triple)',
    '                           to the candidate roster (a training-set change)',
    '  --concurrency=<n>        fold-passes in flight via worker threads (default 1 =',
    '                           serial; > 1 dispatches each fold to a worker — identical',
    '                           arithmetic and folds.jsonl, only wall time moves)',
    '  --progress-ms=<n>        heartbeat cadence ms (default 5000; 0 = every pass, -1 = silent)',
].join('\n');

export async function analyzeMain() {
    const args = process.argv.slice(2);
    const argOf = (name) => {
        const hit = args.find((a) => a.startsWith(`--${name}=`));
        return hit ? hit.slice(name.length + 3) : null;
    };
    const num = (name, fallback) => {
        const v = argOf(name);
        return v == null ? fallback : Number(v);
    };
    const list = (name) => {
        const v = argOf(name);
        return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null;
    };
    const has = (name) => args.includes(`--${name}`);
    // Round 30 (BUGS.md #69): `has` matches only the bare `--name` token, so a
    // `--files=` (present but empty) was indistinguishable from an absent flag and
    // silently fell back to the default dataset. `flagGiven` matches both forms.
    const flagGiven = (name) => args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    try {
        if (has('help') || args.includes('-h')) {
            console.log(ANALYZE_USAGE);
            process.exit(0);
        }
        // R27-2/R27-5: the taxonomy is printable before a run, so the operator can
        // see which variants can reach the scored model (and why not) without
        // starting a multi-minute evaluation.
        if (has('list-variants')) {
            console.log(formatVariantList(listVariants(argOf('model') || 'controller')));
            process.exit(0);
        }
        const foldLogRaw = argOf('fold-log') || 'all';
        const foldLog = ['all', 'score', 'off'].includes(foldLogRaw) ? foldLogRaw : 'all';
        const ladderRaw = argOf('cost-ladder');
        // `--cost-ladder=` (explicitly empty) disables the ladder; absent keeps the
        // default levels.
        const costLadderLevels = ladderRaw == null
            ? undefined
            : (ladderRaw.trim() === '' ? [] : ladderRaw.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x >= 0));
        const symbols = list('symbols');
        // P2: the cadence grid for the configuration-robust restatement. Absent =>
        // the sweep is off (the report block is null and the write is unchanged).
        const cadenceList = (() => {
            const raw = list('cadences');
            const vals = raw ? raw.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0) : [];
            return vals.length ? vals : null;
        })();
        const saveIntervalRaw = argOf('save-interval');
        // Default: no checkpointing during the run (the A/B never reads it back).
        // `--save-interval=1` restores the historical per-call full-state dump.
        const saveInterval = saveIntervalRaw == null
            ? Infinity
            : (/^(inf(inity)?)$/i.test(saveIntervalRaw.trim()) ? Infinity : Number(saveIntervalRaw));
        // Round 30 (BUGS.md #69): a PRESENT-but-empty `--files=`/`--carry-files=`
        // used to be treated exactly like an absent flag, so a shell typo silently
        // scored the default dataset (or dropped the carry sleeve) and the run read
        // as if the intended experiment had happened. Refuse instead.
        const fileErr = emptyListFlagError('file', flagGiven('file'), argOf('file'));
        if (fileErr) throw new Error(fileErr);
        const filesList = list('files');
        const filesErr = emptyListFlagError('files', flagGiven('files'), argOf('files'));
        if (filesErr) throw new Error(filesErr);
        const carryFilesList = list('carry-files');
        const carryErr = emptyListFlagError('carry-files', flagGiven('carry-files'), argOf('carry-files'), 'the default (no carry sleeve)');
        if (carryErr) throw new Error(carryErr);
        // The same class covers the singular `--file=` and every other LIST flag
        // whose empty form has no documented meaning: a mistyped/empty shell variable
        // in `--file=` / `--symbols=` / `--variants=` / `--seeds=` would otherwise run
        // the default dataset (or the default roster, or a single-seed run) while
        // looking like the intended experiment. (The enumerated-mode flags
        // `--model=` / `--gate=` / `--label-policy=` keep their documented "empty =
        // default" semantics, as do `--cost-ladder=` / `--cadences=`, whose empty
        // form means "off".)
        const symbolsErr = emptyListFlagError('symbols', flagGiven('symbols'), argOf('symbols'));
        if (symbolsErr) throw new Error(symbolsErr);
        const variantsErr = emptyListFlagError('variants', flagGiven('variants'), argOf('variants'), 'the default roster');
        if (variantsErr) throw new Error(variantsErr);
        const seedsErr = emptyListFlagError('seeds', flagGiven('seeds'), argOf('seeds'), 'a single-seed run');
        if (seedsErr) throw new Error(seedsErr);
        const options = {
            file: argOf('file') || CONFIG.file,
            files: filesList,
            symbols: symbols && symbols.length === 1 && symbols[0] === 'all' ? CANDLE_MANIFEST.map((e) => e.symbol) : symbols,
            // P4: the funding/carry files, positionally matched to files/symbols.
            carryFiles: carryFilesList,
            cadences: cadenceList,
            exposureMatch: has('exposure-match'),
            model: argOf('model') || 'controller',
            history: argOf('history') || 'window',
            trainSize: num('train', 60),
            testSize: num('test', 15),
            maxBars: num('bars', 300),
            seed: num('seed', 1),
            probe: num('probe', DEFAULT_SHOCK.probe),
            auditProbesPerFold: num('audit-probes', 1),
            variantIds: list('variants'),
            audit: argOf('audit') !== '0',
            // R27-9: reachability is ON by default; `--reachable=0` opts out. The
            // historical `--reachable` flag still works (it is a no-op now).
            requireReachable: !/^(0|false)$/i.test(String(argOf('reachable'))),
            minTrainingSteps: num('min-training-steps', 1),
            costBps: num('cost-bps', 0),
            reuseBase: has('reuse-base'),
            gate: argOf('gate') || 'dependence',
            gateAlpha: argOf('gate-alpha') == null ? null : num('gate-alpha', null),
            ...(costLadderLevels === undefined ? {} : { costLadderLevels }),
            turnoverSweep: has('turnover-sweep'),
            turnoverTarget: num('turnover-target', 5),
            intervalBars: num('interval', 1),
            streamSelect: (() => {
                if (!has('select-streams')) return null;
                const raw = argOf('select-streams');
                const n = raw == null ? NaN : Number(raw);
                return Number.isFinite(n) && n > 0 ? n : true;
            })(),
            commonRandomNumbers: !/^(0|false)$/i.test(String(argOf('crn'))),
            forecast: !/^(0|false)$/i.test(String(argOf('forecast'))),
            decision: !/^(0|false)$/i.test(String(argOf('decision'))),
            modelRetention: has('keep-models') ? 'keep' : 'discard',
            foldLog,
            saveInterval,
            labelPolicy: argOf('label-policy') || 'optimistic',
            labelHorizonBars: num('label-horizon', null),
            sampleWeightHorizon: num('sample-weight-horizon', null),
            labelPolicies: has('label-policies'),
            concurrency: num('concurrency', 1),
            progressMs: num('progress-ms', 5000),
            log: (line) => console.log(line),
        };
        const seedList = list('seeds');
        const sleeveGiven = flagGiven('sleeve');
        const sleeveId = argOf('sleeve');
        // Round 78: --carry-marks outside --sleeve mode is refused up front —
        // ext-mark substitution is a sleeve-view input, so a mispaired flag
        // must fail loudly rather than run an A/B that ignores it.
        if (flagGiven('carry-marks') && !sleeveGiven) throw new Error('analyze: --carry-marks needs --sleeve (ext-mark substitution is a sleeve-view input)');
        if (flagGiven('oi-file') && !sleeveGiven) throw new Error('analyze: --oi-file needs --sleeve (positioning panels are a sleeve-view input)');
        if (sleeveGiven) {
            // Round 44 (W2): the sleeve run mode — a structural book scored by the
            // gate's own arithmetic, not an A/B. Writes run.json + report.json
            // beside the A/B runs so the G2/G5 evidence has the same artifact shape.
            if (sleeveId == null || !String(sleeveId).trim()) throw new Error('analyze: --sleeve= is present but empty (a sleeve id is required — BUGS.md #69)');
            if (!SLEEVE_IDS.includes(sleeveId)) throw new Error(`analyze: unknown --sleeve "${sleeveId}" (known: ${SLEEVE_IDS.join(', ')})`);
            if (!carryFilesList || !carryFilesList.length) throw new Error('analyze: --sleeve needs --carry-files (funding JSONL per stream, positionally matched to the candle inputs)');
            const sleeveSymbols = symbols && symbols.length === 1 && symbols[0] === 'all' ? CANDLE_MANIFEST.map((e) => e.symbol) : symbols;
            const sleeveCost = num('cost-bps', 0);
            // Round 69: the opt-in sized leg — the scored book through the
            // vol-target risk plugin (the W4c-z/F-115 payoff, now callable).
            // A present-but-empty --sleeve-sizing is refused (BUGS.md #69);
            // --sleeve-sizing-window without --sleeve-sizing is refused too.
            const sizingGiven = flagGiven('sleeve-sizing');
            const sizingRaw = argOf('sleeve-sizing');
            if (sizingGiven && (sizingRaw == null || !String(sizingRaw).trim())) throw new Error('analyze: --sleeve-sizing is present but empty (a positive per-bar vol target is required — BUGS.md #69)');
            if (flagGiven('sleeve-sizing-window') && !sizingGiven) throw new Error('analyze: --sleeve-sizing-window needs --sleeve-sizing');
            const sizingOpt = parseSleeveSizing({ sizing: sizingGiven ? sizingRaw : null, window: argOf('sleeve-sizing-window') });
            // Round 78 (TODO 95): the opt-in honest-marks leg — an ext mark
            // history substituting per-row where the shipped marks are missing.
            // A present-but-empty --carry-marks is refused (BUGS.md #69); it
            // needs --symbols with one name per --carry-files stream (marks
            // select by symbol name; the needs---sleeve guard sits above).
            const carryMarksGiven = flagGiven('carry-marks');
            const carryMarksRaw = argOf('carry-marks');
            if (carryMarksGiven && (carryMarksRaw == null || !String(carryMarksRaw).trim())) throw new Error('analyze: --carry-marks is present but empty (a marks file path is required — BUGS.md #69)');
            const carryMarksPath = carryMarksGiven ? String(carryMarksRaw).trim() : null;
            if (carryMarksPath != null && (!sleeveSymbols || sleeveSymbols.length !== carryFilesList.length)) throw new Error('analyze: --carry-marks needs --symbols with one name per --carry-files stream (marks are selected by symbol name)');
            // Round 80 (TODO 110): the opt-in positioning leg — an open-interest
            // file ({symbols: {sym: {t0, stepMs, oiVal[], topLS[]}}}) projecting
            // the oiValue/topLS/spotRet panels the positioning sleeves score.
            // Refused when empty, on the carry sleeve, or without matched
            // --symbols (BUGS.md #69); --carry-marks with a positioning sleeve
            // is refused too (marks are a carry-view input).
            const positioningSleeves = ['oi-change', 'toptrader-fade'];
            const oiFileGiven = flagGiven('oi-file');
            const oiFileRaw = argOf('oi-file');
            if (oiFileGiven && (oiFileRaw == null || !String(oiFileRaw).trim())) throw new Error('analyze: --oi-file is present but empty (an open-interest file path is required — BUGS.md #69)');
            const oiFilePath = oiFileGiven ? String(oiFileRaw).trim() : null;
            if (oiFilePath != null && sleeveId === 'carry-dispersion') throw new Error('analyze: --oi-file needs a positioning sleeve (oi-change, toptrader-fade)');
            if (oiFilePath != null && (!sleeveSymbols || sleeveSymbols.length !== carryFilesList.length)) throw new Error('analyze: --oi-file needs --symbols with one name per --carry-files stream (OI series are selected by symbol name)');
            if (carryMarksPath != null && positioningSleeves.includes(sleeveId)) throw new Error('analyze: --carry-marks needs the carry sleeve (carry-dispersion)');
            const sleeveT0 = performance.now();
            const startedAt = Date.now();
            const sleeveOut = await runSleeveAnalysis({
                sleeve: sleeveId, carryFiles: carryFilesList, files: filesList,
                symbols: sleeveSymbols, costBps: sleeveCost,
                sizingTarget: sizingOpt.sized ? sizingOpt.target : null, sizingWindow: sizingOpt.window,
                carryMarks: carryMarksPath, oiFile: oiFilePath,
            });
            const durationMs = performance.now() - sleeveT0;
            const runId = `${makeRunId({ seed: num('seed', 1), startedAt })}-sleeve`;
            const runDir = createRunDirectory(CONFIG.stateFolder, runId);
            writeJson(runDir, 'run.json', { runId, mode: 'sleeve', sleeve: sleeveId, startedAt, costBps: sleeveCost, sizing: sizingOpt.sized ? { target: sizingOpt.target, window: sizingOpt.window } : null, inputs: sleeveOut.inputs, carryFiles: carryFilesList, carryMarks: carryMarksPath, oiFile: oiFilePath });
            writeReport(runDir, { mode: 'sleeve', sleeve: sleeveId, costBps: sleeveCost, sizing: sizingOpt.sized ? { target: sizingOpt.target, window: sizingOpt.window } : null, durationMs, inputs: sleeveOut.inputs, carryFiles: carryFilesList, carryMarks: carryMarksPath, oiFile: oiFilePath, result: sleeveOut.result });
            console.log(sleeveOut.summary);
            console.log(`\nsleeve report at ${path.join(runDir, 'report.json')} (${durationMs.toFixed(0)}ms)`);
        } else if (seedList) {
            // Round 26 (R26-13): replicate under several master seeds and print each
            // variant's distribution, not a single-seed point estimate.
            const seeds = seedList.map((s) => Number(s)).filter((s) => Number.isFinite(s));
            const { runs, replication, runDir, durationMs } = await replicateAnalysis({ ...options, seeds });
            for (const r of runs) console.log(r.report.summary);
            console.log('');
            for (const [id, dist] of Object.entries(replication.byVariant)) {
                console.log(formatSeedReplication({ label: `seeds ${id}`, dist }));
            }
            console.log(`\nreplicated ${seeds.length} seeds (${seeds.join(',')}) in ${durationMs.toFixed(0)}ms` +
                `${runDir ? ` — aggregate at ${path.join(runDir, 'replication.json')}` : ''}`);
        } else {
            const { runDir, report, durationMs } = await runAnalysis(options);
            console.log(report.summary);
            console.log(`\nanalyzed in ${durationMs.toFixed(0)}ms${runDir ? ` — report at ${path.join(runDir, 'report.json')}` : ''}`);
            if (runDir) {
                console.log('upload: run.json, report.json, run.log (optionally folds.jsonl) — ' +
                    'per-variant checkpoint: partial-report.json, live heartbeat: progress.json. Do not upload models/.');
            }
        }
    } catch (err) {
        console.error('analyze failed:', err && err.stack ? err.stack : err);
        process.exitCode = 1;
    }
}
