// Structural check of the mirrored-suite layout ITSELF (Node-only: it needs real
// directory enumeration, which the browser harness has no API for).
//
// It pins the drift modes a local run has actually hit or could silently hit:
//   1. a browser entry with no node mirror — silently uncovered on native
//      SQLite (the golden bit-exactness lock was in exactly this state);
//   2. a node mirror left behind by a renamed entry, or reduced to a stub that
//      covers nothing;
//   3. a browser entry missing from lock-registry.js#KNOWN_TESTS, so it can never
//      be cited as proof of a lock;
//   4. the `npm test` script passing a DIRECTORY to `node --test`, which Node
//      <= 21 accepted but Node >= 22 loads as a module, so the run dies with
//      `Cannot find module '.../test/node'` before executing anything
//      (docs/BUGS.md #14), or `engines.node` dropping below the 22 the glob needs.
//
// Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));          // .../test/node/
const projectRoot = path.resolve(here, '..', '..');                 // repository root
const entriesDir = path.join(projectRoot, 'test', 'browser', 'entries');

// `bench.test.js` only prints timings (no pass/fail contract), so it has no
// mirror — it is also absent from lock-registry.js#KNOWN_TESTS.
const BROWSER_ONLY = new Set(['bench.test.js']);

// Node-only suites with no browser counterpart by construction: `mirrors.test.js`
// checks the layout itself (the harness has no directory enumeration),
// `engine_portability.test.js` runs the golden entry under a process-wide
// `Math.exp` patch with `node:test` assertions (see "Test-harness limitations" in
// docs/BUGS.md), and the run-integrity suites (`worker_pool`, `runner_smoke`,
// `dryrun`, `preflight`, `http_view`, `report_lifecycle`, `shutdown`) drive the
// real worker_threads / SQLite / HTTP / process machinery, which the browser
// harness cannot.
const NODE_ONLY = new Set([
    'mirrors.test.js', 'engine_portability.test.js',
    'worker_pool.test.js', 'runner_smoke.test.js', 'dryrun.test.js',
    'preflight.test.js', 'http_view.test.js', 'report_lifecycle.test.js',
    'shutdown.test.js', 'config_env.test.js',
]);

const testFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();
const exists = (...parts) => fs.existsSync(path.join(...parts));

// The ledger the two structural counts below are pinned to: 30 browser entries
// (29 with a pass/fail contract, plus `bench`) and 39 node mirrors (29 mirrors +
// the 10 Node-only suites). See RUNBOOK.md §6.
const BROWSER_ENTRY_LEDGER = 30;
const NODE_MIRROR_LEDGER = 39;

test('every pass/fail browser entry has a node mirror', () => {
    const entries = testFiles(entriesDir);
    assert.equal(entries.length, BROWSER_ENTRY_LEDGER,
        `expected the ${BROWSER_ENTRY_LEDGER} browser entries in the RUNBOOK.md §6 ledger, found ${entries.length}`);
    const missing = entries.filter((f) => !BROWSER_ONLY.has(f) && !exists(here, f));
    assert.deepEqual(missing, [], `browser entries with no test/node mirror: ${missing.join(', ')}`);
});

