import { escapeHtml } from "./_shared.js";

const SITE_URL = (process.env.SITE_URL ?? "https://www.btcbank.help").replace(/\/+$/, "");
const COINGECKO_URL = "https://www.coingecko.com/en/coins/bitcoin-bank";
const HOLDER_MINT = String(process.env.HOLDER_MINT ?? "").trim();
const REWARD_MINT = String(process.env.REWARD_MINT ?? "").trim();

function shorten(value, left = 8, right = 8) {
  if (!value || value.length <= left + right) return value || "not set";
  return `${value.slice(0, left)}...${value.slice(-right)}`;
}

function renderPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>BTCBANK Brand Kit</title>
  <meta name="description" content="Official BTCBANK brand kit, media kit, boilerplate, links, and approved copy for articles, creators, listings, and public profiles." />
  <meta property="og:title" content="BTCBANK Brand Kit" />
  <meta property="og:description" content="Official BTCBANK facts, copy, links, and press-ready material." />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${SITE_URL}/brand-kit" />
  <meta property="og:image" content="${SITE_URL}/api/og" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="theme-color" content="#f7931a" />
  <style>
    :root{
      --bg:#080808;--bg2:#111;--bg3:#151515;--line:#262626;--line2:#343434;
      --text:#f5f0e8;--muted:#9b9489;--btc:#f7931a;--green:#4ade80;
    }
    *{box-sizing:border-box} body{margin:0;background:linear-gradient(180deg,#090909 0%,#050505 100%);color:var(--text);font-family:Georgia,ui-serif,serif}
    .wrap{max-width:1180px;margin:0 auto;padding:28px 18px 72px}
    .top{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:34px}
    .logo{display:flex;align-items:center;gap:10px;text-decoration:none;color:#fff}
    .coin{width:34px;height:34px;border-radius:50%;background:var(--btc);display:flex;align-items:center;justify-content:center;color:#080808;font-weight:700}
    .name{font:700 28px/1 Arial Black,Impact,sans-serif;letter-spacing:1px}
    .name span{color:var(--btc)}
    .btns{display:flex;gap:10px;flex-wrap:wrap}
    .btn{display:inline-flex;align-items:center;justify-content:center;padding:12px 18px;border-radius:12px;border:1px solid var(--line2);text-decoration:none;color:#fff;font:600 14px Arial,sans-serif}
    .btn.primary{background:var(--btc);border-color:var(--btc);color:#080808}
    .hero{padding:32px;border:1px solid var(--line);border-radius:24px;background:radial-gradient(circle at top left,rgba(247,147,26,.12),transparent 40%),var(--bg2)}
    .eyebrow{font:700 12px/1.2 Consolas,monospace;color:var(--btc);letter-spacing:2px;text-transform:uppercase;margin-bottom:12px}
    h1{margin:0 0 16px;font:700 clamp(48px,9vw,96px)/.94 Arial Black,Impact,sans-serif;letter-spacing:1px}
    h1 span{color:var(--btc)}
    .lead{max-width:860px;font-size:20px;line-height:1.7;color:#ddd2c0}
    .grid{display:grid;grid-template-columns:1.1fr .9fr;gap:18px;margin-top:28px}
    .card{background:var(--bg3);border:1px solid var(--line);border-radius:18px;padding:24px}
    .card h2{margin:0 0 10px;font:700 28px/1.05 Arial Black,Impact,sans-serif}
    .card h2 span{color:var(--btc)}
    .card p,.card li{font-size:15px;line-height:1.8;color:#d2ccbf}
    .facts{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}
    .fact{background:#101010;border:1px solid var(--line2);border-radius:14px;padding:14px}
    .fact b{display:block;font:700 11px/1.2 Consolas,monospace;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
    .fact strong{display:block;font:700 16px/1.4 Consolas,monospace;color:#fff;word-break:break-word}
    .copy{background:#0d0d0d;border:1px solid var(--line2);border-radius:14px;padding:18px;font:16px/1.8 Georgia,serif;color:#ece1cf;white-space:pre-wrap}
    .section{margin-top:22px}
    .links{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}
    .chip{display:inline-flex;align-items:center;padding:9px 12px;border-radius:999px;border:1px solid var(--line2);background:#0d0d0d;color:#ddd;text-decoration:none;font:600 13px Arial,sans-serif}
    .foot{margin-top:26px;font-size:13px;line-height:1.8;color:var(--muted)}
    @media(max-width:900px){.grid{grid-template-columns:1fr}.facts{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <a class="logo" href="${SITE_URL}">
        <div class="coin">B</div>
        <div class="name">BTC<span>BANK</span></div>
      </a>
      <div class="btns">
        <a class="btn primary" href="${SITE_URL}">Main Site</a>
        <a class="btn" href="${COINGECKO_URL}" target="_blank" rel="noopener">CoinGecko</a>
      </div>
    </div>

    <section class="hero">
      <div class="eyebrow">Official Brand and Media Kit</div>
      <h1>USE THE <span>RIGHT STORY.</span></h1>
      <p class="lead">BTCBANK is not a generic reward coin and it should not be described like one. The clean public explanation is simple: BTCBANK is a Solana token that routes creator-fee value into wrapped Bitcoin for qualifying holders, with higher reward power for larger bags and longer holds.</p>
    </section>

    <div class="grid">
      <section class="card">
        <h2>Approved <span>One-Liner</span></h2>
        <div class="copy">BTCBANK is a Solana token that automatically routes creator-fee value into wrapped Bitcoin for qualifying holders. Hold enough, hold long enough, and the reward side keeps pointing back at BTC.</div>
        <div class="section">
          <h2>Boilerplate <span>Paragraph</span></h2>
          <div class="copy">BTCBANK was built around a simple long-term idea: most reward tokens get dumped, while Bitcoin is the asset people keep wishing they had accumulated more of. Instead of paying holders in weak inflationary rewards or flat stablecoins, BTCBANK converts creator-fee value into wrapped Bitcoin and distributes it to qualifying holders on Solana. The system rewards both bag size and hold duration, creating a stronger reason to hold through noise instead of jeeting every cycle.</div>
        </div>
      </section>

      <section class="card">
        <h2>Project <span>Facts</span></h2>
        <div class="facts">
          <div class="fact"><b>Name</b><strong>Bitcoin Bank</strong></div>
          <div class="fact"><b>Ticker</b><strong>BTCBANK</strong></div>
          <div class="fact"><b>Chain</b><strong>Solana</strong></div>
          <div class="fact"><b>Reward Asset</b><strong>wBTC (1:1 BTC-linked)</strong></div>
          <div class="fact"><b>Cadence</b><strong>Main claim cycle every 5 minutes</strong></div>
          <div class="fact"><b>Status</b><strong>Live public payouts</strong></div>
          <div class="fact"><b>CoinGecko</b><strong>Listed live</strong></div>
          <div class="fact"><b>CoinMarketCap</b><strong>Application in process</strong></div>
          <div class="fact"><b>Site</b><strong>${escapeHtml(SITE_URL)}</strong></div>
          <div class="fact"><b>Holder Mint</b><strong>${escapeHtml(shorten(HOLDER_MINT))}</strong></div>
          <div class="fact"><b>Reward Mint</b><strong>${escapeHtml(shorten(REWARD_MINT))}</strong></div>
          <div class="fact"><b>Public Narrative</b><strong>Stop jeeting. Stop selling.</strong></div>
        </div>
      </section>
    </div>

    <div class="grid section">
      <section class="card">
        <h2>Use <span>These Links</span></h2>
        <div class="links">
          <a class="chip" href="${SITE_URL}">${escapeHtml(SITE_URL.replace(/^https?:\/\//, ""))}</a>
          <a class="chip" href="${COINGECKO_URL}" target="_blank" rel="noopener">CoinGecko listing</a>
          <a class="chip" href="${SITE_URL}/history">Bitcoin vs Memes story</a>
          <a class="chip" href="${SITE_URL}/#tiers">Tier system</a>
          <a class="chip" href="${SITE_URL}/#proof">Payout proof explorer</a>
        </div>
      </section>

      <section class="card">
        <h2>Do <span>Not</span></h2>
        <ul>
          <li>Do not describe BTCBANK as a fake APY farm or generic dividend token.</li>
          <li>Do not say CoinMarketCap is complete before it is complete.</li>
          <li>Do not use random contract addresses from chats or reposts. Use the official site and verified pages.</li>
          <li>Do not reduce the project story to "meme coin." The whole point is the Bitcoin-linked reward loop.</li>
        </ul>
      </section>
    </div>

    <div class="foot">This page exists so the project looks and reads like it belongs to BTCBANK every time someone links it, writes about it, clips it, or applies with it. Use the official site, the public proof, and the live CoinGecko page as the primary references.</div>
  </div>
</body>
</html>`;
}

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.statusCode = 200;
  res.end(renderPage());
}
