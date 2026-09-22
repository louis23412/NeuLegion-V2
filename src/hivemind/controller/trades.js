// HiveMindController component: controller open/closed trade accounting
//
// Split out of the monolithic src/hivemind/hiveMindController.js; the method
// bodies are byte-identical. Installed onto HiveMindController.prototype by
// ../internal/mixins.js. The controller keeps only its fields, constructor and
// the public getSignal() in the class body.

import crypto from 'crypto';
import HiveMind from './../hiveMind.js';
import { isValidNumber, isValidTimestamp } from './../utils.js';
import { spanWeightsFromEntries } from './../training/sample_weights.js';

export const controllerTradeMethods = {
    _updateOpenTrades (candles) {
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
            let barsAfterEntry = 0;

            for (let ci = 0; ci < candles.length; ci++) {
                const candle = candles[ci];
                if (!candle || !isValidNumber(candle.high) || !isValidNumber(candle.low)) continue;

                const afterEntry = Number.isFinite(entryTime)
                    ? (Number.isFinite(candleTimes[ci]) && candleTimes[ci] > entryTime)
                    : true;
                if (!afterEntry) continue;
                barsAfterEntry++;

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

                if (exitPrice == null && triple && horizonBars != null && barsAfterEntry >= horizonBars && isValidNumber(candle.close)) {
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
                        // whether the time barrier resolved it.
                        heldBars: barsAfterEntry,
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
                this._globalAccuracy.trainingSteps = result;

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
    // and the golden fingerprints are untouched. When enabled, each trade's
    // label is treated as spanning `horizonBars` bars from its entry, entry bars
    // are derived from the trade timestamps at `intervalMs`, and the batch is
    // weighted by average uniqueness (Lopez de Prado ch. 4, see
    // training/sample_weights.js).
    _sampleWeightsForBatch (trades) {
        const cfg = this._sampleWeightConfig;
        if (!cfg || !Array.isArray(trades) || trades.length === 0) return null;

        const intervalMs = Number.isFinite(cfg.intervalMs) && cfg.intervalMs > 0 ? cfg.intervalMs : 3600000;
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
    }

};
