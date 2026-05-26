import { getLivePayload } from "./_shared.js";

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

function renderHistory(data, transparent) {
  const s = data?.stats ?? {};
  const updatedAt = data?.updatedAt;
  const isLive = updatedAt && (Date.now() - updatedAt) < 120000;
  const bg = transparent ? "transparent" : "#0b0d08";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>BTCBANK Thesis - Bitcoin vs Memecoins</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: ${bg};
    --panel: rgba(17, 19, 14, 0.96);
    --line: rgba(247, 147, 26, 0.24);
    --text: #f7f0d8;
    --muted: #d0bb8a;
    --soft: #8f936f;
    --orange: #f7931a;
    --green: #87ff39;
    --blue: #7ed0ff;
    --shadow: 0 18px 48px rgba(0, 0, 0, 0.38);
  }
  body {
    min-height: 100vh;
    background:
      radial-gradient(circle at top left, rgba(247, 147, 26, 0.16), transparent 26%),
      radial-gradient(circle at top right, rgba(135, 255, 57, 0.10), transparent 24%),
      linear-gradient(180deg, #11140f 0%, var(--bg) 58%);
    color: var(--text);
    font-family: "Segoe UI", system-ui, sans-serif;
  }
  a { color: inherit; }
  .shell {
    width: min(1500px, calc(100% - 36px));
    margin: 20px auto 28px;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    background: rgba(10, 12, 9, 0.88);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 18px 22px;
    box-shadow: var(--shadow);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .brand-mark {
    width: 48px;
    height: 48px;
    border-radius: 14px;
    background: linear-gradient(135deg, rgba(247, 147, 26, 0.22), rgba(135, 255, 57, 0.12));
    border: 1px solid rgba(247, 147, 26, 0.34);
    display: grid;
    place-items: center;
    font-size: 28px;
    font-weight: 900;
    color: var(--orange);
  }
  .brand-copy h1 {
    font-size: 26px;
    line-height: 1;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--orange);
  }
  .brand-copy p {
    margin-top: 6px;
    font-size: 14px;
    color: var(--muted);
  }
  .topbar-right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: rgba(18, 21, 15, 0.96);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text);
  }
  .page-nav {
    margin-top: 14px;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .page-link {
    display: inline-flex;
    align-items: center;
    padding: 9px 14px;
    border-radius: 999px;
    border: 1px solid rgba(247, 147, 26, 0.18);
    background: rgba(255, 255, 255, 0.03);
    color: var(--muted);
    text-decoration: none;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .page-link.active {
    background: rgba(247, 147, 26, 0.16);
    color: var(--text);
    border-color: rgba(247, 147, 26, 0.34);
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: ${isLive ? "#87ff39" : "#f87171"};
    box-shadow: 0 0 14px ${isLive ? "rgba(135, 255, 57, 0.55)" : "rgba(248, 113, 113, 0.45)"};
  }
  .hero {
    margin-top: 18px;
    display: grid;
    grid-template-columns: 1.2fr 0.8fr;
    gap: 18px;
  }
  .hero-main,
  .hero-side,
  .column,
  .sources {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 22px;
    box-shadow: var(--shadow);
  }
  .hero-main {
    padding: 28px;
  }
  .eyebrow {
    color: var(--green);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 12px;
    font-weight: 800;
  }
  .hero-main h2 {
    margin-top: 14px;
    font-size: clamp(34px, 4vw, 56px);
    line-height: 0.95;
    max-width: 12ch;
    letter-spacing: -0.03em;
  }
  .hero-main p {
    margin-top: 18px;
    max-width: 64ch;
    font-size: 18px;
    line-height: 1.6;
    color: var(--muted);
  }
  .coin-row {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 22px;
  }
  .art-grid {
    margin-top: 20px;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }
  .art-card {
    position: relative;
    overflow: hidden;
    min-height: 148px;
    border-radius: 18px;
    border: 1px solid rgba(247, 147, 26, 0.16);
    background:
      radial-gradient(circle at top right, rgba(255,255,255,0.12), transparent 28%),
      linear-gradient(135deg, rgba(247, 147, 26, 0.16), rgba(15, 18, 12, 0.92));
    padding: 18px;
  }
  .art-card.memes {
    background:
      radial-gradient(circle at top right, rgba(135,255,57,0.12), transparent 28%),
      linear-gradient(135deg, rgba(135,255,57,0.12), rgba(15, 18, 12, 0.92));
  }
  .art-card.hybrid {
    background:
      radial-gradient(circle at top right, rgba(126,208,255,0.12), transparent 28%),
      linear-gradient(135deg, rgba(247,147,26,0.10), rgba(15, 18, 12, 0.92));
  }
  .art-card img {
    position: absolute;
    right: 10px;
    bottom: 10px;
    width: 86px;
    height: 86px;
    object-fit: contain;
    filter: drop-shadow(0 10px 18px rgba(0,0,0,0.4));
  }
  .art-card strong {
    display: block;
    max-width: 10ch;
    font-size: 22px;
    line-height: 1;
  }
  .art-card span {
    display: block;
    margin-top: 10px;
    max-width: 18ch;
    font-size: 13px;
    line-height: 1.5;
    color: var(--muted);
  }
  .coin {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 16px;
    border: 1px solid rgba(247, 147, 26, 0.16);
    background: rgba(255, 255, 255, 0.03);
  }
  .coin img {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    object-fit: cover;
  }
  .coin span {
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .hero-side {
    padding: 24px;
    display: grid;
    grid-template-rows: auto auto 1fr;
    gap: 14px;
  }
  .side-title {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--green);
    font-weight: 800;
  }
  .thesis {
    padding: 18px;
    border-radius: 18px;
    border: 1px solid rgba(247, 147, 26, 0.18);
    background: linear-gradient(180deg, rgba(247, 147, 26, 0.08), rgba(255, 255, 255, 0.02));
  }
  .thesis h3 {
    font-size: 22px;
    line-height: 1.12;
  }
  .thesis p {
    margin-top: 12px;
    font-size: 15px;
    line-height: 1.6;
    color: var(--muted);
  }
  .live-stats {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .live-stat {
    padding: 14px;
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.025);
    border: 1px solid rgba(135, 255, 57, 0.14);
  }
  .live-stat .lbl {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--soft);
    margin-bottom: 6px;
  }
  .live-stat .val {
    font-size: 26px;
    font-weight: 900;
    line-height: 1;
    color: var(--text);
  }
  .live-stat .val.orange { color: var(--orange); }
  .live-stat .val.green { color: var(--green); }
  .live-stat .val.blue { color: var(--blue); }
  .compare {
    margin-top: 18px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px;
  }
  .column {
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .column-head {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .column-head img {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    object-fit: cover;
    background: rgba(255, 255, 255, 0.04);
  }
  .column-head h3 {
    font-size: 28px;
    line-height: 1;
  }
  .column-head p {
    margin-top: 6px;
    font-size: 14px;
    line-height: 1.5;
    color: var(--muted);
  }
  .story-card {
    padding: 18px 18px 20px;
    border-radius: 18px;
    background: linear-gradient(180deg, rgba(247, 147, 26, 0.05), rgba(255, 255, 255, 0.015));
    border: 1px solid rgba(247, 147, 26, 0.14);
  }
  .story-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    margin-bottom: 12px;
  }
  .story-year {
    font-size: 13px;
    font-weight: 900;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--green);
  }
  .story-icons {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .story-icons img {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    object-fit: cover;
  }
  .story-card h4 {
    font-size: 26px;
    line-height: 1.05;
    margin-bottom: 12px;
  }
  .story-card p {
    font-size: 16px;
    line-height: 1.65;
    color: var(--muted);
  }
  .story-note {
    margin-top: 12px;
    font-size: 13px;
    line-height: 1.55;
    color: var(--soft);
  }
  .sources {
    margin-top: 18px;
    padding: 22px 24px;
  }
  .sources-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 14px;
  }
  .sources-head h3 {
    font-size: 22px;
  }
  .sources-head p {
    font-size: 13px;
    color: var(--soft);
  }
  .source-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }
  .source-link {
    display: block;
    padding: 14px 16px;
    border-radius: 16px;
    border: 1px solid rgba(247, 147, 26, 0.14);
    background: rgba(255, 255, 255, 0.025);
    text-decoration: none;
  }
  .source-link:hover {
    border-color: rgba(247, 147, 26, 0.35);
    transform: translateY(-1px);
  }
  .source-link strong {
    display: block;
    font-size: 14px;
    color: var(--text);
  }
  .source-link span {
    display: block;
    margin-top: 6px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--soft);
  }
  .footer {
    margin-top: 14px;
    text-align: right;
    font-size: 12px;
    color: var(--soft);
  }
  @media (max-width: 1120px) {
    .hero,
    .compare,
    .source-grid,
    .art-grid {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 720px) {
    .shell {
      width: min(100% - 18px, 100%);
      margin: 10px auto 18px;
    }
    .topbar,
    .hero-main,
    .hero-side,
    .column,
    .sources {
      padding: 18px;
    }
    .hero-main h2 {
      font-size: 34px;
    }
    .hero-main p,
    .story-card p {
      font-size: 15px;
    }
    .live-stats {
      grid-template-columns: 1fr 1fr;
    }
    .sources-head {
      display: block;
    }
    .sources-head p {
      margin-top: 6px;
    }
  }
</style>
</head>
<body>
  <div class="shell">
    <div class="topbar">
      <div class="brand">
        <div class="brand-mark">B</div>
        <div class="brand-copy">
          <h1>BTCBANK Thesis</h1>
          <p>Why Bitcoin became serious money, and why memecoins still matter to internet markets.</p>
          <div class="page-nav">
            <a class="page-link" href="/paid-summary">Paid Summary</a>
            <a class="page-link" href="/">Main Site</a>
            <a class="page-link" href="/wallet-check">Wallet Check</a>
            <a class="page-link active" href="/history">Bitcoin vs Memes</a>
          </div>
        </div>
      </div>
      <div class="topbar-right">
        <span class="pill"><span class="dot"></span>${isLive ? "Live" : "Offline"}</span>
        <span class="pill">Updated ${timeAgo(updatedAt)}</span>
      </div>
    </div>

    <section class="hero">
      <div class="hero-main">
        <div class="eyebrow">From ignored experiment to institutional asset</div>
        <h2>They laughed at Bitcoin. Then they bought it.</h2>
        <p>Bitcoin did not start with prestige. It started with a whitepaper, a small mailing list, hobbyist nodes, and years of public doubt. Memecoins followed a different path: jokes first, culture second, markets third. One became digital money. The other became the fastest mirror of internet attention. Both taught the same lesson: early conviction looks ridiculous until the crowd wants in.</p>
        <div class="coin-row">
          <div class="coin"><img src="https://s2.coinmarketcap.com/static/img/coins/64x64/1.png" alt="Bitcoin logo"/><span>Bitcoin</span></div>
          <div class="coin"><img src="https://s2.coinmarketcap.com/static/img/coins/64x64/74.png" alt="Dogecoin logo"/><span>Dogecoin</span></div>
          <div class="coin"><img src="https://s2.coinmarketcap.com/static/img/coins/64x64/5994.png" alt="Shiba Inu logo"/><span>Shiba Inu</span></div>
          <div class="coin"><img src="https://s2.coinmarketcap.com/static/img/coins/64x64/23095.png" alt="BONK logo"/><span>BONK</span></div>
        </div>
        <div class="art-grid">
          <div class="art-card">
            <strong>Bitcoin endured the laughter.</strong>
            <span>Ignored in 2008, mocked for years, then absorbed by the same institutions that once dismissed it.</span>
            <img src="https://s2.coinmarketcap.com/static/img/coins/128x128/1.png" alt="Bitcoin art"/>
          </div>
          <div class="art-card memes">
            <strong>Memecoins weaponized culture.</strong>
            <span>Jokes, identity, and community turned into liquidity faster than polished pitch decks ever could.</span>
            <img src="https://s2.coinmarketcap.com/static/img/coins/128x128/74.png" alt="Dogecoin art"/>
          </div>
          <div class="art-card hybrid">
            <strong>BTCBANK is built for the holder mindset.</strong>
            <span>Stop jeeting. Stop selling. Let the loyalty math compound instead of resetting the timer.</span>
            <img src="https://s2.coinmarketcap.com/static/img/coins/128x128/23095.png" alt="BONK art"/>
          </div>
        </div>
      </div>

      <aside class="hero-side">
        <div class="side-title">BTCBANK lens</div>
        <div class="thesis">
          <h3>Most people do not regret being too early. They regret not staying long enough.</h3>
          <p>$BTCBANK is built around that exact behavioral pattern: people mock the thing they have not studied, dismiss the thing they have not held, and only respect the thing after price and institutions have already validated it for them.</p>
        </div>
        <div class="live-stats">
          <div class="live-stat">
            <div class="lbl">All-time value sent</div>
            <div class="val orange">${fmtUsd(s.allTimeUsd)}</div>
          </div>
          <div class="live-stat">
            <div class="lbl">Holders paid</div>
            <div class="val green">${fmtNum(s.holdersPaid)}</div>
          </div>
          <div class="live-stat">
            <div class="lbl">Rounds completed</div>
            <div class="val blue">${fmtNum(s.roundsCompleted)}</div>
          </div>
          <div class="live-stat">
            <div class="lbl">WBTC distributed</div>
            <div class="val">${fmtWbtc(s.allTimeWbtc)}</div>
          </div>
        </div>
      </aside>
    </section>

    <section class="compare">
      <div class="column">
        <div class="column-head">
          <img src="https://s2.coinmarketcap.com/static/img/coins/64x64/74.png" alt="Memecoin collage"/>
          <div>
            <h3>Memecoin Story</h3>
            <p>Not the same as Bitcoin, but absolutely real as a market force: memes, identity, distribution, and culture moving capital faster than polished narratives.</p>
          </div>
        </div>

        <article class="story-card">
          <div class="story-top">
            <div class="story-year">2013</div>
            <div class="story-icons">
              <img src="https://s2.coinmarketcap.com/static/img/coins/64x64/74.png" alt="Dogecoin"/>
            </div>
          </div>
          <h4>Dogecoin proved a joke could still work.</h4>
          <p>Dogecoin launched on December 6, 2013 as a parody of a crypto scene that its creators thought was taking itself too seriously. What made it important was not the joke alone. It was the behavior that followed: tipping, small online payments, charity drives, and a community that moved because it was fun first. In other words, Dogecoin showed that narrative and social energy could bootstrap real network activity faster than many "serious" projects.</p>
          <div class="story-note">Official Dogecoin history says it was created as a joke by Billy Markus and Jackson Palmer, then quickly became a tipping currency on Reddit with extremely fast early adoption.</div>
        </article>

        <article class="story-card">
          <div class="story-top">
            <div class="story-year">2020</div>
            <div class="story-icons">
              <img src="https://s2.coinmarketcap.com/static/img/coins/64x64/5994.png" alt="Shiba Inu"/>
            </div>
          </div>
          <h4>SHIB showed how internet-native distribution can overpower polish.</h4>
          <p>Shiba Inu launched anonymously in August 2020 with no presale and no venture capital. That mattered. It let holders tell a very different story from the typical token launch: no polished investor deck, no institution-first allocation, no prestige gatekeepers. Whatever anyone thinks of the token itself, SHIB forced the market to admit that massive attention can be organized from the bottom up if the meme is strong enough and the community decides to defend it.</p>
          <div class="story-note">On its official site, SHIB frames itself as a community-built token launched anonymously in August 2020 with no presale and no VCs.</div>
        </article>

        <article class="story-card">
          <div class="story-top">
            <div class="story-year">2022-23</div>
            <div class="story-icons">
              <img src="https://s2.coinmarketcap.com/static/img/coins/64x64/23095.png" alt="BONK"/>
              <img src="https://s2.coinmarketcap.com/static/img/coins/64x64/74.png" alt="Dogecoin"/>
            </div>
          </div>
          <h4>BONK reminded everyone that morale is part of market structure.</h4>
          <p>After the late-2022 damage across Solana, BONK did not arrive as a grand macro thesis. It arrived as a morale reset. BONK's own site says a small group of Solana builders launched it on Christmas Day and distributed more than half the supply to developers and creators. That is why it mattered. It felt less like a venture product and more like a community relief package, which is exactly the kind of context where internet money can spread fast.</p>
          <div class="story-note">The honest version: most memecoins do not become long-term money. Many are brief attention markets. But the category keeps proving that culture, distribution, and identity are not side shows - they are part of price discovery now.</div>
        </article>

        <article class="story-card">
          <div class="story-top">
            <div class="story-year">What memecoins really teach</div>
            <div class="story-icons">
              <img src="https://s2.coinmarketcap.com/static/img/coins/64x64/74.png" alt="Dogecoin"/>
              <img src="https://s2.coinmarketcap.com/static/img/coins/64x64/5994.png" alt="Shiba Inu"/>
              <img src="https://s2.coinmarketcap.com/static/img/coins/64x64/23095.png" alt="BONK"/>
            </div>
          </div>
          <h4>They are the purest expression of attention.</h4>
          <p>Bitcoin won by becoming harder money over time. Memecoins win - when they win at all - by becoming harder to ignore. They are reflexive, volatile, and often disposable, but they are not meaningless. They reveal where communities are forming, where risk appetite is returning, and how quickly culture can turn into liquidity. In a market that lives online, that is real information, even when the asset itself is unserious.</p>
        </article>
      </div>

      <div class="column">
        <div class="column-head">
          <img src="https://s2.coinmarketcap.com/static/img/coins/64x64/1.png" alt="Bitcoin"/>
          <div>
            <h3>Bitcoin Story</h3>
            <p>Scarcity, patience, and repeated disbelief. The same asset was called impractical, fake, dead, speculative, then strategic.</p>
          </div>
        </div>

        <article class="story-card">
          <div class="story-top">
            <div class="story-year">2008</div>
            <div class="story-icons">
              <img src="https://s2.coinmarketcap.com/static/img/coins/64x64/1.png" alt="Bitcoin"/>
            </div>
          </div>
          <h4>A whitepaper and an email, not a launch campaign.</h4>
          <p>On October 31, 2008, Satoshi Nakamoto emailed the cryptography mailing list and linked a paper called <em>Bitcoin: A Peer-to-Peer Electronic Cash System</em>. The pitch was direct: online payments between two parties, without a trusted third party. That sounds normal now. At the time it was radical, niche, and easy to dismiss. There were no institutions waiting, no television segment, and no social-media machine. Bitcoin began as a technical argument that almost nobody outside a small cypherpunk circle cared about.</p>
          <div class="story-note">The original email and the whitepaper still read like engineering documents, not marketing. That is part of why the idea aged so well.</div>
        </article>

        <article class="story-card">
          <div class="story-top">
            <div class="story-year">2009-2010</div>
            <div class="story-icons">
              <img src="https://s2.coinmarketcap.com/static/img/coins/64x64/1.png" alt="Bitcoin"/>
            </div>
          </div>
          <h4>The first believers were closer to hobbyists than investors.</h4>
          <p>The earliest users ran nodes out of curiosity, not because Wall Street had modeled upside. In 2010, Gavin Andresen built a faucet giving away 5 BTC to anyone willing to solve a CAPTCHA. That only makes sense in a world where Bitcoin still felt nearly valueless. The famous pizza purchase that same year made the same point: people were trying to prove Bitcoin could be used at all. Its first milestone was not prestige. It was functionality.</p>
          <div class="story-note">This is why the early-holding story matters. The people who held were not following validation. They were living without it.</div>
        </article>

        <article class="story-card">
          <div class="story-top">
            <div class="story-year">2011-2017</div>
            <div class="story-icons">
              <img src="https://s2.coinmarketcap.com/static/img/coins/64x64/1.png" alt="Bitcoin"/>
            </div>
          </div>
          <h4>Bitcoin kept surviving the part where everyone said it would not.</h4>
          <p>Once Bitcoin began to carry a real price, disbelief hardened. It was described as speculative, unserious, or doomed after every major swing. Yet the network stayed alive, blocks kept arriving, and more people kept understanding what fixed supply and self-custody might mean over a long enough horizon. By 2017, when Bitcoin pushed into five figures, a new mainstream explanation appeared: early holders were "just lucky." That missed the whole point. They were not lucky enough to avoid volatility. They were patient enough to outlast it.</p>
          <div class="story-note">The market usually rewrites conviction as luck after the fact because conviction is uncomfortable to watch in real time.</div>
        </article>

        <article class="story-card">
          <div class="story-top">
            <div class="story-year">2024-2026</div>
            <div class="story-icons">
              <img src="https://s2.coinmarketcap.com/static/img/coins/64x64/1.png" alt="Bitcoin"/>
            </div>
          </div>
          <h4>The institutions did not disprove Bitcoin. They arrived after it proved itself.</h4>
          <p>On January 10, 2024, the U.S. SEC approved the listing and trading of spot bitcoin exchange-traded products. That was a historic change in access. BlackRock's iShares Bitcoin ETF, along with other issuers, began trading the next day. The story flipped. For years the question had been whether Bitcoin mattered. By the ETF era, the question became how much exposure the largest pools of capital should have. That is the pattern Bitcoin has repeated for more than a decade: first ridicule, then resistance, then reluctant adoption.</p>
          <div class="story-note">Inference from the official record: once the regulatory gate opened for spot ETPs, Bitcoin was no longer only a cypherpunk asset or a retail trade. It became part of institutional portfolio construction.</div>
        </article>
      </div>
    </section>

    <section class="sources">
      <div class="sources-head">
        <h3>Primary and official references</h3>
        <p>Research-first source set behind the timeline.</p>
      </div>
      <div class="source-grid">
        <a class="source-link" href="https://bitcoin.org/en/bitcoin-paper" target="_blank" rel="noopener">
          <strong>Bitcoin whitepaper</strong>
          <span>Bitcoin.org hosts Satoshi Nakamoto's original paper introducing Bitcoin.</span>
        </a>
        <a class="source-link" href="https://satoshi.nakamotoinstitute.org/fi/emails/cryptography/1/" target="_blank" rel="noopener">
          <strong>Satoshi mailing list post</strong>
          <span>October 31, 2008 email announcing the Bitcoin paper to the cryptography list.</span>
        </a>
        <a class="source-link" href="https://www.sec.gov/newsroom/speeches-statements/gensler-statement-spot-bitcoin-011023" target="_blank" rel="noopener">
          <strong>SEC spot Bitcoin ETP approval</strong>
          <span>January 10, 2024 statement confirming approval of spot Bitcoin exchange-traded products.</span>
        </a>
        <a class="source-link" href="https://dogecoin.com/no/dogepedia/articles/history-of-dogecoin/" target="_blank" rel="noopener">
          <strong>Dogecoin history</strong>
          <span>Official Dogecoin history covering the late-2013 joke origin and early adoption.</span>
        </a>
        <a class="source-link" href="https://dogecoin.com/es/dogepedia/faq/dogecoin-is-a-joke/" target="_blank" rel="noopener">
          <strong>Dogecoin utility note</strong>
          <span>Official FAQ explaining how a joke coin still developed real usage and tipping culture.</span>
        </a>
        <a class="source-link" href="https://shibatoken.com/" target="_blank" rel="noopener">
          <strong>SHIB official site</strong>
          <span>Project framing for the August 2020 launch, no presale, and community-led story.</span>
        </a>
        <a class="source-link" href="https://www.bonkcoin.com/about" target="_blank" rel="noopener">
          <strong>BONK about page</strong>
          <span>Official BONK timeline describing the late-2022 Solana context and Christmas Day launch.</span>
        </a>
        <a class="source-link" href="https://bitcoinpizzaindex.net/index.php" target="_blank" rel="noopener">
          <strong>Bitcoin Pizza Day record</strong>
          <span>Reference for the 10,000 BTC pizza purchase that marked early real-world use.</span>
        </a>
        <a class="source-link" href="https://www.ishares.com/us/literature/press-release/blackrocks-bitcoin-etf-ibit-clears-final-sec-hurdle.pdf" target="_blank" rel="noopener">
          <strong>BlackRock IBIT launch note</strong>
          <span>iShares press release on the final SEC hurdle and January 11, 2024 trading start.</span>
        </a>
      </div>
      <div class="footer">BTCBANK thesis page. Live site stats last updated ${timeAgo(updatedAt)}.</div>
    </section>
  </div>
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

  const balanceText = result
    ? (result.balanceTokens ?? (result.tokens !== undefined ? fmtNum(result.tokens) : "-"))
    : "-";
  const shareText = result ? (result.shareCount ?? result.shares ?? "-") : "-";
  const holdAgeText = result ? (result.holdAge ?? "-") : "-";
  const tierText = result ? (result.holdTier ?? result.holdTierLabel ?? "-") : "-";
  const multiplierText = result ? (result.multiplier ?? result.holdMultiplier ?? "-") : "-";

  const resultHtml = !wallet ? "" : result
    ? `<div class="result found">
        <div class="r-label">Wallet Found ✓</div>
        <div class="r-addr">${wallet}</div>
        <div class="r-grid">
          <div class="metric"><span>Balance</span><strong>${balanceText}</strong></div>
          <div class="metric"><span>Qualified</span><strong style="color:${result.qualified ? '#4ade80' : '#f87171'}">${result.qualified ? 'YES' : 'NO'}</strong></div>
          <div class="metric"><span>Full Shares</span><strong>${shareText}</strong></div>
          <div class="metric"><span>Hold Age</span><strong>${holdAgeText}</strong></div>
          <div class="metric"><span>Tier</span><strong>${tierText}</strong></div>
          <div class="metric"><span>Bonus</span><strong>${multiplierText}</strong></div>
        </div>
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
  .r-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
  .metric { background: rgba(255,255,255,0.03); border: 1px solid #2a2a2a; border-radius: 10px; padding: 10px 12px; }
  .metric span { display: block; color: #777; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 4px; }
  .metric strong { display: block; font-size: 18px; color: #fff4db; }
</style>
</head>
<body>
<div class="card">
  <h1>₿ $BTCBANK Wallet Check</h1>
  <p class="sub">Check your wallet's live bag, share count, and hold tier. Stop jeeting. Stop selling. Read the math.</p>
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
  history: "history",
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
    data = await getLivePayload();
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
    case "history":
      res.end(renderHistory(data, transparent));
      break;
  }
}
