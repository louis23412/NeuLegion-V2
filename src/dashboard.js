// NeuLegion monitor dashboard (ROADMAP P1-1).
//
// A single, self-contained HTML page served by http_server_worker.js at `/`.
// It has NO external dependencies, no build step and no client framework: the
// worker streams state over same-origin JSON + Server-Sent Events, and the page
// renders it. This replaces the old raw JSON-over-LAN broadcast: the dashboard
// is served on loopback by default, so there is no CORS allow-list and nothing
// is exposed to the network.
//
// The whole UI is read-only — GET endpoints only.

export const renderDashboardHtml = ({ title = 'NeuLegion — monitor' } = {}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0f14; color: #d7e0ea; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { padding: 10px 16px; border-bottom: 1px solid #1d2733; display: flex; gap: 18px; align-items: baseline; flex-wrap: wrap; position: sticky; top: 0; background: #0b0f14; z-index: 2; }
  header h1 { font-size: 14px; margin: 0; color: #7fd1ff; letter-spacing: .04em; }
  .status { color: #8aa0b4; }
  .status b { color: #e6eef7; font-weight: 600; }
  main { padding: 12px 16px 40px; display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
  section { border: 1px solid #1d2733; border-radius: 6px; padding: 10px 12px; min-width: 0; }
  section h2 { margin: 0 0 8px; font-size: 12px; color: #8aa0b4; text-transform: uppercase; letter-spacing: .08em; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: right; padding: 2px 6px; white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  thead th { color: #7f93a7; border-bottom: 1px solid #1d2733; position: sticky; top: 0; background: #0b0f14; }
  tbody tr:nth-child(odd) { background: #0e141b; }
  .buy { color: #4ade80; } .sell { color: #f87171; }
  .muted { color: #6b7f92; }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; }
  .kv span:nth-child(odd) { color: #8aa0b4; }
  .alert { padding: 6px 8px; border-radius: 4px; margin-bottom: 6px; border-left: 3px solid #64748b; background: #101923; }
  .alert.warning { border-color: #f59e0b; } .alert.critical { border-color: #ef4444; } .alert.info { border-color: #38bdf8; }
  .ok { color: #4ade80; }
  canvas { display: block; width: 100%; height: 70px; }
  .schol { max-height: 380px; overflow: auto; }
  .bar { height: 8px; background: #1d2733; border-radius: 3px; overflow: hidden; display: inline-block; width: 80px; vertical-align: middle; }
  .bar > i { display: block; height: 100%; background: #38bdf8; }
</style>
</head>
<body>
<header>
  <h1>NeuLegion</h1>
  <span class="status">status <b id="statusEl">connecting…</b></span>
  <span class="status">candle <b id="candleEl">–</b></span>
  <span class="status">runtime <b id="runtimeEl">–</b></span>
  <span class="status">population <b id="popEl">–</b></span>
  <span class="status" id="liveEl">live</span>
</header>
<main>
  <section>
    <h2>Consensus</h2>
    <div class="kv" id="consensusEl"></div>
  </section>
  <section>
    <h2>Last candles</h2>
    <canvas id="sparkEl" width="600" height="140"></canvas>
    <div class="kv" id="candlesEl"></div>
  </section>
  <section>
    <h2>Run-integrity &amp; observer alerts</h2>
    <div id="alertsEl" class="muted">no alerts</div>
    <div class="kv" id="integrityEl"></div>
  </section>
  <section>
    <h2>Influence</h2>
    <div class="kv" id="influenceEl"></div>
  </section>
  <section style="grid-column: 1 / -1;">
    <h2>Controllers</h2>
    <div class="schol">
      <table>
        <thead><tr><th>id</th><th>tier</th><th>dir</th><th>score</th><th>prob</th><th>influence</th><th>speed ms</th><th>cv</th><th>p/T</th></tr></thead>
        <tbody id="rowsEl"></tbody>
      </table>
    </div>
  </section>
</main>
<script>
(function () {
  "use strict";
  var state = null;
  var alerts = [];
  var $ = function (id) { return document.getElementById(id); };
  function fmt(x, d) { return (typeof x === "number" && isFinite(x)) ? x.toFixed(d == null ? 2 : d) : "–"; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function kv(el, pairs) {
    el.innerHTML = pairs.map(function (p) {
      return "<span>" + esc(p[0]) + "</span><span>" + esc(p[1]) + "</span>";
    }).join("");
  }
  function setStatus(s) { state = s; render(); }

  function render() {
    var ov = (state && state.overview) || {};
    $("statusEl").textContent = ov.status || "–";
    $("candleEl").textContent = ov.candleCounter == null ? "–" : ov.candleCounter;
    $("runtimeEl").textContent = (ov.runtimeSeconds == null ? "–" : fmt(ov.runtimeSeconds, 1) + "s");
    $("popEl").textContent = ov.population == null ? "–" : ov.population;

    var c = (state && state.consensus) || {};
    kv($("consensusEl"), [
      ["direction", c.direction || "–"],
      ["confidence", c.confidence == null ? "–" : fmt(c.confidence, 2)],
      ["entry", c.entryPrice == null ? "–" : fmt(c.entryPrice, 4)],
      ["exit", c.exitPrice == null ? "–" : fmt(c.exitPrice, 4)],
      ["stop", c.stopLoss == null ? "–" : fmt(c.stopLoss, 4)],
      ["profit %", c.profitPct == null ? "–" : fmt(c.profitPct, 3)],
      ["stop %", c.stopLossPct == null ? "–" : fmt(c.stopLossPct, 3)],
    ]);

    var candles = (state && state.lastCandles) || [];
    if (candles.length) {
      var last = candles[candles.length - 1];
      kv($("candlesEl"), [
        ["time", last.id || "–"],
        ["close", fmt(last.close, 4)],
        ["volume", fmt(last.volume, 0)],
      ]);
      drawSpark(candles);
    }

    var firing = alerts || [];
    if (firing.length) {
      $("alertsEl").innerHTML = firing.map(function (a) {
        return '<div class="alert ' + esc(a.severity) + '">' + esc(a.message) + "</div>";
      }).join("");
    } else {
      $("alertsEl").innerHTML = '<span class="ok">no alerts</span>';
    }
    kv($("integrityEl"), [
      ["slot failures (last batch)", ov.controllerFailures == null ? "–" : ov.controllerFailures],
      ["slot failures (total)", ov.totalControllerFailures == null ? "–" : ov.totalControllerFailures],
      ["consolidation failures", ov.consolidationFailures == null ? "–" : ov.consolidationFailures],
      ["failed batches", ov.failedBatches == null ? "–" : ov.failedBatches],
      ["quarantined rows", ov.quarantinedRows == null ? "–" : ov.quarantinedRows],
      ["candle repairs", ov.candleRepairs == null ? "–" : ov.candleRepairs],
      ["malformed lines", ov.malformedCandleLines == null ? "–" : ov.malformedCandleLines],
    ]);

    var voters = ((state && state.controllers && state.controllers.positive && state.controllers.positive.voters) || [])
      .concat((state && state.controllers && state.controllers.negative && state.controllers.negative.voters) || []);
    var weights = voters.map(function (v) { return (typeof v.influence === "number" && v.influence > 0) ? v.influence : 0; });
    var total = weights.reduce(function (a, b) { return a + b; }, 0);
    var hhi = 0, gini = 0, maxShare = 0;
    if (total > 0) {
      var sumSq = 0;
      for (var i = 0; i < weights.length; i++) { var s = weights[i] / total; sumSq += s * s; if (s > maxShare) maxShare = s; }
      hhi = sumSq;
      var sorted = weights.slice().sort(function (a, b) { return a - b; });
      var n = sorted.length, acc = 0;
      for (var k = 0; k < n; k++) acc += (k + 1) * sorted[k];
      gini = (2 * acc) / (n * total) - (n + 1) / n;
    }
    kv($("influenceEl"), [
      ["voters", voters.length],
      ["HHI", fmt(hhi, 4)],
      ["effective voters", hhi > 0 ? fmt(1 / hhi, 2) : "–"],
      ["Gini", fmt(gini, 4)],
      ["largest share", total > 0 ? fmt(maxShare * 100, 1) + "%" : "–"],
    ]);

    var rows = voters.slice().sort(function (a, b) {
      return (Number(b.influence) || 0) - (Number(a.influence) || 0);
    }).slice(0, 60).map(function (v) {
      var dir = v.polarity === "negative" ? "SELL" : "BUY";
      return "<tr>"
        + "<td>" + esc(v.id) + "</td>"
        + "<td>" + esc(v.tier) + "</td>"
        + '<td class="' + (dir === "BUY" ? "buy" : "sell") + '">' + dir + "</td>"
        + "<td>" + fmt(v.stats && v.stats.accuracyScore, 2) + "</td>"
        + "<td>" + fmt(v.stats && v.stats.probability, 2) + "</td>"
        + '<td><span class="bar"><i style="width:' + Math.min(100, (Number(v.influence) || 0)) + '%"></i></span> ' + fmt(v.influence, 2) + "</td>"
        + "<td>" + fmt(v.signalSpeed, 4) + "</td>"
        + "<td>" + esc((v.memory && v.memory.memoryConnections) == null ? 0 : v.memory.memoryConnections) + "</td>"
        + "<td>" + esc((v.stats && v.stats.pendingClosedTrades) == null ? 0 : v.stats.pendingClosedTrades)
        + "/" + esc((v.params && v.params.candlesUsed) == null ? 0 : v.params.candlesUsed) + "</td>"
        + "</tr>";
    });
    $("rowsEl").innerHTML = rows.join("");
  }

  function drawSpark(candles) {
    var cv = $("sparkEl");
    if (!cv || !cv.getContext) return;
    var ctx = cv.getContext("2d");
    var w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    var closes = candles.map(function (c) { return Number(c.close); }).filter(function (x) { return isFinite(x); });
    if (closes.length < 2) return;
    var lo = Math.min.apply(null, closes), hi = Math.max.apply(null, closes);
    if (hi === lo) { hi = lo + 1; }
    ctx.strokeStyle = "#38bdf8"; ctx.lineWidth = 2; ctx.beginPath();
    closes.forEach(function (v, i) {
      var x = (i / (closes.length - 1)) * (w - 8) + 4;
      var y = h - 6 - ((v - lo) / (hi - lo)) * (h - 12);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function connect() {
    try {
      var es = new EventSource("/api/events");
      es.onmessage = function (ev) { try { var m = JSON.parse(ev.data); state = m; if (m.alerts) alerts = m.alerts; render(); $("liveEl").textContent = "live"; } catch (e) {} };
      es.onerror = function () { $("liveEl").textContent = "reconnecting…"; };
    } catch (e) {
      poll();
    }
  }
  function poll() {
    fetch("/api/state").then(function (r) { return r.json(); }).then(function (m) { state = m; if (m.alerts) alerts = m.alerts; render(); }).catch(function () {});
    setTimeout(poll, 2000);
  }
  connect();
  fetch("/api/state").then(function (r) { return r.json(); }).then(function (m) { state = m; if (m.alerts) alerts = m.alerts; render(); }).catch(function () {});
})();
</script>
</body>
</html>
`;
