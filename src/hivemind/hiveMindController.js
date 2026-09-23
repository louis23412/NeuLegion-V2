import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';

import HiveMind from './hiveMind.js';
import IndicatorProcessor from './indicatorProcessor.js';

import { truncateToDecimals, isValidNumber, isValidTimestamp } from './utils.js';
import { priceDecimals } from '../price_precision.js';
import { sanitizeSignal, assertControllerArgs } from '../legion/sanitize.js';
import { installMethods } from './internal/mixins.js';
import { controllerDatabaseMethods } from './controller/database.js';
import { controllerAccuracyMethods } from './controller/accuracy.js';
import { controllerCandleMethods } from './controller/candles.js';
import { controllerFeatureMethods } from './controller/features.js';
import { controllerTradeMethods } from './controller/trades.js';

class HiveMindController {
    _hivemind;
    _indicators;
    _db;
    _config;

    _globalAccuracy = { 
        trainingSteps : 0, 
        skippedDuplicate : 0,
        // Rows whose stored JSON could not be parsed are counted and skipped
        // rather than throwing inside the worker (ROADMAP P0-1).
        quarantinedRows : 0,

        wins : 0,
        losses : 0,
        total : 0,
        totalPoints : 0,
        realPoints : 0,

        // Label lifecycle (round 26, R26-2 / BUGS.md #36/#37): the resolved-barrier
        // split and the Brier components of every *scored* closed trade, so a
        // model's accuracy can be referenced to the label base rate. Counted over
        // the same rows as `total` (`confidence >= 0`), so the skill score and the
        // base rate share a sample. A trade resolved at the take-profit has
        // `outcome === 1`; the stop, `outcome === 0`.
        resolvedTakeProfit : 0,
        resolvedStopLoss : 0,
        brierSum : 0,
        brierCount : 0,

        // Candles rejected by the OHLCV validity filter (round 26, R26-1 suspect
        // 8): a malformed bar is counted rather than silently skipped. Per-call
        // observations, so the same malformed bar in two windows counts twice.
        droppedCandles : 0,

        // Label lifecycle, part 2 (round 26, R26-11 / BUGS.md #36): how trades
        // resolved under the label policy — a time barrier, and the entry-to-close
        // holding distribution — so the FIFO drain's lag and the "never expires a
        // trade" defect are visible rather than inferred. `resolvedTimeBarrier`
        // counts every time-barrier closure (including rows with `confidence < 0`,
        // which are not in `total`); `heldBars*` cover every closed trade.
        resolvedTimeBarrier : 0,
        heldBarsSum : 0,
        heldBarsCount : 0,
        heldBarsMax : 0,
        // A duplicate-timestamp (or otherwise failed) open-trade write (R26-0).
        // In-memory only: not persisted, not part of the signal payload.
        openTradeWriteErrors : 0,

        memoriesSent : 0,
        memoriesReceived : 0
    }

    _cacheSize;
    _inputSize;
    _trainingCandleSize;
    _trainingIndicators;

    _controllerID;
    _directoryPath;
    _ensembleSize;
    _type;
    _tier;
    _forceMin;
    _shouldDumpState;
    _memoryBroadcast;
    _lastSaveStatus;
    // State-persistence interval, in `getSignal` calls (round 26, R26-12).
    // `1` (default) dumps on every call, exactly as before — so the golden
    // fingerprints are unchanged. A larger value trades crash-recovery
    // granularity for throughput: `HiveMind.dumpState()` rewrites the ENTIRE
    // ensemble state (weights, gradient accumulators, every memory prototype) to
    // SQLite, measured at ~25% of per-call time, and the A/B never reads the
    // saved state back, so it sets `Infinity` (see `makeControllerModelFactory`).
    // This only affects when the state is written; `_saveState` does not mutate
    // the model, so the emitted signals/positions are identical at any interval.
    _saveInterval = 1;
    _saveTicks = 0;
    // Sample-uniqueness-weighted training (Lopez de Prado ch. 4, see
    // training/sample_weights.js). null (default) disables it: every closed
    // trade trains with weight 1, exactly as before, so the golden fingerprints
    // are unchanged. Two opt-in modes:
    //   * legacy batch-local: `{ horizonBars, intervalMs?, ...weightConfig }`;
    //   * causal streaming window (R27-3): `{ mode: 'causal-window', windowBars,
    //     horizonBars, intervalMs?, ...weightConfig }`, with `_sampleWeightRing`
    //     holding the recent observed entry spans.
    // `_sampleWeightStats` accumulates the weight statistics the A/B reports, so
    // an all-ones (inert) weighting is visible rather than inferred.
    _sampleWeightConfig = null;
    _sampleWeightRing = null;
    _sampleWeightEpochMs = null;
    _sampleWeightStats = null;
    // R28 (BUGS.md #54/#58): the causal span estimator and the emitted-stream
    // normaliser. `_sampleWeightHeldBars` maps a closed trade's timestamp to its
    // realized holding period (recorded at close by `_updateOpenTrades`);
    // `_sampleWeightHeldBarsEma` is the EMA of the holding periods of the trades
    // DRAINED SO FAR, i.e. the only causal estimate of the label span available
    // when a new label's weight is computed (using the label's own holding period
    // would make its weight depend on its own future). `_sampleWeightNormalizer`
    // removes the emitted stream's scale drift. All three are only created when
    // `_sampleWeightConfig` is set, so the default path allocates nothing.
    _sampleWeightHeldBars = null;
    _sampleWeightHeldBarsEma = null;
    _sampleWeightNormalizer = null;
    // R28: an explicit sample-weight span horizon (set by the A/B from
    // `--sample-weight-horizon`); null = the variant decides (label horizon, else
    // the causal measured estimate).
    _sampleWeightHorizon = null;

