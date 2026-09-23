// HiveMindController component: controller SQLite schema
//
// Split out of the monolithic src/hivemind/hiveMindController.js; the method
// bodies are byte-identical. Installed onto HiveMindController.prototype by
// ../internal/mixins.js. The controller keeps only its fields, constructor and
// the public getSignal() in the class body.

export const controllerDatabaseMethods = {
    _initDatabase () {
        this._db.exec(`
            CREATE TABLE IF NOT EXISTS open_trades (
                timestamp TEXT PRIMARY KEY,
                sellPrice REAL NOT NULL,
                stopLoss REAL NOT NULL,
                entryPrice REAL NOT NULL,
                features TEXT NOT NULL,
                confidence REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS closed_trades (
                timestamp TEXT PRIMARY KEY,
                entryPrice REAL NOT NULL,
                exitPrice REAL NOT NULL,
                outcome INTEGER NOT NULL,
                features TEXT NOT NULL,
                confidence REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS candles (
                timestamp TEXT PRIMARY KEY,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS trained_features (
                encoding TEXT PRIMARY KEY
            );
            CREATE TABLE IF NOT EXISTS global_stats (
                key TEXT PRIMARY KEY,
                value NUMERIC NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_open_trades_sellPrice ON open_trades(sellPrice);
            CREATE INDEX IF NOT EXISTS idx_open_trades_stopLoss ON open_trades(stopLoss);
            CREATE INDEX IF NOT EXISTS idx_candles_timestamp ON candles(timestamp);
            CREATE INDEX IF NOT EXISTS idx_trained_features_encoding ON trained_features(encoding);
        `);
    }

};
