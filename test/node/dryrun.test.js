// Dry-run harness (ROADMAP P0-3). Node-only: `runDryRun` drives the real
// pipeline on a synthetic stream with a compact config into a throwaway state
// dir and self-checks its invariants. This asserts the harness itself passes —
// i.e. a full `runner → batch → worker → controller → observer → report` lap
// works end-to-end before a long run is attempted.
//
// Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runDryRun, formatDryRun } from '../../src/dryrun.js';

test('dry run completes a lap with every invariant holding', async () => {
    const result = await runDryRun({ batches: 1 });

    assert.equal(
        result.failed, 0,
        `${result.failed}/${result.checks.length} dry-run invariants failed:\n${JSON.stringify(result.checks.filter((c) => !c.pass), null, 2)}`,
    );
    assert.equal(result.summary.completedBatches, 1, `stopped=${result.summary.stopped}`);
    assert.equal(result.summary.failedBatches, 0);
    assert.equal(result.summary.totalControllerFailures, 0);
    assert.equal(result.summary.malformedCandleLines, 0);
    assert.ok(Number.isFinite(result.metrics.brier));
    assert.ok(result.checks.length >= 12, `expected the dry-run invariant set, got ${result.checks.length}`);
    assert.match(formatDryRun(result), /dry run: 1 batch/);
    assert.match(formatDryRun(result), /\[PASS\]/);
});
