// Analysis fold worker (round 26, R26-4).
//
// One worker runs ONE fold-pass: it reconstructs the same signal function the
// serial driver would build (`resolveVariant` + the same model factory + the same
// `positionPolicy`), decides the test bars from the same candle/return view, and
// posts the positions, the raw pre-policy confidence and the fold's model
// diagnostics back. Because the per-fold seed is `(seed + testStart·977)` under
// common random numbers (R26-13) — or `(variantSeed + testStart·977)` when CRN is
// off — plus `+7777` for predict, and depends only on the master seed, the variant
// id (CRN off only) and `testStart`, the worker's arithmetic is bit-identical to the
// in-process path — which is what makes `folds.jsonl` byte-identical serial vs
// parallel.
//
// The worker creates its own temporary state directory and discards it
// (`modelRetention: 'discard'`), so two folds can never share state. The process
// is single-use: it is spawned, run once, and terminated by `runWorkerThread`.

import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import HiveMind from '../hivemind/hiveMind.js';
import HiveMindController from '../hivemind/hiveMindController.js';
import { resolveVariant, makeSignalForVariant, makeControllerModelFactory, makeHiveMindModelFactory, makeBenchmarkModelFactory } from '../analyze.js';
import { makeCandleViewFor } from './world.js';

const req = workerData;
try {
    const variant = resolveVariant(req.variantId);
    // A unique per-fold state directory, so two folds can never share state and a
    // `--keep-models` run keeps its fits where the serial run would put them (under
    // the run's `models/` root). Falls back to a temp dir when no root is given.
    const stateDir = req.stateDir
        ? path.join(req.stateDir, `${variant.id}-s${req.streamIndex}-f${req.foldIndex}`)
        : fs.mkdtempSync(path.join(os.tmpdir(), 'nl-fold-'));
    fs.mkdirSync(stateDir, { recursive: true });
    const view = req.candles ? makeCandleViewFor(req.candles, { panel: req.panel || null })(req.returns, null) : { returns: req.returns };
    const factoryOptions = { HiveMind, stateDir, seed: req.seed, modelRetention: req.modelRetention || 'discard', commonRandomNumbers: req.commonRandomNumbers !== false };
    const factory = req.model === 'controller'
        ? makeControllerModelFactory({
            ...factoryOptions, HiveMindController,
            cacheSize: req.cacheSize, ensembleSize: req.ensembleSize, tier: req.tier, warmup: req.warmup,
            positionPolicy: req.positionPolicy, saveInterval: req.saveInterval,
            labelPolicy: req.labelPolicy, labelHorizonBars: req.labelHorizonBars,
            sampleWeightHorizon: req.sampleWeightHorizon,
        })
        : makeHiveMindModelFactory({ ...factoryOptions, len: req.len, leaky: req.leaky });
    // P1: a benchmark variant is model-independent; dispatch it to its own factory.
    // `selectFactory` must be a FUNCTION of the variant — the same shape the serial
    // driver passes to `makeSignalForVariant` (which invokes it once per fold). It is
    // NOT the pre-built model: calling `factory(variant)` here and handing the model
    // to `makeSignalForVariant` makes it invoke the model object as a factory and
    // throws "factory is not a function".
    const benchmarkFactory = makeBenchmarkModelFactory({ seed: req.seed, len: req.len });
    const selectFactory = (v) => (v && v.benchmark ? benchmarkFactory(v) : factory(v));
    let captured = null;
    const fold = makeSignalForVariant(selectFactory, {
        positionPolicy: req.positionPolicy,
        onStats: (_variant, stats) => { captured = stats; },
    })(variant);
    const positions = fold(req.train, req.test, view);
    const confidence = typeof fold.confidenceForFold === 'function' ? fold.confidenceForFold() : null;
    parentPort.postMessage({ positions, confidence, stats: captured });
} catch (err) {
    parentPort.postMessage({ error: err && err.message ? err.message : String(err) });
}
