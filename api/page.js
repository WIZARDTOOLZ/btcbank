import { kv } from "@vercel/kv";

function fmtWbtc(val) {
  const n = parseFloat(val ?? 0);
  if (isNaN(n)) return "0.00000000";
  return n.toFixed(8);
}

function fmtUsd(val) {
  const n = parseFloat(val ?? 0);
  if (isNaN(n)) return "$0.00";
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtNum(val) {
  const n = parseInt(val ?? 0);
  if (isNaN(n)) return "0";
  return n.toLocaleString("en-US");
}

function shortenAddr(addr) {
  if (!addr || addr.length < 12) return addr ?? "—";
  return addr.slice(0, 4) + "…" + addr.slice(-4);
}

function timeAgo(ts) {
  if (!ts) return "never";
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return sec + "s ago";
  if (sec < 3600) return Math.floor(sec / 60) + "m ago";
  if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
  return Math.floor(sec / 86400) + "d ago";
}

// ─── PAGES ───────────────────────────────────────────────────────────────────

function renderPaidSummary(data, transparent) {
  const s = data?.stats ?? {};
  const txs = data?.txs ?? [];
  const updatedAt = data?.updatedAt;
  const isLive = updatedAt && (Date.now() - updatedAt) < 120000;
  const bg = transparent ? "transparent" : "#0d0d0d";

  const recentTxRows = txs.slice(0, 10).map(tx => `
    <tr>
      <td>${shortenAddr(tx.wallet)}</td>
      <td>${fmtWbtc(tx.amountWbtc)} WBTC</td>
      <td>${fmtUsd(tx.amountUsd)}</td>
      <td><a href="https://solscan.io/tx/${tx.sig}" target="_blank" rel="noopener">${shortenAddr(tx.sig)}</a></td>
    </tr>`).join("") || `<tr><td colspan="4" style="text-align:center;opacity:.5">No transactions yet</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Bitcoin Bank – $BTCBANK Live</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: ${bg};
    color: #f0f0f0;
    font-family: 'Segoe UI', system-ui, sans-serif;
    font-size: 14px;
    padding: 20px;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
  }
  .header h1 { font-size: 20px; font-weight: 700; color: #f7931a; }
  .badge {
    font-size: 11px;
    font-weight: 700;
    padding: 3px 10px;
    border-radius: 20px;
    text-transform: uppercase;
    letter-spacing: .05em;
  }
  .badge.live   { background: #1a3a1a; color: #4ade80; border: 1px solid #22c55e; }
  .badge.offline{ background: #2a1a1a; color: #f87171; border: 1px solid #ef4444; }
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }
  .stat {
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    padding: 14px 16px;
  }
  .stat .label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
  .stat .value { font-size: 20px; font-weight: 700; color: #fff; }
  .stat .value.orange { color: #f7931a; }
  .stat .value.green  { color: #4ade80; }
  .txs-title { font-size: 13px; color: #888; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; color: #666; padding: 0 8px 8px; text-transform: uppercase; }
  td { padding: 8px; border-top: 1px solid #1e1e1e; font-size: 13px; color: #ccc; }
  td a { color: #f7931a; text-decoration: none; }
  td a:hover { text-decoration: underline; }
  .footer { margin-top: 16px; font-size: 11px; color: #555; text-align: right; }
</style>
</head>
<body>
<div class="header">
  <h1>₿ Bitcoin Bank – $BTCBANK</h1>
  <span class="badge ${isLive ? 'live' : 'offline'}">${isLive ? '● LIVE' : '○ OFFLINE'}</span>
</div>
<div class="stats">
  <div class="stat">
    <div class="label">All-Time Paid (USD)</div>
    <div class="value orange">${fmtUsd(s.allTimeUsd)}</div>
  </div>
  <div class="stat">
    <div class="label">All-Time Paid (WBTC)</div>
    <div class="value orange">${fmtWbtc(s.allTimeWbtc)}</div>
  </div>
  <div class="stat">
    <div class="label">Holders Paid</div>
    <div class="value">${fmtNum(s.holdersPaid)}</div>
  </div>
  <div class="stat">
    <div class="label">Rounds Completed</div>
    <div class="value">${fmtNum(s.roundsCompleted)}</div>
  </div>
  <div class="stat">
    <div class="label">This Round</div>
    <div class="value green">${fmtNum(s.paidThisRound)} paid</div>
  </div>
  <div class="stat">
    <div class="label">Still Owed</div>
    <div class="value">${fmtNum(s.stillLeft)} wallets</div>
  </div>
</div>
<div class="txs-title">Recent Transactions</div>
<table>
  <thead><tr><th>Wallet</th><th>WBTC</th><th>USD</th><th>TX</th></tr></thead>
  <tbody>${recentTxRows}</tbody>
</table>
<div class="footer">Updated ${timeAgo(updatedAt)}</div>
<script>
  // Auto-reconnect SSE for live updates
  function connect() {
    const es = new EventSource('/api/stream');
    es.onmessage = () => location.reload();
    es.addEventListener('reconnect', () => { es.close(); setTimeout(connect, 2000); });
    es.onerror = () => { es.close(); setTimeout(connect, 5000); };
  }
  connect();
</script>
</body>
</html>`;
}

function renderOverlay(data, transparent) {
  const s = data?.stats ?? {};
  const updatedAt = data?.updatedAt;
  const isLive = updatedAt && (Date.now() - updatedAt) < 120000;
  const bg = transparent ? "transparent" : "#0d0d0d";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>BTCBANK Overlay</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: ${bg};
    color: #f0f0f0;
    font-family: 'Segoe UI', system-ui, sans-serif;
    padding: 12px 16px;
    display: inline-block;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 20px;
    background: rgba(0,0,0,0.75);
    border: 1px solid #f7931a44;
    border-radius: 8px;
    padding: 10px 18px;
    backdrop-filter: blur(4px);
  }
  .logo { font-size: 18px; font-weight: 800; color: #f7931a; white-space: nowrap; }
  .divider { width: 1px; height: 28px; background: #333; }
  .stat { display: flex; flex-direction: column; align-items: center; }
  .stat .lbl { font-size: 9px; color: #888; text-transform: uppercase; letter-spacing: .06em; }
  .stat .val { font-size: 15px; font-weight: 700; color: #fff; }
  .stat .val.orange { color: #f7931a; }
  .stat .val.green  { color: #4ade80; }
  .badge {
    font-size: 9px; font-weight: 800; padding: 2px 8px;
    border-radius: 20px; text-transform: uppercase; letter-spacing: .05em;
  }
  .badge.live    { background: #1a3a1a; color: #4ade80; border: 1px solid #22c55e; }
  .badge.offline { background: #2a1a1a; color: #f87171; border: 1px solid #ef4444; }
</style>
</head>
<body>
<div class="bar">
  <div class="logo">₿ $BTCBANK</div>
  <div class="divider"></div>
  <div class="stat">
    <span class="lbl">All-Time</span>
    <span class="val orange">${fmtUsd(s.allTimeUsd)}</span>
  </div>
  <div class="divider"></div>
  <div class="stat">
    <span class="lbl">WBTC Paid</span>
    <span class="val orange">${fmtWbtc(s.allTimeWbtc)}</span>
  </div>
  <div class="divider"></div>
  <div class="stat">
    <span class="lbl">Holders</span>
    <span class="val">${fmtNum(s.holdersPaid)}</span>
  </div>
  <div class="divider"></div>
  <div class="stat">
    <span class="lbl">This Round</span>
    <span class="val green">${fmtNum(s.paidThisRound)} paid</span>
  </div>
  <div class="divider"></div>
  <span class="badge ${isLive ? 'live' : 'offline'}">${isLive ? '● LIVE' : '○ OFFLINE'}</span>
</div>
<script>
  function connect() {
    const es = new EventSource('/api/stream');
    es.onmessage = () => location.reload();
    es.addEventListener('reconnect', () => { es.close(); setTimeout(connect, 2000); });
    es.onerror = () => { es.close(); setTimeout(connect, 5000); };
  }
  connect();
</script>
</body>
</html>`;
}

function renderDashboard(data, transparent) {
  const s = data?.stats ?? {};
  const holders = data?.holders ?? [];
  const txs = data?.txs ?? [];
  const updatedAt = data?.updatedAt;
  const isLive = updatedAt && (Date.now() - updatedAt) < 120000;
  const bg = transparent ? "transparent" : "#0d0d0d";

  const holderRows = holders.slice(0, 50).map((h, i) => `
    <tr>
      <td style="color:#555">${i + 1}</td>
      <td>${shortenAddr(h.wallet)}</td>
      <td>${fmtNum(h.tokens)}</td>
      <td style="color:${h.qualified ? '#4ade80' : '#f87171'}">${h.qualified ? '✓' : '✗'}</td>
    </tr>`).join("") || `<tr><td colspan="4" style="text-align:center;opacity:.5">No holder data yet</td></tr>`;

  const txRows = txs.slice(0, 20).map(tx => `
    <tr>
      <td>${shortenAddr(tx.wallet)}</td>
      <td style="color:#f7931a">${fmtWbtc(tx.amountWbtc)}</td>
      <td>${fmtUsd(tx.amountUsd)}</td>
      <td><a href="https://solscan.io/tx/${tx.sig}" target="_blank" rel="noopener">${shortenAddr(tx.sig)}</a></td>
    </tr>`).join("") || `<tr><td colspan="4" style="text-align:center;opacity:.5">No transactions yet</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Bitcoin Bank Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: ${bg}; color: #f0f0f0; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; }
  .topbar {
    background: #111;
    border-bottom: 1px solid #222;
    padding: 14px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .topbar h1 { font-size: 18px; font-weight: 800; color: #f7931a; }
  .badge {
    font-size: 11px; font-weight: 700; padding: 3px 12px;
    border-radius: 20px; text-transform: uppercase; letter-spacing: .05em;
  }
  .badge.live    { background: #1a3a1a; color: #4ade80; border: 1px solid #22c55e; }
  .badge.offline { background: #2a1a1a; color: #f87171; border: 1px solid #ef4444; }
  .content { padding: 24px; }
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 14px;
    margin-bottom: 28px;
  }
  .stat {
    background: #161616;
    border: 1px solid #252525;
    border-radius: 10px;
    padding: 16px 18px;
  }
  .stat .lbl { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 6px; }
  .stat .val { font-size: 22px; font-weight: 800; color: #fff; }
  .stat .val.orange { color: #f7931a; }
  .stat .val.green  { color: #4ade80; }
  .stat .val.red    { color: #f87171; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 700px) { .cols { grid-template-columns: 1fr; } }
  .panel { background: #111; border: 1px solid #1e1e1e; border-radius: 10px; overflow: hidden; }
  .panel-title {
    padding: 12px 16px;
    font-size: 12px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .06em; color: #666;
    border-bottom: 1px solid #1e1e1e;
  }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 10px; color: #555; padding: 8px 12px; text-transform: uppercase; }
  td { padding: 8px 12px; border-top: 1px solid #1a1a1a; font-size: 12px; color: #bbb; }
  td a { color: #f7931a; text-decoration: none; }
  td a:hover { text-decoration: underline; }
  .footer { margin-top: 16px; font-size: 11px; color: #444; text-align: right; }
</style>
</head>
<body>
<div class="topbar">
  <h1>₿ Bitcoin Bank – $BTCBANK Dashboard</h1>
  <span class="badge ${isLive ? 'live' : 'offline'}">${isLive ? '● LIVE' : '○ OFFLINE'}</span>
</div>
<div class="content">
  <div class="stats">
    <div class="stat"><div class="lbl">All-Time USD</div><div class="val orange">${fmtUsd(s.allTimeUsd)}</div></div>
    <div class="stat"><div class="lbl">All-Time WBTC</div><div class="val orange">${fmtWbtc(s.allTimeWbtc)}</div></div>
    <div class="stat"><div class="lbl">Holders Paid</div><div class="val">${fmtNum(s.holdersPaid)}</div></div>
    <div class="stat"><div class="lbl">Rounds Done</div><div class="val">${fmtNum(s.roundsCompleted)}</div></div>
    <div class="stat"><div class="lbl">Paid This Round</div><div class="val green">${fmtNum(s.paidThisRound)}</div></div>
    <div class="stat"><div class="lbl">Still Left</div><div class="val red">${fmtNum(s.stillLeft)}</div></div>
    <div class="stat"><div class="lbl">Qualified</div><div class="val">${fmtNum(s.qualifiedThisRound)}</div></div>
    <div class="stat"><div class="lbl">Backlog Wallets</div><div class="val">${fmtNum(s.backlogWallets)}</div></div>
  </div>
  <div class="cols">
    <div class="panel">
      <div class="panel-title">Recent Transactions</div>
      <table>
        <thead><tr><th>Wallet</th><th>WBTC</th><th>USD</th><th>TX</th></tr></thead>
        <tbody>${txRows}</tbody>
      </table>
    </div>
    <div class="panel">
      <div class="panel-title">Top Holders (${holders.length} total)</div>
      <table>
        <thead><tr><th>#</th><th>Wallet</th><th>Tokens</th><th>Q</th></tr></thead>
        <tbody>${holderRows}</tbody>
      </table>
    </div>
  </div>
  <div class="footer">Last update: ${timeAgo(updatedAt)}</div>
</div>
<script>
  function connect() {
    const es = new EventSource('/api/stream');
    es.onmessage = () => location.reload();
    es.addEventListener('reconnect', () => { es.close(); setTimeout(connect, 2000); });
    es.onerror = () => { es.close(); setTimeout(connect, 5000); };
  }
  connect();
</script>
</body>
</html>`;
}

function renderWalletCheck(data, wallet) {
  const holders = data?.holders ?? [];
  const updatedAt = data?.updatedAt;
  const isLive = updatedAt && (Date.now() - updatedAt) < 120000;

  let result = null;
  if (wallet) {
    result = holders.find(h => h.wallet?.toLowerCase() === wallet.toLowerCase()) ?? null;
  }

  const resultHtml = !wallet ? "" : result
    ? `<div class="result found">
        <div class="r-label">Wallet Found ✓</div>
        <div class="r-addr">${wallet}</div>
        <div class="r-row"><span>Tokens:</span><strong>${fmtNum(result.tokens)}</strong></div>
        <div class="r-row"><span>Qualified:</span><strong style="color:${result.qualified ? '#4ade80' : '#f87171'}">${result.qualified ? 'YES' : 'NO'}</strong></div>
       </div>`
    : `<div class="result notfound">Wallet not found in current holder list.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>BTCBANK Wallet Check</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d0d0d; color: #f0f0f0; font-family: 'Segoe UI', system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
  .card { background: #161616; border: 1px solid #252525; border-radius: 14px; padding: 32px; width: 100%; max-width: 480px; }
  h1 { font-size: 20px; font-weight: 800; color: #f7931a; margin-bottom: 6px; }
  .sub { font-size: 13px; color: #666; margin-bottom: 24px; }
  .badge {
    display: inline-block; font-size: 10px; font-weight: 700; padding: 2px 10px;
    border-radius: 20px; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 20px;
  }
  .badge.live    { background: #1a3a1a; color: #4ade80; border: 1px solid #22c55e; }
  .badge.offline { background: #2a1a1a; color: #f87171; border: 1px solid #ef4444; }
  .input-row { display: flex; gap: 8px; }
  input {
    flex: 1; background: #0d0d0d; border: 1px solid #333; border-radius: 8px;
    color: #fff; padding: 10px 14px; font-size: 13px; outline: none;
  }
  input:focus { border-color: #f7931a; }
  button {
    background: #f7931a; color: #000; font-weight: 700; font-size: 13px;
    padding: 10px 18px; border: none; border-radius: 8px; cursor: pointer;
  }
  button:hover { background: #e8841a; }
  .result { margin-top: 20px; padding: 16px; border-radius: 8px; }
  .result.found { background: #0d1f0d; border: 1px solid #22c55e44; }
  .result.notfound { background: #1f0d0d; border: 1px solid #ef444444; color: #f87171; font-size: 13px; }
  .r-label { font-size: 11px; color: #4ade80; text-transform: uppercase; margin-bottom: 6px; }
  .r-addr { font-size: 11px; color: #888; margin-bottom: 10px; word-break: break-all; }
  .r-row { display: flex; justify-content: space-between; font-size: 14px; padding: 4px 0; }
  .r-row span { color: #888; }
</style>
</head>
<body>
<div class="card">
  <h1>₿ $BTCBANK Wallet Check</h1>
  <p class="sub">Check if your wallet qualifies for WBTC rewards</p>
  <span class="badge ${isLive ? 'live' : 'offline'}">${isLive ? '● LIVE' : '○ OFFLINE'}</span>
  <form method="GET" action="/wallet-check">
    <div class="input-row">
      <input name="wallet" type="text" placeholder="Enter Solana wallet address" value="${wallet ?? ''}" autocomplete="off" spellcheck="false"/>
      <button type="submit">Check</button>
    </div>
  </form>
  ${resultHtml}
</div>
</body>
</html>`;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

const PAGE_MAP = {
  "paid-summary": "paid-summary",
  overlay: "overlay",
  dashboard: "dashboard",
  "wallet-check": "wallet-check",
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const reqUrl = new URL(req.url || "/", "http://localhost");
  const page = reqUrl.searchParams.get("page") || "paid-summary";
  const transparent = reqUrl.searchParams.has("transparent");
  const wallet = reqUrl.searchParams.get("wallet") ?? null;

  if (!PAGE_MAP[page]) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    res.end("Unknown page");
    return;
  }

  let data = null;
  try {
    data = await kv.get("btcbank:live");
  } catch {
    // serve page with null data (shows OFFLINE, dashes)
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  switch (page) {
    case "paid-summary":
      res.end(renderPaidSummary(data, transparent));
      break;
    case "overlay":
      res.end(renderOverlay(data, transparent));
      break;
    case "dashboard":
      res.end(renderDashboard(data, transparent));
      break;
    case "wallet-check":
      res.end(renderWalletCheck(data, wallet));
      break;
  }
}