    // Trade-label policy (round 26, R26-11 / BUGS.md #36). `'optimistic'`
    // (default) is the historical behaviour — a bar that spans both barriers is
    // booked as a win, a gapped stop fills at the stop price, and a trade that
    // never triggers a barrier is never closed — so every golden fingerprint is
    // untouched. `'conservative'` resolves a both-barrier bar to the STOP
    // (stop-first) and fills a gapped stop at the bar's worst traded price.
    // `'triple'` is conservative plus a time barrier at `_labelHorizonBars`
    // (the third barrier of the triple-barrier label, Lopez de Prado 2018 ch. 3).
    // The A/B exposes these as opt-in variants (`analyze.js#LABEL_VARIANTS`).
    _labelPolicy = 'optimistic';
    _labelHorizonBars = null;

    constructor ( id, dp, cs, es, type, tier, priceObj, forceMin = false ) {
        assertControllerArgs({ dp, cs, es, type, tier, priceObj });

        this._controllerID = id;

        try {
            this._directoryPath = dp;
            fs.mkdirSync(this._directoryPath, { recursive: true });
        } catch (err) {
            // Throw, never process.exit: the worker catches this, posts an error
            // and batch.js isolates the slot (ROADMAP P0-1). process.exit here
            // used to abort the entire run.
            throw new Error(`Unable to create directory path "${this._directoryPath}": ${err.message}`);
        }

        this._type = type;
        this._tier = tier;
        this._cacheSize = cs;
        this._ensembleSize = es;

        this._chooseDimension();

        this._config = priceObj;
        this._forceMin = forceMin;

        this._indicators = new IndicatorProcessor();
        this._db = new Database(path.join(this._directoryPath, `hivemind_controller-${this._type}-${this._controllerID}.db`), { fileMustExist: false });
        this._db.pragma('journal_mode = WAL');
        this._db.pragma('synchronous = NORMAL');
        this._db.pragma('temp_store = MEMORY');
        this._db.pragma('cache_size = -32000');

        this._initDatabase();
        this._loadGlobalAccuracy();
    }

