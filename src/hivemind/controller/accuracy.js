// HiveMindController component: controller global accuracy persistence
//
// Split out of the monolithic src/hivemind/hiveMindController.js; the method
// bodies are byte-identical. Installed onto HiveMindController.prototype by
// ../internal/mixins.js. The controller keeps only its fields, constructor and
// the public getSignal() in the class body.

export const controllerAccuracyMethods = {
    _loadGlobalAccuracy () {
        const selectStmt = this._db.prepare(`
            SELECT value FROM global_stats WHERE key = ?
        `);

        const trainingStepsRaw = selectStmt.get('training_steps');
        if (trainingStepsRaw) {
            this._globalAccuracy.trainingSteps = trainingStepsRaw.value;
        }

        const skippedRaw = selectStmt.get('skipped_duplicate');
        if (skippedRaw) {
            this._globalAccuracy.skippedDuplicate = skippedRaw.value;
        }

        const quarantinedRaw = selectStmt.get('quarantined_rows');
        if (quarantinedRaw) {
            this._globalAccuracy.quarantinedRows = quarantinedRaw.value;
        }

        const winsRaw = selectStmt.get('trade_wins');
        if (winsRaw) {
            this._globalAccuracy.wins = winsRaw.value;
        }

        const lossesRaw = selectStmt.get('trade_losses');
        if (lossesRaw) {
            this._globalAccuracy.losses = lossesRaw.value;
        }

        const totalRaw = selectStmt.get('total_trades');
        if (totalRaw) {
            this._globalAccuracy.total = totalRaw.value;
        }

        const totalPointsRaw = selectStmt.get('total_points');
        if (totalPointsRaw) {
            this._globalAccuracy.totalPoints = totalPointsRaw.value;
        }

        const realPointsRaw = selectStmt.get('real_points');
        if(realPointsRaw) {
            this._globalAccuracy.realPoints = realPointsRaw.value;
        }

        const memSentRaw = selectStmt.get('memories_sent');
        if (memSentRaw) {
            this._globalAccuracy.memoriesSent = memSentRaw.value;
        }

        const memReceivedRaw = selectStmt.get('memories_received');
        if (memReceivedRaw) {
            this._globalAccuracy.memoriesReceived = memReceivedRaw.value;
        }

        // Label lifecycle + Brier components + drop counter (round 26, R26-2 /
        // R26-1). Rows absent on an older control db simply leave the in-memory
        // default (0), so this is a forward-compatible load.
        const takeProfitRaw = selectStmt.get('resolved_take_profit');
        if (takeProfitRaw) this._globalAccuracy.resolvedTakeProfit = takeProfitRaw.value;

        const stopLossRaw = selectStmt.get('resolved_stop_loss');
        if (stopLossRaw) this._globalAccuracy.resolvedStopLoss = stopLossRaw.value;

        const brierSumRaw = selectStmt.get('brier_sum');
        if (brierSumRaw) this._globalAccuracy.brierSum = brierSumRaw.value;

        const brierCountRaw = selectStmt.get('brier_count');
        if (brierCountRaw) this._globalAccuracy.brierCount = brierCountRaw.value;

        const droppedRaw = selectStmt.get('dropped_candles');
        if (droppedRaw) this._globalAccuracy.droppedCandles = droppedRaw.value;

        // Label lifecycle, part 2 (round 26, R26-11).
        const timeBarrierRaw = selectStmt.get('resolved_time_barrier');
        if (timeBarrierRaw) this._globalAccuracy.resolvedTimeBarrier = timeBarrierRaw.value;

        const heldSumRaw = selectStmt.get('held_bars_sum');
        if (heldSumRaw) this._globalAccuracy.heldBarsSum = heldSumRaw.value;

        const heldCountRaw = selectStmt.get('held_bars_count');
        if (heldCountRaw) this._globalAccuracy.heldBarsCount = heldCountRaw.value;

        const heldMaxRaw = selectStmt.get('held_bars_max');
        if (heldMaxRaw) this._globalAccuracy.heldBarsMax = heldMaxRaw.value;
    },

    _saveGlobalAccuracy () {
        const upsertStmt = this._db.prepare(`
            INSERT INTO global_stats (key, value)
            VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `);

        const transaction = this._db.transaction(() => {
            upsertStmt.run('training_steps', this._globalAccuracy.trainingSteps);
            upsertStmt.run('skipped_duplicate', this._globalAccuracy.skippedDuplicate);
            upsertStmt.run('quarantined_rows', this._globalAccuracy.quarantinedRows || 0);
            upsertStmt.run('trade_wins', this._globalAccuracy.wins);
            upsertStmt.run('trade_losses', this._globalAccuracy.losses);
            upsertStmt.run('total_trades', this._globalAccuracy.total);
            upsertStmt.run('total_points', this._globalAccuracy.totalPoints);
            upsertStmt.run('real_points', this._globalAccuracy.realPoints);
            upsertStmt.run('memories_sent', this._globalAccuracy.memoriesSent);
            upsertStmt.run('memories_received', this._globalAccuracy.memoriesReceived);
            // Label lifecycle + Brier components + drop counter (round 26, R26-2 /
            // R26-1). NOT NULL is satisfied because every one of these is a finite
            // number on the class initializer; `brier_sum` is a REAL (SQLite
            // NUMERIC affinity stores it as such).
            upsertStmt.run('resolved_take_profit', this._globalAccuracy.resolvedTakeProfit || 0);
            upsertStmt.run('resolved_stop_loss', this._globalAccuracy.resolvedStopLoss || 0);
            upsertStmt.run('brier_sum', this._globalAccuracy.brierSum || 0);
            upsertStmt.run('brier_count', this._globalAccuracy.brierCount || 0);
            upsertStmt.run('dropped_candles', this._globalAccuracy.droppedCandles || 0);
            upsertStmt.run('resolved_time_barrier', this._globalAccuracy.resolvedTimeBarrier || 0);
            upsertStmt.run('held_bars_sum', this._globalAccuracy.heldBarsSum || 0);
            upsertStmt.run('held_bars_count', this._globalAccuracy.heldBarsCount || 0);
            upsertStmt.run('held_bars_max', this._globalAccuracy.heldBarsMax || 0);
        });
        transaction();
    }

};
