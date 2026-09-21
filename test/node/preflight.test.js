// Preflight gate (ROADMAP P0-3). Node-only: `runPreflight` checks the shipped
// environment (Node floor, candle stream, state dir, native SQLite, config,
// a real worker smoke test, the dashboard port). This asserts the checks that
// must pass on any healthy checkout do pass; memory/disk headroom are reported
// but not asserted (they depend on the machine's current load).
//
// Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('preflight passes on a healthy checkout', async () => {
    const { CONFIG } = await import('../../src/legion/config.js');
    CONFIG.stateFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-preflight-test-'));
    CONFIG.httpPort = 0; // ephemeral: the port check is always "free"

    try {
        const { runPreflight, formatPreflight } = await import('../../src/preflight.js');
        const checks = await runPreflight();
        const byName = Object.fromEntries(checks.map((c) => [c.name, c]));

        // The candle check reports a DIFFERENT name on each failure mode
        // ("candle stream exists"/"parseable"/"timestamps monotonic"/...) and its
        // passing name only when the sample is clean, so match it by prefix and
        // collect every problem before asserting — otherwise the first miss hides
        // the real detail (and any later failure) behind one terse message.
        const problems = [];
        const candle = checks.find((c) => c.name.startsWith('candle stream'));
        if (!candle) problems.push('preflight reported no "candle stream*" check');
        else if (!candle.ok) problems.push(`${candle.name} failed: ${candle.detail}`);

        for (const name of [
            'node version',
            'state directory writable',
            'sqlite native',
            'config sanity',
            'worker smoke',
            'dashboard port',
        ]) {
            if (!byName[name]) problems.push(`preflight did not report "${name}"`);
            else if (!byName[name].ok) problems.push(`${name} failed: ${byName[name].detail}`);
        }
        assert.deepEqual(problems, [], `preflight problems:\n  ${problems.join('\n  ')}`);

        assert.match(formatPreflight(checks), /\[PASS\] worker smoke/);
        assert.ok(checks.length >= 8, `expected the 8 preflight checks, got ${checks.length}`);
    } finally {
        fs.rmSync(CONFIG.stateFolder, { recursive: true, force: true });
    }
});