test('every node mirror declares at least one test case', () => {
    // A mirror reduced to a stub (or an edit that deletes the `test(...)` call)
    // would otherwise silently count as covering its entry while running nothing.
    const declared = testFiles(here);
    assert.equal(declared.length, NODE_MIRROR_LEDGER,
        `expected the ${NODE_MIRROR_LEDGER} node mirrors in the RUNBOOK.md §6 ledger, found ${declared.length}`);
    const empty = declared.filter((f) => !/(^|\n)\s*test\s*\(/.test(fs.readFileSync(path.join(here, f), 'utf8')));
    assert.deepEqual(empty, [], `node mirrors that declare no test() case: ${empty.join(', ')}`);
});

test('every node mirror corresponds to a browser entry', () => {
    const orphans = testFiles(here).filter((f) => !NODE_ONLY.has(f) && !exists(entriesDir, f));
    assert.deepEqual(orphans, [], `node mirrors with no browser entry: ${orphans.join(', ')}`);
});

test('the lock registry knows every browser entry', async () => {
    // `locks.test.js` validates that every `proves` reference resolves against
    // lock-registry.js#KNOWN_TESTS, but nothing checked the other direction — so a
    // new browser entry could run completely unregistered (and therefore never be
    // cited as proof of a lock) without any test noticing.
    const { KNOWN_TESTS } = await import('../lock-registry.js');
    const entries = testFiles(entriesDir).filter((f) => !BROWSER_ONLY.has(f));
    const unknown = entries.filter((f) => !KNOWN_TESTS.includes(f));
    assert.deepEqual(unknown, [], `browser entries missing from lock-registry.js#KNOWN_TESTS: ${unknown.join(', ')}`);
    const stale = KNOWN_TESTS.filter((f) => !exists(entriesDir, f));
    assert.deepEqual(stale, [], `KNOWN_TESTS names that are not browser entries: ${stale.join(', ')}`);
});

test('the test script is a Node>=22-compatible glob over the mirrors', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const script = pkg.scripts && pkg.scripts.test;
    assert.ok(script, 'package.json has no test script');

    // The glob form only works on Node >= 22 (glob support landed in Node 21;
    // Node 20 is EOL), so the declared engine floor must not drift below it.
    const range = (pkg.engines && pkg.engines.node) || '';
    const floor = range.match(/>=\s*(\d+)/);
    assert.ok(floor, `package.json declares no engines.node lower bound: ${range}`);
    assert.ok(Number(floor[1]) >= 22,
        `engines.node is ${range}; it must be >= 22 because the test script passes a glob (docs/BUGS.md #14)`);

    // Every `node --test` invocation must hand the runner paths that Node >= 22
    // accepts: a directory argument is loaded as a module (#14), and anything not
    // ending in `.test.js` would run helpers or miss mirrors.
    const runnerScripts = Object.entries(pkg.scripts).filter(([, s]) => /--test(\s|$)/.test(s));
    assert.ok(runnerScripts.length > 0, 'no script invokes the test runner');
    for (const [name, s] of runnerScripts) {
        const argv = (s.slice(s.search(/--test(\s|$)/)).replace(/^--test\s*/, '')
            .trim().match(/"[^"]*"|\S+/g) || []);
        assert.ok(argv.length > 0, `npm run ${name} passes no paths: ${s}`);
        for (const raw of argv) {
            const arg = raw.replace(/^"|"$/g, '');
            assert.ok(
                !arg.endsWith('/') && !arg.endsWith(path.sep),
                `npm run ${name} passes a directory (${arg}); Node >= 22 loads it as a module — see docs/BUGS.md #14`,
            );
            assert.ok(
                arg.endsWith('.test.js'),
                `npm run ${name} passes a non-test path (${arg})`,
            );
        }
    }

    const testArgv = (script.slice(script.search(/--test(\s|$)/)).replace(/^--test\s*/, '')
        .trim().match(/"[^"]*"|\S+/g) || []).map((a) => a.replace(/^"|"$/g, ''));
    assert.ok(testArgv.some((a) => a.endsWith('*.test.js') && a.includes('test/node')),
        `the test script must glob test/node/*.test.js so it runs the whole mirror set: ${script}`);

    // The mirrors must be reachable by the glob and helpers.js must not be.
    const mirrors = testFiles(here);
    assert.equal(mirrors.length, NODE_MIRROR_LEDGER,
        `expected the ${NODE_MIRROR_LEDGER} node mirrors in the RUNBOOK.md §6 ledger, found ${mirrors.length}`);
    assert.ok(exists(here, 'helpers.js'), 'test/node/helpers.js is missing — the mirrors import it');
});
