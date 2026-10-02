// src/analyze/cli/run.js (round-95 split of src/analyze/cli.js).
// Worker dispatcher, sleeve analysis, runAnalysis.
import fs from 'fs';
import path from 'path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { CONFIG } from '../../legion/config.js';
import { runWorkerThread } from '../../legion/workers.js';
import { makeFoldExecutor, normaliseConcurrency } from '../../analysis/parallel.js';
import { promoteDecision, verifyPolicyRoundTrip, restateReportAtCadence, exposureMatchedPair, costLadder, familyCorrelation, buildFullHistoryBlock } from '../../analysis/walkforward.js';
import { turnoverSweep as runTurnoverSweep } from '../../analysis/holding.js';
import { resampleCandles, designEffectOfStreams, selectStreams as runStreamSelection } from '../../analysis/streams.js';
import { forecastComparison } from '../../analysis/forecast.js';
import { foldConcentration, confidencePersistence, nextRunPlan, decisionReport, promotionAcrossCadences, defaultCatastrophic } from '../../analysis/decision.js';
import { walkForwardSplit } from '../../analysis/splits.js';
import { makeCandleViewFor, worldFromCandles, DEFAULT_SHOCK } from '../../analysis/world.js';
import { CANDLE_MANIFEST } from '../../candles_audit.js';
import { parseFundingJsonl, auditFundingSeries, auditFundingProblems, carryPanelStream, pooledCarry, correlation } from '../../analysis/carry.js';
import { runSleeveReport, formatSleeveReport } from '../../sleeve_score.js';
import { makeRunId, createRunDirectory, writeJson, writeJsonAtomic, writeReport, appendLog, appendJsonl } from '../../observer/report.js';
import { configFingerprint } from '../../legion/sanitize.js';
import { FEATURE_LEN, ALL_VARIANTS, LABEL_VARIANTS, forecastKindOf, POSITION_POLICY, CONTROLLER_POSITION_POLICY, IDENTITY_POSITION_POLICY, CONTROLLER_MODEL, resolveVariant } from '../roster.js';
import { makeHiveMindModelFactory, makeBenchmarkModelFactory, emptyModelAccumulator, mergeModelStats, summarizeModelStats, makeControllerModelFactory, makeSignalForVariant } from '../models.js';
import { evaluateAB, evaluateABAsync, formatAnalysis } from '../evaluate.js';
import { readCandles, resolveSymbolFiles, probesPerFold } from './io.js';
import { variantRosterRow, baselineRow, candidateRow, foldRecord, fmtClock } from './rows.js';


// A worker-backed fold dispatcher (round 26, R26-4). Each call runs one fold-pass
// in its own thread via the settle-once, watchdogged `runWorkerThread`, so a crash
// or hang in one fold rejects that fold only. `spawn` is injectable so a test can
// drive the dispatch without `worker_threads`.
export const makeNodeFoldDispatcher = ({ url, spawn = null, timeoutMs = null } = {}) => {
    const spawnWorker = spawn || ((u, workerData) => new Worker(u, { workerData }));
    return async (request) => runWorkerThread({
        url,
        label: `fold:${request.variantId}#${request.streamIndex}.${request.foldIndex}`,
        workerData: request,
        spawn: spawnWorker,
        accept: (m) => !!m && Array.isArray(m.positions),
        onSuccess: (m) => ({ positions: m.positions, confidence: m.confidence || null, stats: m.stats || null }),
        ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
    });
};

// Run a structural sleeve against real data (round 44, `--sleeve`).
//
// The W2 acceptance: sleeves are not `controller` candidates — they are books
// scored by the same metrics. `readFile` is injected so the browser harness
// pins this without the native driver; the CLI passes the real reader and
// writes the run directory itself. Throws fail-closed on missing inputs
// (BUGS.md #69); a sleeve with no runnable data lands `available:false` in
// the report instead of throwing, so the artifact always says what ran.
export async function runSleeveAnalysis({
    sleeve = 'carry-dispersion', carryFiles = null, files = null, symbols = null,
    file = CONFIG.file, costBps = 0, sizingTarget = null, sizingWindow = 24,
    carryMarks = null, oiFile = null, riskSpec = null,
    readFile = (f) => fs.readFileSync(f, 'utf8'),
} = {}) {
    if (!carryFiles || !carryFiles.length) {
        throw new Error('analyze: --sleeve needs --carry-files (funding JSONL per stream, positionally matched to the candle inputs)');
    }
    const inputs = files && files.length ? files : (symbols && symbols.length ? resolveSymbolFiles(symbols) : [file]);
    const fundingTexts = carryFiles.map((f) => readFile(f));
    const candleTexts = inputs.map((f) => readFile(f));
    const marksText = carryMarks == null ? null : readFile(carryMarks);
    const oiText = oiFile == null ? null : readFile(oiFile);
    const markSymbols = symbols && symbols.length === 1 && symbols[0] === 'all' ? CANDLE_MANIFEST.map((e) => e.symbol) : symbols;
    const result = runSleeveReport({ sleeveId: sleeve, fundingTexts, candleTexts, costBps, sizingTarget, sizingWindow, marksText, symbols: markSymbols, oiText, riskSpec });
    return { inputs, carryFiles, sleeve, costBps, sizingTarget, sizingWindow, carryMarks, oiFile, riskSpec, result, summary: formatSleeveReport(result) };
}

