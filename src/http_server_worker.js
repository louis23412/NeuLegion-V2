// NeuLegion legion component: the read-only monitor dashboard server
// (ROADMAP P1-1).
//
// Replaces the old raw JSON-over-LAN broadcast. It serves:
//   GET /             -> the self-contained dashboard page (src/dashboard.js)
//   GET /api/state    -> the latest full snapshot as JSON
//   GET /api/events   -> the same snapshots as a Server-Sent-Events stream
//   GET /api/report   -> the run report JSON (if a report path was provided)
//
// Bound to loopback by default, so there is no CORS allow-list and nothing is
// exposed to the network. GET only; the run is never controlled from here.
// If the configured port is taken the server falls back to an ephemeral port
// and reports the real one back to the parent — a dashboard bind failure must
// never take down a run.

import http from 'node:http';
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { renderDashboardHtml } from './dashboard.js';

const { host = '127.0.0.1', port = 3000, reportPath = null } = workerData || {};

const current = {
    overview: { status: 'initializing', runtimeSeconds: 0 },
    consensus: {},
    lastCandles: [],
    controllers: { positive: { voters: [] }, negative: { voters: [] } },
    alerts: [],
};

const clients = new Set();

const payload = () => current;

const broadcast = () => {
    const data = `data: ${JSON.stringify(payload())}\n\n`;
    for (const res of clients) {
        try { res.write(data); } catch { clients.delete(res); }
    }
};

parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'UPDATE_FULL_STATE') {
        current.overview = msg.overview || current.overview;
        current.consensus = msg.consensus || {};
        current.lastCandles = msg.lastCandles || [];
        current.controllers = msg.controllers || current.controllers;
        if (Array.isArray(msg.alerts)) current.alerts = msg.alerts;
        broadcast();
    } else if (msg.type === 'UPDATE_STATUS') {
        current.overview = { ...current.overview, status: msg.status, runtimeSeconds: msg.runtimeSeconds };
        broadcast();
    }
});

const sendJson = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
};

const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET' });
        res.end('Method Not Allowed');
        return;
    }

    if (url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(renderDashboardHtml());
        return;
    }

    if (url === '/api/state') {
        sendJson(res, 200, payload());
        return;
    }

    if (url === '/api/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify(payload())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
    }

    if (url === '/api/report') {
        if (!reportPath) { sendJson(res, 404, { error: 'no report' }); return; }
        try {
            sendJson(res, 200, JSON.parse(fs.readFileSync(reportPath, 'utf8')));
        } catch {
            sendJson(res, 404, { error: 'report unavailable' });
        }
        return;
    }

    sendJson(res, 404, { error: 'Not Found' });
});

// Heartbeat so idle SSE connections are not reaped (and the page can detect a
// dead stream).
const heartbeat = setInterval(() => {
    for (const res of clients) {
        try { res.write(': ping\n\n'); } catch { clients.delete(res); }
    }
}, 15000);
heartbeat.unref?.();

let bound = false;
server.on('error', (err) => {
    if (!bound && err && err.code === 'EADDRINUSE' && port !== 0) {
        // Configured port is busy: fall back to an ephemeral port rather than
        // failing the run.
        try { server.listen(0, host); return; } catch { /* fall through */ }
    }
    console.error('[HTTP Worker] Error:', err && err.message);
});

server.on('listening', () => {
    bound = true;
    const address = server.address();
    const actualPort = address && typeof address === 'object' ? address.port : port;
    parentPort.postMessage({ type: 'LISTENING', host, port: actualPort });
});

server.listen(port, host);
