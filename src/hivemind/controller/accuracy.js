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
        });
        transaction();
    }

};
