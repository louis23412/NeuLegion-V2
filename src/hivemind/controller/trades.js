// HiveMindController component: controller open/closed trade accounting
//
// Split out of the monolithic src/hivemind/hiveMindController.js; the method
// bodies are byte-identical. Installed onto HiveMindController.prototype by
// ../internal/mixins.js. The controller keeps only its fields, constructor and
// the public getSignal() in the class body.

import crypto from 'crypto';
import HiveMind from './../hiveMind.js';
import { isValidNumber } from './../utils.js';
import { spanWeightsFromEntries } from './../training/sample_weights.js';

export const controllerTradeMethods = {
    _updateOpenTrades (candles) {
        if (!Array.isArray(candles) || candles.length === 0) return;

        const tradesStmt = this._db.prepare(`
            SELECT timestamp, sellPrice, stopLoss, entryPrice, features, confidence
            FROM open_trades
        `);
        const trades = tradesStmt.all();

        const closedTrades = [];

        for (const trade of trades) {
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
            for (const candle of candles) {
                if (!candle || !isValidNumber(candle.high) || !isValidNumber(candle.low)) continue;

                const isLong = trade.sellPrice > trade.entryPrice;

                const hitTakeProfit = isLong
                    ? candle.high >= trade.sellPrice
                    : candle.low <= trade.sellPrice;

                const hitStopLoss = isLong
                    ? candle.low <= trade.stopLoss
                    : candle.high >= trade.stopLoss;

                if (hitTakeProfit || hitStopLoss) {
                    const exitPrice = hitTakeProfit ? trade.sellPrice : trade.stopLoss;
                    const outcome = hitTakeProfit ? 1 : 0;

                    closedTrades.push({
                        timestamp: trade.timestamp,
                        entryPrice: trade.entryPrice,
                        exitPrice,
                        outcome,
                        features,
                        confidence: trade.confidence
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
