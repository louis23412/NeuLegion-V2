// HiveMindController component: controller candle cache access
//
// Split out of the monolithic src/hivemind/hiveMindController.js; the method
// bodies are byte-identical. Installed onto HiveMindController.prototype by
// ../internal/mixins.js. The controller keeps only its fields, constructor and
// the public getSignal() in the class body.

import { isValidNumber, isValidTimestamp } from './../utils.js';

export const controllerCandleMethods = {
    _getRecentCandles (candles) {
        if (!Array.isArray(candles) || candles.length === 0) {
            return { error: 'Invalid candle array type or length', recentCandles: [], fullCandles: [] };
        }

        const newCandles = candles.filter(c =>
            isValidTimestamp(c.timestamp) &&
            isValidNumber(c.open) &&
            isValidNumber(c.high) &&
            isValidNumber(c.low) &&
            isValidNumber(c.close) &&
            isValidNumber(c.volume) &&
            c.volume >= 0
        );

        // A malformed bar is counted, never silently skipped (round 26, R26-1
        // suspect 8): the count rides in `stats()` and, when nonzero, on the
        // signal as a non-enumerable diagnostic. `candles.length - newCandles.length`
        // counts only the invalid entries — a repeated (already-seen) candle is
        // still valid and is ignored by `INSERT OR IGNORE`, not dropped here.
        const dropped = candles.length - newCandles.length;
        if (dropped > 0) {
            this._globalAccuracy.droppedCandles = (this._globalAccuracy.droppedCandles || 0) + dropped;
        }

        let recentCandles = [];
        let fullCandles = [];
        const transaction = this._db.transaction(() => {
            if (newCandles.length > 0) {
                const insertCandleStmt = this._db.prepare(`
                    INSERT OR IGNORE INTO candles (timestamp, open, high, low, close, volume)
                    VALUES (?, ?, ?, ?, ?, ?)
                `);
                const insertedTimestamps = [];
                for (const candle of newCandles) {
                    const result = insertCandleStmt.run(
                        candle.timestamp,
                        candle.open,
                        candle.high,
                        candle.low,
                        candle.close,
                        candle.volume
                    );

                    if (result.changes > 0) {
                        insertedTimestamps.push(candle.timestamp);
                    }
                }

                if (insertedTimestamps.length > 0) {
                    const placeholders = insertedTimestamps.map(() => '?').join(',');
                    const fetchRecentStmt = this._db.prepare(`
                        SELECT * FROM candles WHERE timestamp IN (${placeholders}) ORDER BY timestamp ASC
                    `);
                    recentCandles = fetchRecentStmt.all(...insertedTimestamps);
                }
            }

            const cleanupStmt = this._db.prepare(`
                DELETE FROM candles WHERE timestamp NOT IN (
                    SELECT timestamp FROM candles ORDER BY timestamp DESC LIMIT ${this._cacheSize}
                )
            `);
            cleanupStmt.run();

            const fetchCandlesStmt = this._db.prepare(`
                SELECT * FROM candles ORDER BY timestamp ASC LIMIT ${this._cacheSize}
            `);
            fullCandles = fetchCandlesStmt.all();
        });
        transaction();

        if (fullCandles.length === 0) {
            return { error: 'No valid candles available', recentCandles: [], fullCandles: [] };
        }

        return { error: null, recentCandles, fullCandles };
    }

    // Accepts plain arrays and TypedArrays. Prototype means/variance are
    // Float32Array internally, and `broadcastMemory` converts them with
    // `Array.from` before they reach this path, but a bare `Array.isArray`
    // guard would silently turn any TypedArray input into an all-zero vector
    // (which is exactly what happens if that conversion is ever dropped), so
    // the check is explicit about what it accepts.
};
