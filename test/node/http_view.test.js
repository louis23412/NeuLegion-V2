// Monitor dashboard (ROADMAP P1-1). Node-only: it boots the real
// `http_server_worker.js` on an ephemeral port and exercises every route, then
// proves the EADDRINUSE fallback (a busy configured port must never take the
// run down).
//
// Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Worker } from 'node:worker_threads';

function bootDashboard(workerData) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('../../src/http_server_worker.js', import.meta.url), { workerData });
        const timer = setTimeout(() => { worker.terminate(); reject(new Error('dashboard did not bind within 15s')); }, 15000);
        worker.on('message', (msg) => {
            if (msg && msg.type === 'LISTENING') { clearTimeout(timer); resolve({ worker, port: msg.port, host: msg.host }); }
        });
        worker.on('error', (err) => { clearTimeout(timer); reject(err); });
        worker.on('exit', (code) => { if (code !== 0) { clearTimeout(timer); reject(new Error(`dashboard worker exited ${code}`)); } });
    });
}

test('dashboard serves the page + read-only API and pushes state', async () => {
    const { worker, port, host } = await bootDashboard({ host: '127.0.0.1', port: 0, reportPath: null });
    const base = `http://${host}:${port}`;
    try {
        // GET / -> the self-contained dashboard page
        const page = await fetch(`${base}/`);
        assert.equal(page.status, 200);
        assert.match(page.headers.get('content-type') || '', /text\/html/);
        const html = await page.text();
        assert.ok(html.length > 200 && /<html/i.test(html), 'dashboard page looks empty');

        // GET /api/state -> the default snapshot shape
        const initial = await (await fetch(`${base}/api/state`)).json();
        assert.ok(initial.overview && initial.controllers, JSON.stringify(Object.keys(initial)));

        // A non-GET method is rejected; unknown routes 404; no report -> 404.
        assert.equal((await fetch(`${base}/api/state`, { method: 'POST' })).status, 405);
        assert.equal((await fetch(`${base}/nope`)).status, 404);
        assert.equal((await fetch(`${base}/api/report`)).status, 404);

        // Push a full-state update and read it back.
        worker.postMessage({
            type: 'UPDATE_FULL_STATE',
            overview: { status: 'running', controllerFailures: 1, quarantinedRows: 2 },
            consensus: { direction: 'BUY', confidence: 60 },
            lastCandles: [{ id: 't', close: 1 }],
            controllers: { positive: { voters: [] }, negative: { voters: [] } },
            alerts: [{ id: 'ensemble-diversity-collapse', severity: 'warning' }],
        });
        let seen = null;
        for (let i = 0; i < 40; i++) {
            const s = await (await fetch(`${base}/api/state`)).json();
            if (s.overview && s.overview.status === 'running') { seen = s; break; }
            await new Promise((r) => setTimeout(r, 50));
        }
        assert.ok(seen, 'dashboard did not reflect the pushed state');
        assert.equal(seen.overview.controllerFailures, 1);
        assert.equal(seen.overview.quarantinedRows, 2);
        assert.equal(seen.consensus.direction, 'BUY');
        assert.equal(seen.alerts[0].id, 'ensemble-diversity-collapse');

        // SSE stream emits the current payload immediately.
        const events = await fetch(`${base}/api/events`);
        assert.equal(events.status, 200);
        assert.match(events.headers.get('content-type') || '', /text\/event-stream/);
        const reader = events.body.getReader();
        const { value } = await reader.read();
        assert.match(new TextDecoder().decode(value), /^data: /);
        await reader.cancel();
    } finally {
        await worker.terminate();
    }
});

test('a busy configured port falls back to an ephemeral one', async () => {
    const blocker = http.createServer(() => {});
    await new Promise((res) => blocker.listen(0, '127.0.0.1', res));
    const busy = blocker.address().port;

    const { worker, port } = await bootDashboard({ host: '127.0.0.1', port: busy, reportPath: null });
    try {
        assert.notEqual(port, busy, 'dashboard should have fallen back to a different port');
        assert.ok(port > 0);
        const res = await fetch(`http://127.0.0.1:${port}/api/state`);
        assert.equal(res.status, 200);
    } finally {
        await worker.terminate();
        await new Promise((res) => blocker.close(res));
    }
});
