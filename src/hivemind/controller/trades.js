// HiveMindController component: controller open/closed trade accounting
//
// Split out of the monolithic src/hivemind/hiveMindController.js; the method
// bodies are byte-identical. Installed onto HiveMindController.prototype by
// ../internal/mixins.js. The controller keeps only its fields, constructor and
// the public getSignal() in the class body.

import crypto from 'crypto';
import HiveMind from './../hiveMind.js';
import { isValidNumber, isValidTimestamp } from './../utils.js';
import { spanWeightsFromEntries, causalWindowWeight, emittedWeightNormalizer } from './../training/sample_weights.js';

export const controllerTradeMethods = {
    _updateOpenTrades (candles, windowCandles = null) {
        if (!Array.isArray(candles) || candles.length === 0) return;

        // Entry-timestamp guard (round 26, R26-0 / BUGS.md #33).
        //
        // A trade may only be closed by a bar strictly AFTER its entry: without
        // this, a caller that supplies an over-wide or out-of-order window (the
        // A/B's old whole-prefix shape) closes trades on bars that predate them,
        // which mislabels the training stream. Production feeds exactly one new
        // candle per call, so the guard is a no-op there; a candle or a trade
        // whose timestamp cannot be ordered falls back to the old scan rather
        // than silently freezing the book. One Date.parse per candle and per open
        // trade, both lists tiny.
        const candleTimes = candles.map((c) =>
            (c && isValidTimestamp(c.timestamp)) ? Date.parse(c.timestamp) : NaN);

        // Elapsed-bar measurement (round 27, R27-4b / BUGS.md #49).
        //
        // `barsAfterEntry` used to be a loop counter over the `candles` argument,
        // which in production is the single newly-inserted bar (`_getRecentCandles`
        // returns `recentCandles` = new bars only). So it was ALWAYS 1: `heldBars`
        // had zero variance and the `triple` vertical barrier
        // (`barsAfterEntry >= horizonBars`) could never fire for horizonBars > 1.
        // The TRUE elapsed count is measured against the cached WINDOW the model
        // holds (`fullCandles`, which `getSignal` already computes and now passes
        // in as the second argument). The barrier FILL loop stays over the new
        // bars, so the optimistic/conservative arithmetic and the golden
        // fingerprints are untouched; only the diagnostic and the vertical barrier
        // become real.
        const window = (Array.isArray(windowCandles) && windowCandles.length > 0) ? windowCandles : candles;
        const windowTimes = window.map((c) =>
            (c && isValidTimestamp(c.timestamp)) ? Date.parse(c.timestamp) : NaN);
        const windowIndexByTime = new Map();
        for (let wi = 0; wi < windowTimes.length; wi++) {
            const wt = windowTimes[wi];
            if (Number.isFinite(wt) && !windowIndexByTime.has(wt)) windowIndexByTime.set(wt, wi);
        }
        // Strictly-after-entry window bars cannot exceed `cacheSize - 1` while the
        // entry bar still occupies a cache slot; an entry that has scrolled out is
        // capped, and the cap is what the report states.
        const heldBarsCap = (Number.isFinite(this._cacheSize) && this._cacheSize > 1) ? this._cacheSize - 1 : null;
        // Number of window bars whose timestamp is <= t (binary search; the window
        // is ORDER BY timestamp ASC). The closing bar's window index minus this,
        // plus one, is the true elapsed-bar count.
        const windowBarsUpTo = (t) => {
            let lo = 0, hi = windowTimes.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (Number.isFinite(windowTimes[mid]) && windowTimes[mid] <= t) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        };

        const tradesStmt = this._db.prepare(`
            SELECT timestamp, sellPrice, stopLoss, entryPrice, features, confidence
            FROM open_trades
        `);
        const trades = tradesStmt.all();

        const closedTrades = [];

        // Label policy (round 26, R26-11 / BUGS.md #36). 'optimistic' is the
        // historical two-barrier rule (TP tested first, stop fills at the stop
        // price, no expiry); 'conservative' resolves a both-barrier bar to the stop
        // and fills a gapped stop at the bar's worst traded price; 'triple' adds a
        // time barrier at `_labelHorizonBars`. Default optimistic ⇒ bit-identical.
        const policy = (this._labelPolicy === 'conservative' || this._labelPolicy === 'triple')
            ? this._labelPolicy
            : 'optimistic';
        const conservative = policy !== 'optimistic';
        const triple = policy === 'triple';
        const horizonBars = Number.isFinite(this._labelHorizonBars) && this._labelHorizonBars > 0
            ? Math.floor(this._labelHorizonBars)
            : null;

        for (const trade of trades) {
            const entryTime = isValidTimestamp(trade.timestamp) ? Date.parse(trade.timestamp) : NaN;
            let features;
            try {
                features = JSON.parse(trade.features);
            } catch {
                // A corrupt TEXT cell must not throw inside the worker (ROADMAP
                // P0-1): count it, warn, and move on.
                this._globalAccuracy.quarantinedRows = (this._globalAccuracy.quarantinedRows || 0) + 1;
                console.warn(`[isolated] open_trades row ${trade.timestamp} has unparseable features; skipped.`);
                continue;
            }

            const isLong = trade.sellPrice > trade.entryPrice;
            // Window bars at or before the entry: the closing bar's window index
            // minus this, plus one, is the true elapsed count (R27-4b).
            const entryRank = Number.isFinite(entryTime) ? windowBarsUpTo(entryTime) : 0;
            let barsAfterEntry = 0;

            for (let ci = 0; ci < candles.length; ci++) {
                const candle = candles[ci];
                if (!candle || !isValidNumber(candle.high) || !isValidNumber(candle.low)) continue;

                const afterEntry = Number.isFinite(entryTime)
                    ? (Number.isFinite(candleTimes[ci]) && candleTimes[ci] > entryTime)
                    : true;
                if (!afterEntry) continue;
                barsAfterEntry++;

                // Prefer the window-derived elapsed count when the current bar can
                // be located in the cached window; otherwise fall back to the
                // new-bar counter (identical to the historical behaviour for a
                // timestamp-less / window-less feed).
                let elapsedBars = barsAfterEntry;
                const windowIdx = Number.isFinite(candleTimes[ci]) ? windowIndexByTime.get(candleTimes[ci]) : undefined;
                if (windowIdx != null) {
                    elapsedBars = windowIdx - entryRank + 1;
                    if (!(elapsedBars >= 1)) elapsedBars = 1;
                    if (heldBarsCap != null && elapsedBars > heldBarsCap) elapsedBars = heldBarsCap;
                }

                const hitTakeProfit = isLong
                    ? candle.high >= trade.sellPrice
                    : candle.low <= trade.sellPrice;

                const hitStopLoss = isLong
                    ? candle.low <= trade.stopLoss
                    : candle.high >= trade.stopLoss;

                let exitPrice = null;
                let outcome = null;
                let timeBarrier = false;

                if (conservative) {
                    // Stop-first on an unresolved two-barrier bar, and a gapped stop
                    // fills at the bar's worst traded price (the open, when it gaps
                    // through the stop) rather than at the stop price.
                    if (hitStopLoss) {
                        exitPrice = isValidNumber(candle.open)
                            ? (isLong ? Math.min(trade.stopLoss, candle.open) : Math.max(trade.stopLoss, candle.open))
                            : trade.stopLoss;
                        outcome = 0;
                    } else if (hitTakeProfit) {
                        exitPrice = trade.sellPrice;
                        outcome = 1;
                    }
                } else {
                    // Historical optimistic ordering: the take-profit is tested first,
                    // so a bar spanning both barriers is booked as a win.
                    if (hitTakeProfit) {
                        exitPrice = trade.sellPrice;
                        outcome = 1;
                    } else if (hitStopLoss) {
                        exitPrice = trade.stopLoss;
                        outcome = 0;
                    }
                }

                if (exitPrice == null && triple && horizonBars != null && elapsedBars >= horizonBars && isValidNumber(candle.close)) {
                    // The third barrier: expiry. Labelled from the horizon bar's close,
                    // on the take-profit side of the trade's direction.
                    exitPrice = candle.close;
                    outcome = (isLong ? candle.close >= trade.entryPrice : candle.close <= trade.entryPrice) ? 1 : 0;
                    timeBarrier = true;
                }

                if (exitPrice != null) {
                    closedTrades.push({
                        timestamp: trade.timestamp,
                        entryPrice: trade.entryPrice,
                        exitPrice,
                        outcome,
                        features,
                        confidence: trade.confidence,
                        // Diagnostics only (not persisted): the holding length and
                        // whether the time barrier resolved it. R27-4b: `heldBars`
                        // is now the true elapsed-bar count measured against the
                        // cached window, not the (always-1) new-bar counter.
                        heldBars: elapsedBars,
                        timeBarrier,
                    });
                    break;
                }
            }
        }

        if (closedTrades.length > 0) {
            const transaction = this._db.transaction(() => {
                const insertClosedStmt = this._db.prepare(`
                    INSERT INTO closed_trades 
                    (timestamp, entryPrice, exitPrice, outcome, features, confidence) 
                    VALUES (?, ?, ?, ?, ?, ?)
                `);
                const deleteOpenStmt = this._db.prepare(`DELETE FROM open_trades WHERE timestamp = ?`);

                for (const trade of closedTrades) {
                    insertClosedStmt.run(
                        trade.timestamp,
                        trade.entryPrice,
                        trade.exitPrice,
                        trade.outcome,
                        JSON.stringify(trade.features),
                        trade.confidence
                    );
                    deleteOpenStmt.run(trade.timestamp);

                    // Label lifecycle (round 26, R26-11): the holding distribution and
                    // the time-barrier count, so the label policy is measurable.
                    const held = Number.isFinite(trade.heldBars) ? trade.heldBars : 0;
                    this._globalAccuracy.heldBarsSum += held;
                    this._globalAccuracy.heldBarsCount += 1;
                    if (held > this._globalAccuracy.heldBarsMax) this._globalAccuracy.heldBarsMax = held;
                    if (trade.timeBarrier) this._globalAccuracy.resolvedTimeBarrier += 1;

                    // R28 (BUGS.md #58): remember the realized holding period so the
                    // causal span estimator can use it the NEXT time a label's weight
                    // is computed. `closed_trades` does not persist `heldBars`, and
                    // the trade is drained in the same call, so the bridge is
                    // in-memory and only exists when the weighting is on.
                    if (this._sampleWeightConfig) {
                        const map = this._sampleWeightHeldBars || (this._sampleWeightHeldBars = new Map());
                        map.set(trade.timestamp, held);
                    }
                }
            });

            transaction();
        }
    },

    _processClosedTrades (processCount) {
        const tradesStmt = this._db.prepare(`
            SELECT timestamp, entryPrice, exitPrice, outcome, features, confidence
            FROM closed_trades
            ORDER BY timestamp ASC
            LIMIT ?
        `);

        const trades = tradesStmt.all(processCount);

        if (trades.length === 0) {
            return;
        }

        const checkEncodingStmt = this._db.prepare(`SELECT encoding FROM trained_features WHERE encoding = ?`);
        const insertEncodingStmt = this._db.prepare(`INSERT INTO trained_features (encoding) VALUES (?)`);
        const deleteTradeStmt = this._db.prepare(`DELETE FROM closed_trades WHERE timestamp = ?`);

        // null unless the controller was explicitly given a `_sampleWeightConfig`;
        // when null every trade is trained with weight 1 (bit-exact default).
        const sampleWeights = this._sampleWeightsForBatch(trades);

        const transaction = this._db.transaction(() => {
            for (let rowIdx = 0; rowIdx < trades.length; rowIdx++) {
                const row = trades[rowIdx];

                let parsedFeatures;
                try {
                    parsedFeatures = JSON.parse(row.features);
                } catch {
                    this._globalAccuracy.quarantinedRows = (this._globalAccuracy.quarantinedRows || 0) + 1;
                    console.warn(`[isolated] closed_trades row ${row.timestamp} has unparseable features; dropped.`);
                    deleteTradeStmt.run(row.timestamp);
                    continue;
                }

                const trade = {
                    timestamp: row.timestamp,
                    entryPrice: row.entryPrice,
                    exitPrice: row.exitPrice,
                    outcome: row.outcome,
                    features: parsedFeatures,
                    confidence: row.confidence
                };

                const flatFeatures = trade.features;
                const encodingString = `${flatFeatures.join(',')}|${trade.outcome}`;
                const encodingHash = crypto.createHash('sha256').update(encodingString).digest('hex');

                if (trade.confidence >= 0) {
                    this._globalAccuracy.total++;
                    this._globalAccuracy.totalPoints += 100;

                    // Label lifecycle + Brier components (round 26, R26-2 /
                    // BUGS.md #37). Same sample as `total`, so the base rate and
                    // the skill score a report quotes are referenced to the rows
                    // the model was actually scored on.
                    if (trade.outcome === 1) this._globalAccuracy.resolvedTakeProfit++;
                    else this._globalAccuracy.resolvedStopLoss++;
                    const forecast = trade.confidence / 100;
                    this._globalAccuracy.brierSum += (forecast - trade.outcome) * (forecast - trade.outcome);
                    this._globalAccuracy.brierCount++;

                    if (trade.confidence >= 50 && trade.outcome === 1) {
                        this._globalAccuracy.wins++;
                        this._globalAccuracy.realPoints += trade.confidence;
                    }

                    else if (trade.confidence < 50 && trade.outcome === 1) {
                        this._globalAccuracy.losses++;
                        this._globalAccuracy.realPoints += trade.confidence;
                    } 

                    else if (trade.confidence < 50 && trade.outcome === 0) {
                        this._globalAccuracy.wins++;
                        this._globalAccuracy.realPoints += 100 - trade.confidence
                    }

                    else if (trade.confidence >= 50 && trade.outcome === 0) {
                        this._globalAccuracy.losses++;
                        this._globalAccuracy.realPoints += 100 - trade.confidence
                    }
                }

                const existingEncoding = checkEncodingStmt.get(encodingHash);
                if (existingEncoding) {
                    this._globalAccuracy.skippedDuplicate++;
                    deleteTradeStmt.run(trade.timestamp);
                    continue;
                }

                if (!this._hivemind) {
                    this._hivemind = new HiveMind(this._directoryPath, this._ensembleSize, this._inputSize, this._controllerID, this._forceMin);
                }

                const sampleWeight = sampleWeights ? (sampleWeights[rowIdx] ?? 1) : 1;
                const result = this._hivemind.train(flatFeatures, trade.outcome, sampleWeight);
                this._shouldDumpState = true;
                // R27-4 (BUGS.md #46): `train` returns the (finite) step count, but
                // guard anyway so a future non-finite return can never be bound into
                // the NOT NULL `global_stats` value or make the counter non-monotone.
                if (Number.isFinite(result)) this._globalAccuracy.trainingSteps = result;

                insertEncodingStmt.run(encodingHash);
                deleteTradeStmt.run(trade.timestamp);
            }
        });

        transaction();
    },

    // Additive: sample-uniqueness weights for a batch of closed trades.
    //
    // Returns null (the whole feature disabled) unless the controller has been
    // given a `_sampleWeightConfig` — so the default training path is unchanged
    // and the golden fingerprints are untouched. Two modes:
    //
    //   * `mode: 'causal-window'` (R27-3): a streaming ring of the last
    //     `windowBars` OBSERVED entry spans. Each new label's weight is its
    //     average uniqueness against the ring (including itself), normalised over
    //     the window, and then (R28, BUGS.md #54) re-normalised by the running mean
    //     of the RAW emitted weights so the emitted stream's mean is 1 rather than
    //     drifting with the horizon/window ratio. The span horizon is either
    //     `cfg.horizonBars` (fixed) or, when that is null, the causal EMA of the
    //     holding periods of the trades drained so far (R28, BUGS.md #58 — the
    //     assumed horizon, not the labeller's name, is what decides inertness).
    //     `cfg.emittedNormalization` selects the arm: 'mean1' (dispersion at
    //     matched LR), 'scale' (the scale alone, as a P3 control) or 'none' (the
    //     un-normalised stream).
    //   * the legacy batch-local mode: each trade's label spans `horizonBars`
    //     bars from its entry, entry bars are derived from the trade timestamps
    //     at `intervalMs`, and the batch is weighted by average uniqueness
    //     (Lopez de Prado ch. 4, see training/sample_weights.js).
    _sampleWeightsForBatch (trades) {
        const cfg = this._sampleWeightConfig;
        if (!cfg || !Array.isArray(trades) || trades.length === 0) return null;

        const intervalMs = Number.isFinite(cfg.intervalMs) && cfg.intervalMs > 0 ? cfg.intervalMs : 3600000;

        if (cfg.mode === 'causal-window') {
            const ring = this._sampleWeightRing || (this._sampleWeightRing = []);
            const windowBars = Number.isFinite(cfg.windowBars) && cfg.windowBars > 0 ? Math.floor(cfg.windowBars) : 64;
            const fixedHorizon = Number.isFinite(cfg.horizonBars) && cfg.horizonBars > 0 ? Math.floor(cfg.horizonBars) : null;
            const measureHorizon = fixedHorizon == null;
            const emaAlpha = Number.isFinite(cfg.heldBarsEmaAlpha) && cfg.heldBarsEmaAlpha > 0 ? cfg.heldBarsEmaAlpha : 0.1;
            // R28: the emitted-stream normaliser, per controller (so it resets with
            // the fold, exactly like the ring). `emittedNormalization: 'none'`
            // disables it (the P3 arm B).
            const mode = cfg.emittedNormalization === 'none' ? 'none'
                : (cfg.emittedNormalization === 'scale' ? 'scale' : 'mean1');
            const normalizer = mode === 'none' ? null
                : (this._sampleWeightNormalizer || (this._sampleWeightNormalizer = emittedWeightNormalizer({ mode })));
            const out = new Array(trades.length).fill(1);
            for (let i = 0; i < trades.length; i++) {
                const ms = Date.parse(trades[i].timestamp);
                if (!Number.isFinite(ms)) continue;
                if (!Number.isFinite(this._sampleWeightEpochMs)) this._sampleWeightEpochMs = ms;
                const entry = Math.round((ms - this._sampleWeightEpochMs) / intervalMs);
                // R28 (BUGS.md #58): the span horizon is CAUSAL — a fixed config
                // value, or the EMA of the holding periods of the trades drained
                // BEFORE this one (never this label's own future).
                const measuredHorizon = Number.isFinite(this._sampleWeightHeldBarsEma) && this._sampleWeightHeldBarsEma > 0
                    ? Math.max(1, Math.round(this._sampleWeightHeldBarsEma))
                    : null;
                const horizon = fixedHorizon != null ? fixedHorizon : (measuredHorizon != null ? measuredHorizon : 1);
                const span = [entry, entry + horizon - 1];
                const r = causalWindowWeight(ring, span, cfg);
                const rawWeight = r.weight;
                const weight = normalizer ? normalizer.normalize(rawWeight) : rawWeight;
                out[i] = weight;
                this._accumulateSampleWeightStats(r, { weight, rawWeight, horizonBars: horizon, measureHorizon });
                // Update the causal EMA AFTER this label's span was fixed, using the
                // holding period the close recorded for it (if any).
                const held = this._sampleWeightHeldBars ? this._sampleWeightHeldBars.get(trades[i].timestamp) : undefined;
                if (Number.isFinite(held) && held > 0) {
                    this._sampleWeightHeldBarsEma = Number.isFinite(this._sampleWeightHeldBarsEma)
                        ? this._sampleWeightHeldBarsEma * (1 - emaAlpha) + held * emaAlpha
                        : held;
                }
                if (this._sampleWeightHeldBars) this._sampleWeightHeldBars.delete(trades[i].timestamp);
                ring.push(span);
                while (ring.length > windowBars) ring.shift();
            }
            return out;
        }

        let t0 = Infinity;
        for (const row of trades) {
            const ms = Date.parse(row.timestamp);
            if (Number.isFinite(ms) && ms < t0) t0 = ms;
        }
        if (!Number.isFinite(t0)) return null;

        const entries = trades.map((row) => {
            const ms = Date.parse(row.timestamp);
            return Number.isFinite(ms) ? Math.round((ms - t0) / intervalMs) : 0;
        });
        return spanWeightsFromEntries(entries, cfg);
    },

    // Accumulate the causal-window weight statistics (R27-3, extended in R28).
    // Diagnostic only: the report states what the weighting actually did, so an
    // all-ones vector (the inert case), the raw (un-normalised) scale and the
    // assumed span horizon are visible rather than inferred.
    _accumulateSampleWeightStats (r, extra = null) {
        const s = this._sampleWeightStats || (this._sampleWeightStats = {
            count: 0, min: Infinity, max: -Infinity, sum: 0, rawSum: 0, essSum: 0, nSum: 0,
            horizonBars: null, measureHorizon: false,
        });
        // R28 (BUGS.md #54): `min`/`max`/`mean` describe the EMITTED stream (what is
        // actually trained — the mean-1 normalised weight), and `meanUnnormalised`
        // the RAW stream (the 2.6x-scale drift), so the two are never conflated.
        const w = Number.isFinite(extra && extra.weight) ? extra.weight
            : (Number.isFinite(r.weight) ? r.weight : 1);
        s.count += 1;
        if (w < s.min) s.min = w;
        if (w > s.max) s.max = w;
        s.sum += w;
        s.rawSum += (extra && Number.isFinite(extra.rawWeight)) ? extra.rawWeight : w;
        s.essSum += r.ess;
        s.nSum += r.n;
        if (extra && Number.isFinite(extra.horizonBars)) s.horizonBars = extra.horizonBars;
        if (extra && extra.measureHorizon) s.measureHorizon = true;
    },

    // The causal-window sample-weight summary, or null when the feature is off /
    // never accumulated. Consumed by the A/B's model diagnostics (R27-3). R28
    // (BUGS.md #54): `meanUnnormalised` is the raw emitted stream's mean, so the
    // scale the old code silently applied (2.6x on the round-27 `triple` run) is
    // visible next to the mean-1 normalised `mean`.
    sampleWeightSummary () {
        const s = this._sampleWeightStats;
        if (!s || s.count === 0) return null;
        return {
            count: s.count,
            min: s.min,
            max: s.max,
            mean: s.sum / s.count,
            meanUnnormalised: s.rawSum / s.count,
            ess: s.essSum / s.count,
            n: s.nSum / s.count,
            effectiveFraction: s.nSum > 0 ? s.essSum / s.nSum : null,
            horizonBars: s.horizonBars,
            measureHorizon: !!s.measureHorizon,
        };
    }

};