    getSignal (candles, processCount = 1, bcR = 0.025, injR = 0.025, sharedMemories = [], childMemories = []) {
        const { error, recentCandles, fullCandles } = this._getRecentCandles(candles);

        if (error) return { error };

        // R27-4b (BUGS.md #49): the cached WINDOW (`fullCandles`, already computed
        // above) is the true time axis for the holding period and the vertical
        // barrier; `recentCandles` (the newly-inserted bars) is what the barrier
        // FILL loop runs over, so the optimistic/conservative positions and the
        // golden fingerprints are unchanged.
        this._updateOpenTrades(recentCandles, fullCandles);

        const indicators = this._indicators.compute(fullCandles);

        if (indicators.error) return { error: 'Indicators error' };

        const features = this._extractFeatures(indicators, childMemories);

        const entryPrice = indicators.lastClose;

        const direction = this._type === 'positive' ? 1 : (this._type === 'negative' ? -1 : 0);

        const atr = isValidNumber(indicators.lastAtr) && indicators.lastAtr > 0
            ? indicators.lastAtr
            : Math.max(entryPrice * 0.01, 1e-8);

        const tpRawDistance = this._config.atrFactor * atr;
        const slRawDistance = this._config.stopFactor * atr;

        const minDelta = entryPrice * this._config.minPriceMovement;
        const maxDelta = entryPrice * this._config.maxPriceMovement;

        const tpDistance = Math.min(Math.max(tpRawDistance, minDelta), maxDelta);
        const slDistance = Math.min(Math.max(slRawDistance, minDelta), maxDelta);

        // The target grid must be fine relative to the instrument's price scale,
        // otherwise rounding flips a target across the entry price (see
        // src/price_precision.js). Derived from the price + minimum movement
        // rather than hardcoded, so any symbol (including sub-cent pairs) keeps
        // its direction; prices >= $10 keep the historical 2 dp.
        const priceDp = priceDecimals(entryPrice, { minMovement: this._config.minPriceMovement });

        const sellPrice = truncateToDecimals(entryPrice + direction * tpDistance, priceDp);
        const stopLoss = truncateToDecimals(entryPrice - direction * slDistance, priceDp);

        const insertTradeStmt = this._db.prepare(`
            INSERT INTO open_trades (timestamp, sellPrice, stopLoss, entryPrice, features, confidence)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        let prediction = -1;
        this._shouldDumpState = false;
        if (this._globalAccuracy.trainingSteps > 0) {
            if (!this._hivemind) {
                this._hivemind = new HiveMind(this._directoryPath, this._ensembleSize, this._inputSize, this._controllerID, this._forceMin);
            }

            const predictionVal = this._hivemind.predict(features);
            // R27-4 (BUGS.md #46): `prob` is used only when it is FINITE and
            // >= 0. An invalid input now returns NaN (not the legal-looking 0), so
            // a degraded bar abstains via the -1 sentinel rather than being read as
            // a maximal short. A non-finite (or negative) value must never reach the
            // NOT NULL `confidence` column (ROADMAP P0-1).
            prediction = (isValidNumber(predictionVal) && predictionVal >= 0) ? Number((predictionVal * 100).toFixed(3)) : -1;

            this._shouldDumpState = true;
        }
        
        if (recentCandles.length > 0) {
            // A duplicate timestamp cannot be inserted (`open_trades.timestamp` is
            // a PRIMARY KEY), and a data glitch must not throw out of `getSignal`
            // and abort the batch (round 26, R26-0): count it, warn, and continue
            // without the trade. The counter is in-memory only (not persisted, not
            // part of the signal payload), so the golden fingerprints are
            // unaffected.
            try {
                insertTradeStmt.run(
                    recentCandles.at(-1).timestamp,
                    sellPrice,
                    stopLoss,
                    entryPrice,
                    JSON.stringify(features),
                    prediction
                );
            } catch (err) {
                this._globalAccuracy.openTradeWriteErrors = (this._globalAccuracy.openTradeWriteErrors || 0) + 1;
                console.warn(`[isolated] could not open a trade at ${recentCandles.at(-1).timestamp}: ${err.message}`);
            }
        }

        this._processClosedTrades(processCount);

        let memoryChange = 0;
        let memoriesInjected = 0;
        let currentMemories = 0;
        let memoriesPerMember = 0;
        if (this._shouldDumpState && this._hivemind) {
            this._memoryBroadcast = this._hivemind.broadcastMemory(features, bcR);
            this._globalAccuracy.memoriesSent += this._memoryBroadcast.totalBroadcast;

            const translation = this._hivemind.translateMemory(sharedMemories, features, injR);
            this._globalAccuracy.memoriesReceived += translation.memoriesInjected;

            memoryChange = translation.injectedRatio;
            memoriesInjected = translation.memoriesInjected;
            currentMemories = translation.totalMemories;
            memoriesPerMember = translation.protosPerMember;

            // Checkpoint throttling (round 26, R26-12): `_saveInterval = 1`
            // (default) dumps every call — bit-identical to the previous
            // behaviour — a finite `k > 1` dumps every k-th call, and
            // `Infinity`/`0`/negative never dumps during the run. The in-memory
            // ensemble is authoritative (nothing reloads mid-run) and `_saveState`
            // does not mutate the model, so the emitted signal is the same at any
            // interval; only the wall clock and the crash-recovery granularity
            // change. The A/B therefore sets `Infinity` (the saved state is never
            // read back there).
            this._saveTicks++;
            // Floor to an integer interval; a non-finite interval (Infinity) never
            // matches the modulo, and a non-positive one is disabled explicitly.
            const saveInterval = Number.isFinite(this._saveInterval) ? Math.floor(this._saveInterval) : Infinity;
            const shouldSave = saveInterval > 0 && (this._saveTicks % saveInterval === 0);
            if (shouldSave) this._lastSaveStatus = this._hivemind.dumpState();
        }

        const tradesStmt = this._db.prepare(`SELECT timestamp FROM open_trades`);
        const openSimulations = tradesStmt.all().length;

        const closedTradesStmt = this._db.prepare(`SELECT timestamp FROM closed_trades`);
        const pendingClosedTrades = closedTradesStmt.all().length;

        let tradeWinAcc = 0;
        let trueAcc = 0;
        let finalScore = 0;
        if (this._globalAccuracy.total > 0) {
            tradeWinAcc = Number(((this._globalAccuracy.wins / this._globalAccuracy.total) * 100).toFixed(3));
            trueAcc = Number(((this._globalAccuracy.realPoints / this._globalAccuracy.totalPoints) * 100).toFixed(3));
            finalScore = this._globalAccuracy.trainingSteps > 0 ? Number(((tradeWinAcc + trueAcc) / 2).toFixed(3)) : 0;
        }

        this._saveGlobalAccuracy();

        // Final boundary: every scalar numeric field is finite before the
        // signal is persisted / aggregated / broadcast. No-op for a clean
        // signal, so the golden fingerprints are unchanged (ROADMAP P0-1).
        const signal = sanitizeSignal({
            controllerId : this._controllerID,
            hiveConnection : this._hivemind ? true : false,
            lastSaveStatus : this._lastSaveStatus ? this._lastSaveStatus.status : this._lastSaveStatus,

            pop : this._ensembleSize,
            cache : this._cacheSize,

            inputSize : this._inputSize,
            candlesUsed : this._trainingCandleSize,
            indicatorsUsed : this._trainingIndicators,

            atrFactor : this._config.atrFactor,
            stopFactor : this._config.stopFactor,
            minPriceMovement : Number((this._config.minPriceMovement * 100).toFixed(3)),
            maxPriceMovement : Number((this._config.maxPriceMovement * 100).toFixed(3)),

            entryPrice,
            sellPrice,
            stopLoss,

            lastTrainingStep : this._globalAccuracy.trainingSteps,
            skippedTraining : this._globalAccuracy.skippedDuplicate,
            openSimulations,
            pendingClosedTrades,

            prob : prediction,
            score : finalScore,
            tradeAcc : tradeWinAcc,
            trueAcc,

            totalMemoriesSent : this._globalAccuracy.memoriesSent,
            totalMemoriesReceived : this._globalAccuracy.memoriesReceived,
            lastMemoriesInjected : memoriesInjected,
            lastMemoryChange : memoryChange,
            lastMemoriesPerMember : memoriesPerMember,
            currentMemories,

            memoryBroadcast : this._memoryBroadcast
        });

        // Run-integrity diagnostic (ROADMAP P0-1): the number of corrupt rows
        // this controller has quarantined. Attached NON-ENUMERABLY so it does
        // not change the signal's serialised payload — the golden fingerprints
        // hash that payload (via Object.keys/canonical JSON), which must stay
        // byte-identical. Only defined when nonzero, so a clean signal carries
        // no extra property at all. `worker.js` reads it and posts it
        // alongside the signal (structured clone would drop a non-enumerable
        // property anyway, which is exactly the behaviour we want).
        if (this._globalAccuracy.quarantinedRows > 0) {
            Object.defineProperty(signal, 'quarantinedRows', {
                value: this._globalAccuracy.quarantinedRows,
                enumerable: false,
                configurable: true,
            });
        }
        // The same non-enumerable diagnostic for the round-26 counters (R26-1
        // dropped candles, R26-0 failed open-trade writes). Only defined when
        // nonzero, so a clean signal carries no extra property and the golden
        // payload (which hashes enumerable keys) is untouched.
        for (const [key, value] of [
            ['droppedCandles', this._globalAccuracy.droppedCandles],
            ['openTradeWriteErrors', this._globalAccuracy.openTradeWriteErrors],
        ]) {
            if (value > 0) {
                Object.defineProperty(signal, key, { value, enumerable: false, configurable: true });
            }
        }

        return signal;
    }

    // Write the in-memory ensemble state to disk now, regardless of
    // `_saveInterval` (round 26, R26-12). `getSignal` throttles the per-call
    // checkpoint; this is the explicit "final flush" a caller uses when it does
    // want the on-disk state to reflect the last call (e.g. an A/B fold run with
    // the state kept for forensics). It is a no-op before the mind exists and
    // never mutates the model, so it cannot move an emitted signal.
    flushState () {
        if (!this._hivemind) return null;
        this._lastSaveStatus = this._hivemind.dumpState();
        return this._lastSaveStatus;
    }
}

// The controller-side helper methods used to live in this class body. They are
// now split across ./controller/* (see src/README.md) and installed onto the
// prototype here, in one place, so the class stays a readable shell: fields,
// constructor, and the public getSignal()/flushState() API.
for (const methods of [
    controllerDatabaseMethods,
    controllerAccuracyMethods,
    controllerCandleMethods,
    controllerFeatureMethods,
    controllerTradeMethods
]) {
    installMethods(HiveMindController, methods);
}

export default HiveMindController;