// Run the A/B against real candle data. Loads the model lazily so importing this
// module for its pure core never touches the SQLite driver.
//
// Round 23: the default model is the SHIPPED `HiveMindController` on a real candle
// world (N0), the candidate family includes the causal signal family (N1), and one
// or more symbols can be evaluated and pooled (N2).
export async function runAnalysis({
    file = CONFIG.file, files = null, symbols = null, stateFolder = CONFIG.stateFolder,
    trainSize = 60, testSize = 15, maxBars = 300, variantIds = null, costBps = 0, seed = 1,
    audit = true, alpha = 0.05, model = 'controller', writeFiles = true,
    probe = DEFAULT_SHOCK.probe, auditProbesPerFold = 2,
    // Round 27 (R27-9): `requireReachable` now defaults ON — a structurally
    // reachable but behaviourally unreachable audit must never certify a
    // promotion. `--reachable=0` opts out. The CLI also defaults
    // `--audit-probes` to 1 (below); this direct-call default stays 2 so the
    // historical behaviour is available to a direct caller.
    minTrainingSteps = 1,        // R27-5: folds training on fewer rows than this are `underTrainedFolds`
    // Round 24 run-integrity options (all off the arithmetic path).
    modelRetention = 'discard',   // 'discard' reclaims each fit's state dir after use; 'keep' for forensics
    requireReachable = true,      // enforce the audit's behavioural non-vacuity (not just structural)
    reuseBase = false,            // reuse the scored pass as the audit base pass (one less refit/fold)
    foldLog = 'all',              // 'all' | 'score' | 'off': what folds.jsonl records
    progressMs = 5000,            // stdout + progress.json cadence; 0 = every event, -1 = silent
    // Round 26 (R26-12): the A/B never reads a fit's persisted state back, so it
    // does not pay for the checkpoint. `1` restores a per-call full-state dump
    // (the historical behaviour); `Infinity` never dumps during the run. The
    // emitted signals/positions are identical either way (measured: ~25% of the
    // per-call cost was the dump).
    saveInterval = Infinity,
    // Round 26 (R26-11): the label policy applied to every controller. Default
    // `optimistic` is the shipped labeler (bit-identical); `conservative` and
    // `triple` are also available as opt-in *variants* (`--label-policies`).
    // `labelHorizonBars` is the triple barrier's time horizon; without it the
    // `triple` policy degrades to `conservative` (recorded, not silently ignored).
    labelPolicy = 'optimistic',
    labelHorizonBars = null,
    labelPolicies = false,        // append the opt-in label variants to the roster
    // R28 (BUGS.md #58 / P1c): a fixed span horizon (bars) for the opt-in
    // `sample-weights` causal ring. `null` (default) lets the variant choose: the
    // label horizon when it is a real vertical barrier, else the causal MEASURED
    // estimate. Either way the ring never reads the label it is weighting.
    sampleWeightHorizon = null,
    // Round 26 (R26-4): the fold loop's in-flight width. `1` (default) keeps the
    // serial driver byte-for-byte; `> 1` dispatches whole fold-passes to worker
    // threads through the settle-once dispatcher. The arithmetic and the emit order
    // are unchanged (only wall time moves). `spawnWorker` is injectable for tests.
    concurrency = 1,
    spawnWorker = null,
    // Round 26 (R26-6): buy effective independence, not bars. `intervalBars > 1`
    // resamples every stream by that factor (e.g. 4 => 4h bars from 1h data) — a
    // genuinely different horizon, not another copy of the same one. `streamSelect`
    // is null (off) | true (measure and report the greedy basket) | a positive
    // integer (keep only the first N streams of the greedy order). Both are design
    // choices; neither changes how an included stream is scored.
    intervalBars = 1,
    streamSelect = null,
    // Round 29 -> 30 (P4): funding JSONL files (Binance `fapi/v1/fundingRate`),
    // POSITIONALLY matched to `files`/`symbols`. Each funding series contributes a
    // carry panel stream (the delta-neutral short-perp/long-spot return), appended
    // to every candidate's dependence/DSR panel so the design effect counts a
    // structurally independent return source. Null (the default) changes nothing.
    carryFiles = null,
    // Round 29 -> 30 (P2): the configuration-robust promotion sweep. `cadences` is
    // a list of fold-grid `testSize` values; when supplied, every ACTIVE candidate
    // is re-scored on each grid with `restateReportAtCadence` (the fixed-position
    // restatement the P2 retrospective used — pure post-processing, no model) and
    // `promotionAcrossCadences` applies the majority-pass + catastrophic-veto rule.
    // Null (the default) changes nothing. `exposureMatch` additionally quotes each
    // active candidate against the baseline at a MATCHED in-market share.
    cadences = null,
    exposureMatch = false,
    // Round 33 (lab R1): 'window' (default) scores only the --bars verdict window;
    // 'full' additionally scores every ACTIVE signal arm contiguously over each
    // stream's FULL history (no folds) and attaches the `fullHistory` readout
    // beside the verdict. Model arms are never re-scored (a controller fit replays
    // all history per fold — O(n^2) per stream — so full-history scoring is
    // signal-only by construction, audit A10).
    history = 'window',
    // Round 26 (R26-13): common random numbers. With CRN (the default) every
    // variant's fold seed depends only on the master seed and `testStart`, so the
    // variant comparison is PAIRED on the random draws and the variance of the
    // difference falls (Glasserman & Yao 1992). `false` restores the historical
    // per-variant seed (`seed*131 + hash(variant.id)`) for reproducing old runs.
    commonRandomNumbers = true,
    // Round 26 (R26-14): score the family as forecasters (proper scores, the
    // Diebold–Mariano test vs the baseline, and the family Model Confidence Set).
    // Pure post-processing of the journaled confidence — it cannot move a scored
    // number. `--forecast=0` disables the (small) extra work.
    forecast = true,
    // Round 26 (R26-8): the decision-grade report — a pure composition of the blocks
    // above into the six questions the next cycle asks (training / edge /
    // concentration / economics / family / nextRun), every field either a value or an
    // explicit { available:false, reason }. No new strategy statistic is computed; the
    // concentration readout restates the scored folds (leave-one-fold-out Sharpe
    // range) and `nextRun` reads the measured power. `--decision=0` disables it.
    decision = true,
    // Round 25 decision options.
    gate = 'dependence',          // 'classic' (round-23/24 hurdles) | 'dependence' (adds the panel-aware ones)
    gateAlpha = null,             // alpha for the dependence hurdles (defaults to `alpha`)
    costLadderLevels = [0, 2, 5, 10], // bps-of-turnover levels the verdict is restated at ([] disables)
    // Round 26 (R26-5): the turnover attack. A dead-zone x hysteresis x
    // minimum-holding grid restated as pure post-processing of the journaled
    // confidence (no model). Off by default — it is an extra diagnostic block,
    // like the cost ladder, and cannot move a scored number. `turnoverTarget` is
    // the bps of per-unit-turnover cost the attack is trying to clear (the
    // realistic crypto taker range is 5-10 bps).
    turnoverSweep = false,
    turnoverTarget = 5,
    log = () => {},               // stdout sink (injectable so tests stay quiet)
    HiveMind: injectedHiveMind = null, HiveMindController: injectedController = null,
} = {}) {
    const startedAt = Date.now();
    const useController = model !== 'bare';
    // Round 26 (R26-11): validate the label policy up front so a typo cannot
    // silently run the default labeler.
    if (!['optimistic', 'conservative', 'triple'].includes(labelPolicy)) {
        throw new Error(`analyze: unknown labelPolicy "${labelPolicy}" (optimistic | conservative | triple)`);
    }
    // Round 33 (lab R1): fail fast on a misspelled history mode (an enumerated
    // flag, like --label-policy — the BUGS.md #69 discipline).
    if (history !== 'window' && history !== 'full') {
        throw new Error(`analyze: unknown history "${history}" (window | full)`);
    }
    const historyFull = history === 'full';
    // Round 26 (R26-4): resolve the fold loop's in-flight width once, so the manifest,
    // the checkpoints and the report all state what was actually used.
    const width = normaliseConcurrency(concurrency);
    // Round 25: resolve the promotion gate and the cost-ladder levels ONCE, so the
    // manifest, every checkpoint and the final report state what was actually
    // used. `classic` is the round-23/24 gate; `dependence` adds the paired
    // cluster Sharpe-difference test, the exact sign test over fold windows, and
    // the design-effect-adjusted DSR floor (all skipped, not failed, on a
    // single-stream run that has no panel to estimate them from).
    const gateMode = gate === 'classic' ? 'classic' : 'dependence';
    const gateAlphaResolved = Number.isFinite(gateAlpha) ? gateAlpha : alpha;
    const gateOptions = gateMode === 'dependence'
        ? { requireSharpeDiff: true, requireClusterStability: true, minDsrAdjusted: 0.95, alpha: gateAlphaResolved, periodsPerYear: 252, rawFoldHurdles: false }
        : { alpha: gateAlphaResolved, periodsPerYear: 252 };
    const ladderLevels = Array.isArray(costLadderLevels)
        ? costLadderLevels.filter((x) => Number.isFinite(x) && x >= 0)
        : [];
    // Round 26 (R26-5): resolve the turnover attack's target once, so the manifest
    // and the report state the same number the sweep was run against.
    const turnoverEnabled = turnoverSweep === true;
    const turnoverTargetBps = Number.isFinite(turnoverTarget) ? turnoverTarget : 5;
    // Round 26 (R26-6): resolve the interval factor and the stream-selection mode
    // once, so the manifest and the report agree.
    const intervalFactor = Number.isInteger(intervalBars) && intervalBars > 1 ? intervalBars : 1;
    const streamSelectKeep = Number.isFinite(streamSelect) && streamSelect > 0 ? Math.floor(streamSelect) : null;
    const streamSelectEnabled = streamSelect === true || streamSelectKeep != null;
    const crn = commonRandomNumbers !== false;
    const forecastEnabled = forecast !== false;
    const HiveMind = injectedHiveMind || (await import('../../hivemind/hiveMind.js')).default;
    const HiveMindController = useController
        ? (injectedController || (await import('../../hivemind/hiveMindController.js')).default)
        : null;

    const inputs = files && files.length ? files : (symbols && symbols.length ? resolveSymbolFiles(symbols) : [file]);
    // R27-5 journal/report hygiene: a stream's label is its SYMBOL (or the file
    // basename), never the operator's absolute path. The round-26 journal embedded
    // `/home/<operator>/.../candles.jsonl` because the world label was the path.
    const inputLabels = inputs.map((f) => {
        const entry = CANDLE_MANIFEST.find((e) => f === e.file || String(f).endsWith(e.file));
        if (entry) return entry.symbol;
        const base = path.basename(String(f)).replace(/\.jsonl$/i, '').replace(/^candles[_-]?/i, '');
        return base ? base.toUpperCase() : String(f);
    });

    let worlds = [];
    for (let ii = 0; ii < inputs.length; ii++) {
        const f = inputs[ii];
        // Round 26 (R26-6): optionally resample the raw 1h stream to a coarser bar
        // interval before the world is built, so a second horizon can be added to
        // the panel without a second dataset.
        const rawCandles = readCandles(f);
        const candles = intervalFactor > 1 ? resampleCandles(rawCandles, { factor: intervalFactor }) : rawCandles;
        const world = worldFromCandles(candles, { maxBars });
        if (world.closes.length < trainSize + testSize + 2) {
            throw new Error(`analyze: not enough candles in ${f} (${world.closes.length}) for train=${trainSize} + test=${testSize}` +
                (intervalFactor > 1 ? ` after resampling by ${intervalFactor}` : ''));
        }
        const folds = walkForwardSplit({ n: world.closes.length, trainSize, testSize });
        if (!folds.length) throw new Error(`analyze: the walk-forward split produced no folds for ${f}`);
        // A full-history split would create thousands of folds (and thousands of
        // model fits). Bound it so the CLI stays usable; pass --bars to widen.
        if (folds.length > 200) {
            throw new Error(`analyze: ${folds.length} folds from ${world.closes.length} candles is too many for one run; pass --bars=<n> (e.g. ${(trainSize + testSize) * 20})`);
        }
        worlds.push({
            label: inputLabels[ii],
            file: f,
            candles: world.candles.length,
            returns: world.returns,
            folds,
            viewFor: makeCandleViewFor(world.candles),
            // The raw candle series, for a worker-backed fold executor (R26-4): the
            // worker rebuilds the same view from it. Reporting uses the `candles`
            // count above, so this field is internal to the driver.
            candleData: world.candles,
            // Round 33 (lab R1): the UNSLICED resampled series for the long-sample
            // readout. Null unless `--history=full` (the default run retains
            // nothing extra); the verdict path always reads the sliced world.
            fullCandles: historyFull ? candles : null,
        });
    }

    // P3 (round 29 -> 30): attach the cross-section to every stream's view, so the
    // cross-sectional reversal candidate (`sig:reversal-xs`) can read the OTHER
    // streams' aligned returns. The alignment is by bar index — the same convention
    // the panel-aware dependence estimates and `streamFoldLengths` already use, and
    // the reason every world is sliced to the same `maxBars`. `panel` also rides on
    // the world so a worker-backed fold can rebuild its view with it.
    {
        const panelLabels = worlds.map((w) => w.label);
        const panelReturns = worlds.map((w) => w.returns);
        worlds = worlds.map((w, i) => {
            const panel = { streamIndex: i, label: w.label, labels: panelLabels, returnsByStream: panelReturns };
            return { ...w, panel, viewFor: makeCandleViewFor(w.candleData, { panel }) };
        });
    }

    // P4 (round 29 -> 30): the funding/carry sleeve. `carryFiles[i]` is the funding
    // series for `worlds[i]`; each contributes the carry earned over that world's
    // fold TEST bars, and the POOLED sleeve (equal weight across symbols) is what the
    // dependence/DSR panel receives — one extra, structurally independent return
    // stream. The price-only dependence is retained beside it
    // (`dependenceWithoutExtras`) so the measured effect of adding it is explicit.
    let extraPanelStreams = null;
    let carryBlock = null;
    if (Array.isArray(carryFiles) && carryFiles.length) {
        const project = (series, folds) => {
            const out = [];
            for (const fold of folds) for (let t = fold.testStart; t <= fold.testEnd; t++) out.push(series[t]);
            return out;
        };
        const parsed = [];
        for (const cf of carryFiles) {
            const text = fs.readFileSync(cf, 'utf8');
            const { rows, invalid, blank } = parseFundingJsonl(text);
            const audit = auditFundingSeries(rows);
            parsed.push({
                file: cf, rows, invalid, blank, audit,
                problems: auditFundingProblems(audit, { label: cf }),
            });
        }
        const streams = [];
        const priceProjected = [];
        for (let i = 0; i < worlds.length; i++) {
            const p = parsed[i % parsed.length];
            if (!p || !p.rows.length) continue;
            const timestamps = (worlds[i].candleData || []).map((c) => c.timestamp);
            streams.push(carryPanelStream({ timestamps, folds: worlds[i].folds, rows: p.rows }));
            priceProjected.push(project(worlds[i].returns, worlds[i].folds));
        }
        const sleeveHasVariance = (() => {
            if (!streams.length) return false;
            const first = streams[0][0];
            for (const s of streams) for (const v of s) if (v !== first) return true;
            return false;
        })();
        if (streams.length === worlds.length && streams[0].length === priceProjected[0].length && sleeveHasVariance) {
            const sleeve = pooledCarry(streams);
            const basket = priceProjected[0].map((_, j) => {
                let acc = 0;
                for (const p of priceProjected) acc += p[j];
                return acc / priceProjected.length;
            });
            extraPanelStreams = [sleeve];
            let sum = 0;
            for (const v of sleeve) sum += v;
            carryBlock = {
                files: carryFiles,
                symbols: parsed.map((p, i) => ({
                    file: p.file, rows: p.rows.length, invalid: p.invalid, blank: p.blank,
                    problems: p.problems,
                    first: p.audit.first, last: p.audit.last, spanDays: p.audit.spanDays,
                    intervalHistogram: p.audit.intervalHistogram,
                    offGrid: p.audit.offGrid, missingPeriods: p.audit.missingPeriods,
                    meanRate: p.audit.meanRate, meanAbsRate: p.audit.meanAbsRate,
                    negativeFraction: p.audit.negativeFraction,
                    symbol: (worlds[i] || {}).label || null,
                })),
                streams: streams.length,
                panelStreams: extraPanelStreams.length,
                pooledMeanRatePerBar: sleeve.length ? sum / sleeve.length : null,
                correlationWithBasket: correlation(sleeve, basket),
                reader: 'the funding/carry sleeve: the funding JSONL files are parsed and audited on the funding grid, each symbol\'s carry is projected over its fold test bars (so the sleeve tiles the same pooled grid the price streams use), and the equal-weight pooled sleeve is appended to every candidate\'s dependence panel. `correlationWithBasket` is the Pearson correlation of the sleeve with the equal-weight price basket over those bars; a candidate\'s `dependence` (with) vs `dependenceWithoutExtras` (price-only) is the measured effect.',
            };
        } else {
            carryBlock = {
                files: carryFiles,
                symbols: parsed.map((p) => ({ file: p.file, rows: p.rows.length, problems: p.problems })),
                streams: streams.length,
                panelStreams: 0,
                unavailable: true,
                reason: !streams.length || streams.length !== worlds.length
                    ? `the carry streams do not cover every price stream (streams=${streams.length}/${worlds.length})`
                    : (streams[0].length !== (priceProjected.length ? priceProjected[0].length : -1)
                        ? `the carry streams do not tile the pooled price grid (length ${streams[0].length} vs ${priceProjected.length ? priceProjected[0].length : 0})`
                        : 'the pooled carry sleeve is constant (zero variance) over the fold test bars — a constant stream carries no information and would make every pairwise correlation undefined, so it is not appended to the dependence panel'),
            };
        }
        for (const p of parsed) if (p.problems.length) log(`carry: ${p.problems.join('; ')}`);
    }

    // Round 26 (R26-6): measure the basket's effective independence (Kish 1965
    // design effect over the streams' own returns) and, when asked, keep only the
    // most diversifying streams — greedy by marginal effective bars per raw bar
    // (Grinold 1989 breadth; the cost law is `time ~= pooledBars x folds-per-stream`,
    // so a redundant stream is pure cost). A DESIGN choice: it changes which streams
    // are pooled, never how an included stream is scored.
    const streamSeriesByLabel = {};
    for (const w of worlds) streamSeriesByLabel[w.label] = w.returns;
    const streamSelectionCandidates = (streamSelectEnabled && worlds.length >= 1)
        ? runStreamSelection({ seriesByLabel: streamSeriesByLabel, maxStreams: Infinity, foldLength: testSize, periodsPerYear: 252 })
        : null;
    if (streamSelectKeep != null && streamSelectionCandidates && streamSelectionCandidates.available && streamSelectionCandidates.order.length) {
        const keep = new Set(streamSelectionCandidates.order.slice(0, streamSelectKeep));
        worlds = worlds.filter((w) => keep.has(w.label));
        if (!worlds.length) throw new Error('analyze: --select-streams kept no streams');
    }
    // The kept basket's own design effect (the "after" half of the report). Null
    // when selection was off or there is a single stream.
    const streamSelection = streamSelectionCandidates
        ? {
            ...streamSelectionCandidates,
            keep: streamSelectKeep,
            kept: worlds.map((w) => w.label),
            keptDesignEffect: worlds.length >= 1
                ? designEffectOfStreams(
                    Object.fromEntries(worlds.map((w) => [w.label, w.returns])),
                    { foldLength: testSize, periodsPerYear: 252 },
                )
                : null,
        }
        : null;

    const variants = variantIds
        ? ['baseline', ...variantIds.filter((id) => id !== 'baseline')].map(resolveVariant)
        : [
            // Round 30: the PRE-REGISTERED default roster (`analyze.js#ALL_VARIANTS`
            // = `lineage.js#DEFAULT_ROSTER_IDS`), so the default run's `K` is 3.
            // `--variants=` still resolves any id in `RESOLVABLE_VARIANTS` (the whole
            // searched universe, including the dropped/parked branches).
            ...ALL_VARIANTS.filter((v) => !v.controllerScoped || useController),
            // Round 26 (R26-11): the opt-in label variants, appended only when asked
            // for (a label change is a training-set change; it must never be silent).
            ...(labelPolicies && useController ? LABEL_VARIANTS : []),
        ];

    const runId = makeRunId({ seed, startedAt });
    const runDir = writeFiles ? createRunDirectory(stateFolder, runId) : null;
    let modelRoot;
    if (runDir) {
        modelRoot = path.join(runDir, 'models');
    } else {
        // Ensure the parent exists before mkdtemp (node's mkdtempSync does not
        // create its parent; `state/` may never have been created in a fresh
        // checkout).
        fs.mkdirSync(stateFolder, { recursive: true });
        modelRoot = fs.mkdtempSync(path.join(stateFolder, 'analyze-models-'));
    }
    const foldsTotal = worlds.reduce((a, w) => a + w.folds.length, 0);
    const probePasses = worlds.reduce((a, w) => a + w.folds.reduce((b, f) => b + probesPerFold(f.test.length, auditProbesPerFold), 0), 0);
    // The event budget the progress line reports against: EVERY variant runs the
    // same per-variant pass set (one scored fold each, plus — when the audit runs
    // — one base pass and `probesPerFold` probes per fold), so the total scales
    // with the roster.
    const eventsTotal = (foldsTotal + (audit ? foldsTotal + probePasses : 0)) * variants.length;
    const totalCandles = worlds.reduce((a, w) => a + w.candles, 0);
    const modelPath = useController ? 'controller' : 'bare';

    if (runDir) {
        fs.mkdirSync(modelRoot, { recursive: true });
        writeJson(runDir, 'run.json', {
            runId, startedAt, seed,
            configFingerprint: configFingerprint(CONFIG),
            type: 'analyze',
            model: modelPath,
            history,
            files: inputs,
            candles: totalCandles,
            streams: worlds.length,
            trainSize, testSize, maxBars,
            folds: foldsTotal,
            variants: variants.map((v) => v.id),
            probe, auditProbesPerFold, requireReachable, reuseBase, minTrainingSteps,
            costBps, modelRetention, foldLog,
            saveInterval: Number.isFinite(saveInterval) ? saveInterval : 'inf',
            labelPolicy,
            labelHorizonBars: Number.isFinite(labelHorizonBars) ? labelHorizonBars : null,
            labelPolicies: !!labelPolicies,
            sampleWeightHorizon: Number.isFinite(sampleWeightHorizon) ? sampleWeightHorizon : null,
            concurrency: width,
            intervalBars: intervalFactor,
            streamSelect: streamSelectKeep != null ? streamSelectKeep : streamSelectEnabled,
            commonRandomNumbers: crn,
            forecast: forecastEnabled,
            decision: decision !== false,
            gate: gateMode, gateAlpha: gateAlphaResolved, costLadder: ladderLevels.slice(),
            turnoverSweep: turnoverEnabled,
            turnoverTarget: turnoverEnabled ? turnoverTargetBps : null,
            trials: variants.length,
            positionPolicy: useController ? POSITION_POLICY : null,
            node: process.version,
        });
    }

    // ---- live state: counters, heartbeat file, stdout line, fold journal -----
    const counters = {
        score: 0, base: 0, probe: 0, events: 0, eventsTotal,
        variantsDone: 0, variantsTotal: variants.length,
    };
    // Round 26 (R26-2): the per-variant model-diagnostics accumulator, filled by
    // every fold's `stats()` as the A/B runs. Populated before a variant's
    // `onVariant` fires (all its folds are done), so the report rows built there
    // carry complete diagnostics.
    const modelStats = new Map();
    const state = {
        phase: 'starting', variantId: null, variantIndex: -1, variantTotal: variants.length,
        stream: null, foldIndex: null, foldTotal: null, lastEventAt: startedAt,
    };
    let lastProgressAt = 0;
    let lastLineAt = 0;
    const progressText = () => ({
        runId, startedAt,
        updatedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        phase: state.phase,
        variant: { id: state.variantId, index: state.variantIndex, total: state.variantTotal },
        stream: { index: state.stream, total: worlds.length },
        fold: { index: state.foldIndex, total: state.foldTotal },
        counters,
        etaMs: counters.events > 0 && counters.eventsTotal > counters.events
            ? Math.round(((Date.now() - startedAt) / counters.events) * (counters.eventsTotal - counters.events))
            : null,
        retention: modelRetention,
        requireReachable,
        reuseBase,
        costBps,
        reader: 'liveness heartbeat: `updatedAt` advancing means the run is progressing; `counters.events/eventsTotal` is the pass budget; `etaMs` is a linear estimate from the passes completed so far.',
    });
    const flushProgress = (force = false) => {
        if (!runDir || progressMs < 0) return;
        const now = Date.now();
        if (!force && progressMs > 0 && now - lastProgressAt < progressMs) return;
        lastProgressAt = now;
        try { writeJsonAtomic(runDir, 'progress.json', progressText()); } catch { /* diagnostics only */ }
    };
    // One greppable stdout line for a human or agent watching a long run: always at
    // a variant boundary (`force`), otherwise at most once per `progressMs`. The
    // `last event` age is the frozen-run tell.
    const reportProgress = (force = false, note = '', extra = null) => {
        if (progressMs < 0) return;
        const now = Date.now();
        if (!force && progressMs > 0 && now - lastLineAt < progressMs) return;
        lastLineAt = now;
        const elapsed = now - startedAt;
        const done = counters.events;
        const pct = counters.eventsTotal ? (100 * done / counters.eventsTotal).toFixed(1) : '0.0';
        const age = state.lastEventAt ? `${((now - state.lastEventAt) / 1000).toFixed(1)}s` : '-';
        log(`[analyze] ${fmtClock(elapsed)} elapsed | variant ${Math.max(1, state.variantIndex + 1)}/${state.variantTotal} ${state.variantId || '-'}` +
            ` | stream ${state.stream == null ? '-' : state.stream + 1}/${worlds.length}` +
            ` | ${state.phase} fold ${state.foldIndex == null ? '-' : state.foldIndex + 1}/${state.foldTotal || '-'}` +
            ` | events ${done}/${counters.eventsTotal} (${pct}%) | last event ${age}${note ? ' | ' + note : ''}`);
        if (force && runDir) appendLog(runDir, 'info', 'progress', { ...counters, phase: state.phase, variantId: state.variantId, ...(extra || {}) });
    };
    // Every scored fold and every audit pass lands here (from `evaluateAB`).
    const onEvent = (event) => {
        if (event.variantId !== state.variantId) {
            state.variantId = event.variantId;
            state.variantIndex = event.variantIndex;
            state.phase = 'score';
            state.foldIndex = null;
            state.foldTotal = null;
        }
        if (event.stream != null) state.stream = event.stream;
        if (event.t === 'fold') {
            counters.score++;
            state.phase = 'score';
            state.foldIndex = event.foldIndex;
            state.foldTotal = event.foldTotal;
        } else if (event.t === 'pass') {
            if (event.stage === 'base') counters.base++; else counters.probe++;
            state.phase = event.stage === 'base' ? 'audit-base' : 'audit-probe';
            // The audit iterates folds too: advance the fold cursor, otherwise the
            // progress line freezes on the last scored fold for the whole audit
            // (measured in the completed smoke run's stdout).
            if (Number.isFinite(event.foldIndex)) {
                state.foldIndex = event.foldIndex;
                state.foldTotal = event.foldTotal;
            }
        }
        counters.events++;
        state.lastEventAt = Date.now();
        if (runDir && foldLog !== 'off' && (foldLog === 'all' || event.t === 'fold')) {
            appendJsonl(runDir, 'folds.jsonl', foldRecord(event));
        }
        reportProgress();
        flushProgress();
    };

    // ---- checkpoints: `partial-report.json` after every variant --------------
    const roster = [];
    const variantTimings = [];
    let baselineBlock = null;
    const candidateRows = [];
    const partialReport = (status, extra = {}) => ({
        version: 1,
        schema: 'nl.analyze.v1',
        type: 'analyze-partial',
        status,
        runId, startedAt, updatedAt: new Date().toISOString(),
        model: modelPath,
        files: inputs, file: inputs[0], streams: worlds.length, candles: totalCandles, folds: foldsTotal,
        trainSize, testSize, maxBars, costBps, seed, probe, auditProbesPerFold, alpha,
        requireReachable, modelRetention, reuseBase, foldLog,
        // R27-5: the config echo is in the FIRST checkpoint, so a kill-and-recover
        // reader never has to guess the run's design (gate, K, throttle, label,
        // concurrency, resampling, CRN, selection, sweep toggles).
        gate: gateMode, gateAlpha: gateAlphaResolved, gateOptions: { ...gateOptions },
        costLadder: ladderLevels.slice(),
        trials: variants.length,
        saveInterval: Number.isFinite(saveInterval) ? saveInterval : 'inf',
        labelPolicy,
        labelHorizonBars: Number.isFinite(labelHorizonBars) ? labelHorizonBars : null,
        concurrency: width,
        intervalBars: intervalFactor,
        commonRandomNumbers: crn,
        streamSelection: streamSelection ? { keep: streamSelectKeep, kept: streamSelection.kept } : null,
        turnoverSweep: turnoverEnabled,
        forecast: forecastEnabled,
        decision: decision !== false,
        minTrainingSteps,
        policyRoundTrip: null,
        positionPolicy: useController ? CONTROLLER_POSITION_POLICY : null,
        power: baselineBlock ? baselineBlock.power : null,
        variantsTotal: variants.length,
        variants: roster,
        timings: variantTimings,
        baseline: baselineBlock,
        candidates: candidateRows,
        familywise: null,
        progress: { ...counters, phase: state.phase, elapsedMs: Date.now() - startedAt },
        artifacts: runDir ? { report: 'report.json', folds: 'folds.jsonl', log: 'run.log', progress: 'progress.json' } : null,
        reader: 'live checkpoint, rewritten after every variant. status: running|complete|failed. Row shapes match report.json. `timings` carries each finished variant\'s wall time, so a running eval can be sized from the checkpoint alone. The measured cost law is `time ~= k * streams * passes * modelVariants * sum_f(testStart_f)` with `k ~= 0.036 s` per history bar replayed, because a model fit warms up by replaying ALL history up to the fold (`analyze.js` fit) - the run is O(n^2) per stream, not linear in bars, so doubling a stream\'s history roughly quadruples its cost (`OPTIMIZATION.md`, `BUGS.md` #31). On status=failed, candidates[] holds every variant that finished and folds.jsonl holds every completed pass, so the science is not lost with the process.',
        ...extra,
    });
    const checkpoint = (status, extra) => {
        if (!runDir) return;
        try { writeJsonAtomic(runDir, 'partial-report.json', partialReport(status, extra)); } catch { /* never fail the run on a checkpoint */ }
    };
    const onVariant = (event) => {
        const entry = event.entry;
        roster.push(variantRosterRow(entry, modelStats));
        if (event.role === 'baseline') {
            baselineBlock = baselineRow({ baseline: entry.report, baselineVariant: entry.variant }, modelStats);
        } else {
            candidateRows.push(candidateRow(entry, event.decision, null, modelStats));
        }
        // Per-variant wall time (round 25, observability). The cost is NOT a fixed
        // per-fit number: `fit()` replays all history through `getSignal` to warm
        // the online controller, so cost/fold grows with the fold index and a run
        // is O(n^2) per stream. Measured: 0.035 s per warm-up call, i.e.
        // `0.035 * sum_f(testStart_f) * streams * passes * mechanismVariants`
        // (docs/RUN-ANALYSIS.md section 4, docs/OPTIMIZATION.md round 25b).
        variantTimings.push({
            id: entry.variant.id,
            kind: entry.variant.kind || 'mechanism',
            role: event.role,
            elapsedMs: entry.elapsedMs ?? null,
            folds: entry.report && entry.report.folds ? entry.report.folds.length : 0,
            streams: entry.streams,
            promote: event.decision ? event.decision.promote : null,
            reasons: event.decision ? event.decision.reasons.length : null,
            skipped: !!entry.skipped,
        });
        counters.variantsDone = roster.length;
        state.variantId = entry.variant.id;
        state.variantIndex = event.index;
        state.phase = 'variant-checkpoint';
        checkpoint('running');
        reportProgress(true, event.role === 'baseline'
            ? `baseline evaluated in ${fmtClock(entry.elapsedMs)}`
            : `${entry.variant.label} ${event.decision && event.decision.promote ? 'PROMOTE' : 'keep-off'}` +
              ` (${event.decision ? event.decision.reasons.length : 0} reasons)` +
              `${Number.isFinite(entry.elapsedMs) ? ` in ${fmtClock(entry.elapsedMs)}` : ''}`,
            // R27-5: the variant checkpoint in run.log names the variant's KIND and
            // its wall time, so a long run's log is self-describing.
            {
                variantId: entry.variant.id,
                kind: entry.variant.kind || 'mechanism',
                role: event.role,
                elapsedMs: Number.isFinite(entry.elapsedMs) ? entry.elapsedMs : null,
                promote: event.decision ? !!event.decision.promote : null,
            });
    };

    const positionPolicy = useController ? POSITION_POLICY : IDENTITY_POSITION_POLICY;
    // Round 26 (R26-2): pool every fold's model diagnostics per variant. The
    // in-process path feeds this from `makeSignalForVariant`'s `onStats`; the
    // parallel path feeds it from the worker's reported `stats` (R26-4).
    const accumulateStats = (variant, s) => {
        const acc = modelStats.get(variant.id) || emptyModelAccumulator(minTrainingSteps);
        mergeModelStats(acc, s);
        modelStats.set(variant.id, acc);
    };
    const factory = useController
        ? makeControllerModelFactory({ HiveMind, HiveMindController, stateDir: modelRoot, seed, modelRetention, saveInterval, labelPolicy, labelHorizonBars, sampleWeightHorizon, commonRandomNumbers: crn })
        : makeHiveMindModelFactory({ HiveMind, stateDir: modelRoot, seed, modelRetention, commonRandomNumbers: crn });
    // P1: a benchmark variant is model-independent (it is a pure forecaster on the
    // shared feature vector), so it is dispatched to its own factory regardless of
    // `--model`. The default path is byte-identical (no benchmark variant in the
    // default roster).
    const benchmarkFactory = makeBenchmarkModelFactory({ seed });
    const selectFactory = (variant) => (variant && variant.benchmark ? benchmarkFactory(variant) : factory(variant));
    const signalForVariant = makeSignalForVariant(selectFactory, {
        // Round 26 (R26-3): ONE confidence->position policy for both families.
        positionPolicy,
        onStats: accumulateStats,
    });

    // Round 26 (R26-4): with `concurrency > 1` each fold-pass is dispatched to a
    // worker that reconstructs the same signal function from the same data, so the
    // positions/confidence/stats are bit-identical and only wall time moves.
    let foldExecutorFor = null;
    if (width > 1) {
        // Resolve the worker URL only when we must spawn it (a caller-supplied
        // `spawnWorker` — the tests — ignores it, and `import.meta.url` is not
        // resolvable in every environment the analysis layer is imported into).
        const workerUrl = spawnWorker ? null : new URL('../../analysis/fold_worker.js', import.meta.url);
        const dispatcher = makeNodeFoldDispatcher({ url: workerUrl, spawn: spawnWorker });
        foldExecutorFor = (variant, si, s) => makeFoldExecutor({
            dispatch: (ctx) => dispatcher({
                variantId: variant.id, model: modelPath, streamIndex: si, foldIndex: ctx.index,
                seed, stateDir: modelRoot, modelRetention,
                cacheSize: CONTROLLER_MODEL.cacheSize, ensembleSize: CONTROLLER_MODEL.ensembleSize,
                tier: CONTROLLER_MODEL.tier, warmup: CONTROLLER_MODEL.warmup,
                positionPolicy, saveInterval, labelPolicy, labelHorizonBars,
                sampleWeightHorizon,
                commonRandomNumbers: crn,
                len: FEATURE_LEN, leaky: false,
                returns: s.returns, candles: s.candleData || null,
                panel: s.panel || null,
                train: ctx.train, test: ctx.test,
            }),
        });
    }

    state.phase = 'evaluating';
    checkpoint('running');
    reportProgress(true, `starting ${variants.length} variants x ${foldsTotal} folds x ${worlds.length} stream(s)${width > 1 ? ` @ concurrency ${width}` : ''}`);

    const t0 = performance.now();
    let result = null;
    let evaluationError = null;
    try {
        result = width > 1
            ? await evaluateABAsync({
                worlds, variants, signalForVariant, foldExecutorFor, onModelStats: accumulateStats, concurrency: width,
                costBps, audit, alpha,
                probe, auditProbesPerFold, model: modelPath, requireReachable, auditReuseBase: reuseBase,
                gateOptions, modelStats, extraPanelStreams,
                onEvent, onVariant,
            })
            : evaluateAB({
                worlds, variants, signalForVariant, costBps, audit, alpha,
                probe, auditProbesPerFold, model: modelPath, requireReachable, auditReuseBase: reuseBase,
                gateOptions, modelStats, extraPanelStreams,
                onEvent, onVariant,
            });
    } catch (err) {
        evaluationError = err;
    }
    const durationMs = performance.now() - t0;

    if (evaluationError) {
        // A crash still leaves the science: every finished variant is in the
        // checkpoint, every completed pass is in folds.jsonl, and the reason is
        // recorded in both the checkpoint and the journal.
        const message = String((evaluationError && evaluationError.message) || evaluationError);
        state.phase = 'failed';
        if (runDir) {
            appendLog(runDir, 'error', 'analyze failed', { message, variantsDone: roster.length, ...counters });
        }
        checkpoint('failed', {
            durationMs,
            timings: variantTimings,
            error: { message, stack: String((evaluationError && evaluationError.stack) || '') },
        });
        flushProgress(true);
        reportProgress(true, `FAILED after ${roster.length}/${variants.length} variants: ${message}`);
        throw evaluationError;
    }

    const familywise = result.search && Array.isArray(result.search.candidates)
        ? {
            spaPValue: result.search.spaPValue,
            best: result.search.bestLabel,
            rejected: result.search.rejectedLabels,
            K: result.search.K,
            T: result.search.T,
            ...(result.search.skipped ? { skipped: true, reason: result.search.reason } : {}),
        }
        : (result.search || null);
    // Round 25: cost ladder + family correlation diagnostic. Both are pure
    // post-processing of the finished reports (no model), so they cannot change
    // the scored numbers — only the amount of the verdict that is stated. R27-1:
    // they cover the ACTIVE candidates only (inactive ones are outside K and the
    // search, so restating a verdict over them would be meaningless).
    const activeCandidates = result.candidates.filter((c) => c.active && c.report && c.report.pooledMetrics);
    const ladderCandidates = activeCandidates.map((c) => ({ ...c.report, id: c.variant.id }));
    const ladder = ladderLevels.length
        ? costLadder({
            baseline: result.baseline,
            candidates: ladderCandidates,
            levels: ladderLevels,
            periodsPerYear: 252,
            trials: result.trials,
            decisionOptions: { requireCleanAudit: audit, ...gateOptions },
        })
        : null;
    const familyCorr = familyCorrelation({
        baseline: result.baseline,
        candidates: activeCandidates.map((c) => c.report),
        periodsPerYear: 252,
        // R28 (BUGS.md #55): the LABELS of exactly the candidates above, in the
        // same order, so `familyCorrelation.maxPair`'s indices resolve against the
        // list the matrix was built from. Resolving them against the FULL candidate
        // list (as `formatAnalysis` used to) names the wrong arms whenever an
        // inactive candidate sits before an active one.
        labels: activeCandidates.map((c) => c.variant.id),
    });
    // Round 26 (R26-3): the journaled raw confidence + the scored policy must
    // reproduce the emitted positions byte-for-byte. That is the precondition for
    // treating a dead-zone/scale sweep as pure post-processing, so it is asserted on
    // every real run rather than assumed.
    const policyRoundTrip = verifyPolicyRoundTrip(result.baseline, useController ? POSITION_POLICY : IDENTITY_POSITION_POLICY);

    // Round 33 (lab R1, F-01/J1): the long-sample readout. Every ACTIVE signal arm
    // scored contiguously over each stream's FULL history (no folds — the F-13
    // equivalence) and pooled as an equal-weight basket at the run's active K.
    // Pure post-processing of the retained candle series (no model), so it cannot
    // move a scored number. Null unless `--history=full`, so the default report
    // is byte-identical.
    const fullHistoryBlock = historyFull
        ? buildFullHistoryBlock({
            fullStreams: worlds.map((w) => ({
                label: w.label,
                closes: (w.fullCandles || []).map((c) => c.close),
                volumes: (w.fullCandles || []).map((c) => c.volume),
            })),
            variants: activeCandidates.map((c) => c.variant),
            trials: result.trials,
            costBps,
        })
        : null;

    // Round 26 (R26-14): score the family as forecasters — proper scores (Brier +
    // reliability/resolution/uncertainty, log score), the Diebold–Mariano test of
    // each candidate's per-bar Brier loss against the baseline, and the Hansen–
    // Lunde–Nason Model Confidence Set over the whole family. Pure post-processing
    // of the journaled confidence, so it cannot move a scored number.
    const forecastBlock = forecastEnabled
        ? forecastComparison({
            baseline: result.baseline.foldInputs,
            baselineKind: forecastKindOf(result.baselineVariant),
            baselineId: result.baselineVariant.id,
            candidates: result.candidates
                .filter((c) => c.active && c.report && Array.isArray(c.report.foldInputs))
                .map((c) => ({ id: c.variant.id, kind: forecastKindOf(c.variant), foldInputs: c.report.foldInputs })),
            seed,
        })
        : null;

    // Round 26 (R26-5): the turnover attack. Which no-trade band (dead zone),
    // entry/exit hysteresis and minimum holding period lowers turnover enough to
    // reach a realistic taker cost, restated from the journaled confidence with no
    // model. Pure post-processing, so it cannot move a scored number — it only
    // adds a row per (candidate, policy) to the report.
    const turnover = turnoverEnabled
        ? runTurnoverSweep({
            baseline: result.baseline,
            candidates: ladderCandidates,
            costBps,
            periodsPerYear: 252,
            trials: result.trials,
            decisionOptions: { requireCleanAudit: audit, ...gateOptions },
            targetBps: turnoverTargetBps,
        })
        : null;

    // Round 29 -> 30 (P2): the configuration-robust promotion sweep. The A/B's
    // LEVEL is a function of the retrain cadence (`RUN-ANALYSIS.md` §15.3), so a
    // single-cadence verdict is a verdict about the configuration as much as about
    // the strategy. When `cadences` is supplied, each ACTIVE candidate is re-scored
    // on every cadence grid with `restateReportAtCadence` (the fixed-position
    // restatement the P2 retrospective used — the model trajectory is held constant
    // and only the fold partition moves, so this is a LOWER bound on the cadence
    // sensitivity), and `promotionAcrossCadences` applies the majority-pass +
    // catastrophic-veto rule. Pure post-processing of the journaled confidence, so
    // it cannot move a scored number. Null unless `--cadences` is given, so the
    // default report is byte-identical.
    let configurationRobust = null;
    if (Array.isArray(cadences) && cadences.length) {
        const cadenceGrid = [...new Set(cadences.map((c) => Number(c)).filter((c) => Number.isFinite(c) && c > 0))].sort((a, b) => a - b);
        const byCandidate = {};
        for (const c of result.candidates) {
            if (!c.active || !c.report || !Array.isArray(c.report.foldInputs) || !c.report.foldInputs.length) continue;
            const evaluations = [];
            for (const ts of cadenceGrid) {
                const bAt = restateReportAtCadence(result.baseline, { testSize: ts, policy: positionPolicy, costBps, periodsPerYear: 252, trials: result.trials });
                const cAt = restateReportAtCadence(c.report, { testSize: ts, policy: positionPolicy, costBps, periodsPerYear: 252, trials: result.trials });
                if (!bAt || !cAt) {
                    evaluations.push({ cadence: ts, available: false, reason: 'the report carries no journaled fold inputs to restate at this cadence' });
                    continue;
                }
                const dec = promoteDecision(bAt, cAt, { requireCleanAudit: audit, ...(c.variant.decision || {}), ...(gateOptions || {}) });
                evaluations.push({
                    cadence: ts,
                    available: true,
                    promote: dec.promote,
                    reasons: dec.reasons,
                    netSharpe: cAt.pooledMetrics.netSharpe,
                    dsrAdjusted: cAt.pooledMetrics.dsrAdjusted,
                    foldWinFraction: dec.foldWinFraction,
                    folds: cAt.cadence ? cAt.cadence.folds : null,
                    panelStreams: cAt.cadence ? cAt.cadence.panelStreams : null,
                });
            }
            byCandidate[c.variant.id] = {
                evaluations,
                promotion: promotionAcrossCadences({
                    evaluations: evaluations.filter((e) => e.available),
                    majorityFraction: 0.5,
                    catastrophic: defaultCatastrophic,
                }),
            };
        }
        configurationRobust = {
            cadences: cadenceGrid,
            majorityFraction: 0.5,
            candidates: byCandidate,
            reader: 'configuration-robust promotion (P2): every active candidate is re-scored on EACH cadence grid (the fixed-position restatement — the model trajectory is held constant and only the fold partition moves, so this is a LOWER bound on the cadence sensitivity) and `promotionAcrossCadences` applies the majority-pass + catastrophic-veto rule. A candidate is configuration-robust only when it promotes at MORE THAN HALF the cadences AND never fails catastrophically (default: a failed look-ahead audit or a negative pooled net Sharpe). Strictly stricter than the single-cadence gate. This is the fixed-position restatement, not a re-train sweep (a full per-cadence re-train is TODO.md 97).',
        };
    }

    // Round 29 -> 30 (P2): exposure matching. The unified position policy is
    // unified in DIMENSION but not in DISTRIBUTION (a controller's |confidence|
    // maxes far below a signal's), so an absolute dead zone is a different filter
    // for each family and a cross-family promotion can be an artefact of one arm
    // abstaining (`BUGS.md` #61). When `exposureMatch` is set, every active
    // candidate is compared with the baseline at a MATCHED in-market share. Null
    // unless the flag is set, so the default report is byte-identical.
    let exposureMatched = null;
    if (exposureMatch) {
        const byCandidate = {};
        for (const c of result.candidates) {
            if (!c.active || !c.report || !Array.isArray(c.report.foldInputs) || !c.report.foldInputs.length) continue;
            byCandidate[c.variant.id] = exposureMatchedPair({
                baseline: result.baseline,
                candidate: c.report,
                policy: positionPolicy,
                costBps,
                periodsPerYear: 252,
                trials: result.trials,
                decisionOptions: { requireCleanAudit: audit, ...(c.variant.decision || {}), ...(gateOptions || {}) },
            });
        }
        exposureMatched = {
            candidates: byCandidate,
            reader: 'matched-exposure comparison (P2): each active candidate is restated against the baseline at a common in-market share (the minimum of the two families\' scored non-zero fractions by default), so the exposure confound is removed. The matched row uses a pointwise dead zone only — a holding band\'s enter/exit are another absolute confidence-space threshold, so a banded match is neither scale-free nor always reachable. A promotion at UNMATCHED exposure can be an artefact of one arm abstaining (BUGS.md #61); the matched row tests the same claim at equal exposure.',
        };
    }

    const candidateReportRows = result.candidates.map((c) => candidateRow(c, c.decision, c.search, modelStats));
    // Round 26 (R26-8): the decision-grade report. A pure composition of the blocks
    // above into the six questions the next cycle asks; it computes no new strategy
    // statistic (the concentration readout restates the already-scored folds with the
    // same `strategyReturns` arithmetic, and `nextRun` reads the measured power). The
    // featured candidate is the promoted one if any, else the best by pooled Sharpe.
    let decisionBlock = null;
    if (decision) {
        const promotable = result.candidates
            .map((c, i) => ({ c, row: candidateReportRows[i] }))
            .filter((x) => x.c.active && x.c.report && x.c.report.pooledMetrics);
        const promoted = promotable.find((x) => x.row.promote);
        // Rank by pooled Sharpe, treating a non-finite one as the floor. Using
        // `x || -Infinity` here would misrank an exactly-zero Sharpe as -Infinity,
        // so a zero-Sharpe candidate would lose to a negative one.
        const poolSharpe = (x) => (Number.isFinite(x.c.report.pooledMetrics.netSharpe) ? x.c.report.pooledMetrics.netSharpe : -Infinity);
        const best = promoted || promotable.slice().sort((a, b) => poolSharpe(b) - poolSharpe(a))[0] || null;
        const featured = best ? best.c.report : null;
        const featuredRow = best ? best.row : null;
        const concentration = featured
            ? foldConcentration({ folds: featured.folds, foldInputs: featured.foldInputs, costBps, periodsPerYear: 252 })
            : null;
        const confidence = featured ? confidencePersistence({ foldInputs: featured.foldInputs }) : null;
        const nextRun = nextRunPlan({
            power: (featured && featured.power) || result.baseline.power || null,
            dependence: featuredRow ? featuredRow.dependence : null,
            candidate: featuredRow,
            levels: ladderLevels,
            periodsPerYear: 252,
            durationMs,
            folds: foldsTotal,
            streams: worlds.length,
            cadence: { trainSize, testSize, folds: foldsTotal },
        });
        // R27-5: the featured row can be a pure signal (no model of its own) while
        // the baseline is a trained controller. Rather than degrade the training
        // question to n/a, report the BASELINE's model diagnostics with an explicit
        // referent, so the answer's owner is never ambiguous.
        const featuredModel = featuredRow ? featuredRow.model : null;
        const baselineModelBlock = summarizeModelStats(modelStats.get(result.baselineVariant.id));
        const modelReferent = (!featuredModel && baselineModelBlock)
            ? { kind: 'baseline', reason: 'the featured row is a pure signal; the referent is the baseline controller' }
            : null;
        // R28 (BUGS.md #55): `labelPolicy` names the policy the REFERENT ran under
        // (a featured label variant reports its own), and `runLabelPolicy` names
        // the run-level flag. On a `label-conservative` run the two differ, and the
        // old single field said `optimistic` beside a conservative model.
        const featuredPolicy = (featuredRow && featuredRow.variant && featuredRow.variant.labelPolicy)
            ? featuredRow.variant.labelPolicy
            : labelPolicy;
        decisionBlock = decisionReport({
            model: featuredModel || (modelReferent ? baselineModelBlock : null),
            modelReferent,
            runMeta: {
                gate: gateMode,
                gateOptions,
                labelPolicy: featuredPolicy,
                runLabelPolicy: labelPolicy,
                labelHorizonBars,
                seed,
                trials: variants.length,
                saveInterval: Number.isFinite(saveInterval) ? saveInterval : 'inf',
                cadence: { trainSize, testSize, folds: foldsTotal },
            },
            baseline: result.baseline,
            candidate: featuredRow,
            concentration,
            confidence,
            nextRun,
            familyCorrelation: familyCorr,
            familywise,
            costLadder: ladder,
            forecast: forecastBlock,
            replication: null,
            positionPolicy: useController ? POSITION_POLICY : IDENTITY_POSITION_POLICY,
        });
    }

    const report = {
        version: 1,
        schema: 'nl.analyze.v1',
        type: 'analyze',
        status: 'complete',
        runId,
        startedAt,
        finishedAt: Date.now(),
        durationMs,
        model: modelPath,
        files: inputs,
        streams: worlds.length,
        file: inputs[0],
        candles: totalCandles,
        folds: foldsTotal,
        trainSize,
        testSize,
        maxBars,
        costBps,
        seed,
        probe,
        auditProbesPerFold,
        alpha,
        requireReachable,
        reuseBase,
        modelRetention,
        foldLog,
        // R26-12: the checkpoint throttle this run used. A number, or 'inf' for
        // "never dump during the run" (the A/B default). It is off the arithmetic
        // path: it changes only when the in-memory ensemble is written to disk.
        saveInterval: Number.isFinite(saveInterval) ? saveInterval : 'inf',
        // Round 26 (R26-11): the label policy this run used, and the triple barrier's
        // horizon (null when unused). A label policy is a training-set change, so
        // which one a run used is part of the result.
        labelPolicy,
        labelHorizonBars: Number.isFinite(labelHorizonBars) ? labelHorizonBars : null,
        // R28 (BUGS.md #58): the fixed sample-weight span horizon this run used, or
        // null when the variant falls back to the label horizon / the measured
        // causal estimate. Part of the result: it decides whether the weighting
        // can act at all.
        sampleWeightHorizon: Number.isFinite(sampleWeightHorizon) ? sampleWeightHorizon : null,
        // Round 26 (R26-4): the fold loop's in-flight width. Off the arithmetic path
        // — it changes only how many fold-passes ran at once.
        concurrency: width,
        gate: gateMode,
        gateAlpha: gateAlphaResolved,
        gateOptions: { ...gateOptions },
        // R27-1: `trials` is K, the ACTIVE roster every DSR was deflated by — not
        // the requested roster. `trialsRoster` is what was asked for, so the two
        // can never be confused.
        trials: result.trials,
        trialsRoster: result.trialsRoster,
        trialsInactive: result.trialsInactive,
        // R27-1: the liveness certificate per candidate (live/inert/duplicate/
        // not-applicable/skipped) and the mechanism counters behind it.
        liveness: result.liveness,
        inactiveCounts: result.inactiveCounts,
        // R27-5: the floor an `underTrainedFolds` count was measured against.
        minTrainingSteps,
        positionPolicy: useController ? POSITION_POLICY : null,
        // Round 26 (R26-3): the byte-for-byte policy round-trip certificate. A
        // policy sweep is only valid if the journaled confidence reproduces the
        // emitted positions at the scored policy.
        policyRoundTrip,
        power: result.baseline.power || null,
        variants: result.variants.map((entry) => variantRosterRow(entry, modelStats)),
        timings: variantTimings,
        baseline: baselineRow(result, modelStats),
        candidates: candidateReportRows,
        familywise,
        // Round 25: the cost ladder (the whole verdict restated at 0/2/5/10 bps of
        // turnover) and the family-correlation diagnostic. Both are pure
        // post-processing of the finished reports — no model, no re-run — so they
        // cannot move a scored number, only the amount of the verdict that is
        // stated. A verdict that flips across the ladder is a verdict about the
        // cost assumption, not about the strategy.
        costLadder: ladder,
        familyCorrelation: familyCorr,
        // Round 26 (R26-5): the turnover attack. Which dead-zone / entry-exit
        // hysteresis / minimum-holding policy lowers turnover enough to clear a
        // realistic taker cost. Null unless `--turnover-sweep`. A grid of pure
        // post-processing of the journaled confidence (no model), so it cannot
        // move a scored number.
        turnoverSweep: turnover,
        turnoverTargetBps: turnoverEnabled ? turnoverTargetBps : null,
        // Round 26 (R26-6): the bar interval the streams were resampled to, and the
        // measured effective-independence of the basket (Kish 1965 design effect
        // over the streams' returns). Design/diagnostic only — no scored number
        // depends on it.
        intervalBars: intervalFactor,
        streamSelection,
        // Round 29 -> 30 (P4): the funding/carry sleeve. Null unless `carryFiles`
        // was supplied. `dependenceWithoutExtras`/`dependence` on each candidate are
        // the measured before/after; this block records the data provenance, the
        // sleeve's cost-free carry and its correlation with the price basket.
        carry: carryBlock,
        // Round 29 -> 30 (P2): the configuration-robust promotion sweep and the
        // exposure-matched cross-family comparison. Both are pure post-processing
        // of the journaled confidence (no model, no re-run). Null unless
        // `--cadences` / `--exposure-match` was given.
        configurationRobust,
        exposureMatched,
        // Round 26 (R26-13): whether the variant comparison was paired on the
        // random draws (common random numbers). Default true; `false` restores the
        // historical per-variant seed.
        commonRandomNumbers: crn,
        // Round 26 (R26-14): the forecast-comparison block (proper scores per
        // variant, DM vs baseline, and the family Model Confidence Set). Null when
        // disabled. Pure post-processing of the journaled confidence.
        forecast: forecastBlock,
        // Round 26 (R26-8): the decision-grade report. Six blocks (training / edge /
        // concentration / economics / family / nextRun), each answering one question
        // the next cycle asks, with every field a value or an explicit
        // { available:false, reason }. Null when `--decision=0`.
        decisionEnabled: decision !== false,
        decision: decisionBlock,
        // Round 33 (lab R1): the long-sample readout beside the verdict (null
        // unless `--history=full`). A diagnostic column, not a second gate.
        history,
        fullHistory: fullHistoryBlock,
        progress: { ...counters, phase: 'complete', elapsedMs: durationMs },
        artifacts: runDir
            ? { folds: 'folds.jsonl', log: 'run.log', progress: 'progress.json', partial: 'partial-report.json' }
            : null,
        reader: `canonical verdict. Per candidate: \`promote\` + \`reasons\` + \`pooledMetrics\` (incl. \`grossPnl\` and \`breakEvenCostBps\` = the per-unit-turnover cost in bps at which the gross edge is exactly consumed, so a high-turnover signal can be compared to a low-turnover mechanism on one axis) + \`audit\` (clean/reachable/reachableFolds/probes/viewDiffers/baseReused) + \`search\` (family-wise) + round-25 blocks: \`dependence\` (delete-one-cluster jackknife SE over fold-window clusters, design effect, effective bars, equicorrelation reading; null on a single stream), \`promotionTest\` (paired cluster Sharpe-difference t(C-1) + exact sign test over fold windows) and \`gate\` (which hurdles were APPLIED vs SKIPPED-no-panel). The run-level \`power\` block carries the pooled Sharpe SE/MDE, an \`underpowered\` flag (MDE95 above 1.0: a null verdict that could not detect Sharpe 1 is uninformative) and \`barsToDetect1\`; \`power.seDependent\`/\`mdeSharpeDependent\` are the same numbers under the cluster jackknife. \`trials\` (top-level and per candidate) is K, the searched-roster size every DSR was deflated by. \`timings\` records each variant's wall time; the measured cost law is \`time ~= k * streams * passes * modelVariants * sum_f(testStart_f)\` with \`k ~= 0.036 s\` per history bar replayed (a model fit warms up by replaying all history up to the fold, so per-fold cost grows with the fold index - the run is O(n^2) per stream, not linear in bars). \`costLadder\` restates the entire verdict at each cost level in bps of turnover; \`familyCorrelation\` reports how correlated the candidates' excess returns were (a diagnostic only — the deflated Sharpe deliberately keeps trials=K); \`turnoverSweep\` (null unless \`--turnover-sweep\`) restates the journaled confidence under a dead-zone x entry/exit-hysteresis x minimum-holding grid and names the policy with the highest break-even cost, so the economic ceiling can be attacked offline (no model, no re-run); \`streamSelection\` (null unless \`--select-streams\`) measures the basket's Kish design effect over the streams' own returns and reports the greedy most-diversifying order — with \`keep\` set it also names the kept basket and its design effect — and \`intervalBars\` is the resampling factor every stream was built at (1 = the raw bars). \`commonRandomNumbers\` says whether the variant comparison was paired on the random draws (R26-13 common random numbers; default true). \`folds.jsonl\` holds one line per fold-pass (source: stage=score|base|probe, probeIndex for the probe bar, the pass's bar indices, emitted positions, realised returns and metrics), so the pooled metrics AND the audit can be recomputed offline; \`run.log\` is the event journal; \`progress.json\` is the liveness heartbeat. \`configurationRobust\` (present only with \`--cadences\`) is the P2 configuration-robust promotion sweep: every active candidate re-scored on each cadence grid with \`restateReportAtCadence\` (fixed-position, no model) plus the majority-pass + catastrophic-veto verdict from \`promotionAcrossCadences\`. \`exposureMatched\` (present only with \`--exposure-match\`) is the P2 matched-in-market-share comparison of each active candidate against the baseline (\`exposureMatchedPair\`). Both are null unless their flag is set.`,
        summary: formatAnalysis(result, { gate: { mode: gateMode, alpha: gateAlphaResolved }, costLadder: ladder, familyCorrelation: familyCorr, turnoverSweep: turnover, streamSelection, intervalBars: intervalFactor, commonRandomNumbers: crn, forecast: forecastBlock, decision: decisionBlock, fullHistory: fullHistoryBlock, model: modelStats }),
    };

    state.phase = 'complete';
    if (runDir) {
        writeReport(runDir, report);
        checkpoint('complete', {
            durationMs,
            familywise: report.familywise,
            gate: report.gate,
            // R27-1/R27-5: the trial accounting, the liveness certificate and the
            // policy round-trip certificate ride along in the final checkpoint too.
            trials: report.trials,
            trialsRoster: report.trialsRoster,
            trialsInactive: report.trialsInactive,
            inactiveCounts: report.inactiveCounts,
            liveness: report.liveness,
            policyRoundTrip: report.policyRoundTrip,
            costLadder: report.costLadder,
            familyCorrelation: report.familyCorrelation,
            timings: report.timings,
            history: report.history,
            fullHistory: report.fullHistory,
            summary: report.summary,
            decision: report.decision,
            finishedAt: report.finishedAt,
            progress: report.progress,
        });
        appendLog(runDir, 'info', 'analyze complete', {
            candidates: report.candidates.length, variants: roster.length,
            durationMs, folds: foldsTotal, ...counters,
        });
        // An empty `models/` is noise once every fit has been reclaimed.
        if (modelRetention === 'discard') {
            try {
                const empty = typeof fs.readdirSync === 'function'
                    && typeof fs.existsSync === 'function'
                    && fs.existsSync(modelRoot)
                    && fs.readdirSync(modelRoot).length === 0;
                if (empty) fs.rmSync(modelRoot, { recursive: true, force: true });
            } catch { /* ignore */ }
        }
    }
    flushProgress(true);
    reportProgress(true, 'complete');

    return { runDir, report, result, durationMs };
}
