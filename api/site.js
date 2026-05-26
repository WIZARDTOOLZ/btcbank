import {
  buildWalletCheckResult,
  escapeHtml,
  findHolderByWallet,
  formatCompactCount,
  formatCount,
  formatHoldAge,
  formatUsd,
  formatWbtc,
  getHolderMultiplier,
  getHolderTier,
  getLivePayload,
  mapLeaderboardHolder,
  mapTransaction,
  safeInteger,
  safeNumber,
  shortenAddress,
} from "./_shared.js";

const STORY_LOGO_URLS = {
  btc: "https://cryptologos.cc/logos/bitcoin-btc-logo.png?v=040",
  doge: "https://cryptologos.cc/logos/dogecoin-doge-logo.png?v=040",
  shib: "https://cryptologos.cc/logos/shiba-inu-shib-logo.png?v=040",
  bonk: "https://cryptologos.cc/logos/bonk-bonk-logo.png?v=040",
};

const SITE_URL = (process.env.SITE_URL ?? "https://www.btcbank.help").replace(/\/+$/, "");
const COINGECKO_URL = "https://www.coingecko.com/en/coins/bitcoin-bank";

const TIER_CALC_DEFS = [
  { label: "Satoshi", minDays: 30, multiplier: 1.2 },
  { label: "OG", minDays: 14, multiplier: 1.12 },
  { label: "Veteran", minDays: 7, multiplier: 1.07 },
  { label: "Miner", minDays: 3, multiplier: 1.03 },
  { label: "Stacker", minDays: 1, multiplier: 1.01 },
  { label: "Holder", minDays: 0, multiplier: 1.0 },
];

function timeAgo(ts) {
  if (!ts) return "just now";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatDuration(seconds) {
  const total = Math.max(0, safeInteger(seconds, 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function getTierByDays(days) {
  const normalizedDays = Math.max(0, safeNumber(days, 0));
  return TIER_CALC_DEFS.find((entry) => normalizedDays >= entry.minDays) ?? TIER_CALC_DEFS[TIER_CALC_DEFS.length - 1];
}

function getBagRewardPower(tokens, minimumTokens, daysHeld) {
  const safeTokens = Math.max(0, safeNumber(tokens, 0));
  const shareCount = Math.max(0, Math.floor(safeTokens / minimumTokens));
  const tier = shareCount > 0 ? getTierByDays(daysHeld) : { label: "Locked", multiplier: 0 };
  return {
    shareCount,
    tier: tier.label,
    multiplier: tier.multiplier,
    power: shareCount * tier.multiplier,
  };
}

function renderProofRows(txs) {
  if (!txs.length) {
    return `<div class="proof-empty">No payout proofs yet. This fills itself as live rounds land on-chain.</div>`;
  }

  return txs.slice(0, 8).map((tx) => {
    const signature = tx.signature || "";
    const sigLabel = signature ? shortenAddress(signature, 6, 6) : "pending";
    const solscanUrl = signature ? `https://solscan.io/tx/${encodeURIComponent(signature)}` : "#";
    return `<div class="proof-row">
      <div class="proof-main">
        <div class="proof-wallet">${escapeHtml(tx.shortAddress)}</div>
        <div class="proof-meta">Round ${escapeHtml(formatCount(tx.round))} · ${escapeHtml(tx.tier)}</div>
      </div>
      <div class="proof-amount">${escapeHtml(tx.wbtcAmount.toFixed(8))} WBTC</div>
      <div class="proof-sig">${escapeHtml(sigLabel)}</div>
      <a class="proof-link" href="${solscanUrl}" target="_blank" rel="noopener">Verify</a>
    </div>`;
  }).join("");
}

async function fetchDexScreenerSummary(tokenMint) {
  if (!tokenMint) {
    return null;
  }

  try {
    const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${encodeURIComponent(tokenMint)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      return null;
    }

    const pairs = await response.json();
    if (!Array.isArray(pairs) || !pairs.length) {
      return null;
    }

    const bestPair = [...pairs].sort((left, right) => {
      const rightLiq = safeNumber(right?.liquidity?.usd, 0);
      const leftLiq = safeNumber(left?.liquidity?.usd, 0);
      return rightLiq - leftLiq;
    })[0];

    return {
      pairAddress: bestPair?.pairAddress ?? "",
      url: bestPair?.url ?? "",
      priceUsd: safeNumber(bestPair?.priceUsd, 0),
      liquidityUsd: safeNumber(bestPair?.liquidity?.usd, 0),
      volume24h: safeNumber(bestPair?.volume?.h24, 0),
      fdv: safeNumber(bestPair?.fdv ?? bestPair?.marketCap, 0),
      dexId: bestPair?.dexId ?? "dexscreener",
    };
  } catch {
    return null;
  }
}

function renderCheckerResultHtml(result) {
  if (!result) {
    return `<div class="checker-placeholder">Paste a Solana wallet to see the current bag, share count, hold tier, bonus, and next step.</div>`;
  }

  if (!result.found) {
    return `<div class="checker-result checker-miss">
      <div class="checker-state">Wallet not found</div>
      <div class="checker-message">${escapeHtml(result.message)}</div>
    </div>`;
  }

  const readyText = result.hasWbtcAccount === null
    ? "Live feed does not expose this yet"
    : result.hasWbtcAccount
      ? "Ready"
      : "Needs one-time wBTC unlock";
  const payableText = result.payableNow === null
    ? "Waiting on richer live feed"
    : result.payableNow
      ? "Yes"
      : "Not yet";

  return `<div class="checker-result checker-hit">
    <div class="checker-topline">
      <div>
        <div class="checker-state">Wallet found</div>
        <div class="checker-wallet">${escapeHtml(result.wallet)}</div>
      </div>
      <div class="checker-tier-pill">${escapeHtml(result.holdTier)}</div>
    </div>
    <div class="checker-metrics">
      <div class="checker-metric"><span>Balance</span><strong>${escapeHtml(result.balanceTokens)} BTCBANK</strong></div>
      <div class="checker-metric"><span>Qualified</span><strong>${result.qualifiesNow ? "YES" : "NO"}</strong></div>
      <div class="checker-metric"><span>Full shares</span><strong>${escapeHtml(String(result.shareCount))}</strong></div>
      <div class="checker-metric"><span>Hold age</span><strong>${escapeHtml(result.holdAge)}</strong></div>
      <div class="checker-metric"><span>Bonus</span><strong>${escapeHtml(result.holdMultiplier)}</strong></div>
      <div class="checker-metric"><span>Reward power</span><strong>${escapeHtml(result.rewardPower)}</strong></div>
      <div class="checker-metric"><span>WBTC ready</span><strong>${escapeHtml(readyText)}</strong></div>
      <div class="checker-metric"><span>Payable now</span><strong>${escapeHtml(payableText)}</strong></div>
      <div class="checker-metric"><span>Next tier</span><strong>${escapeHtml(result.nextTier ?? "Top tier")}</strong></div>
      <div class="checker-metric"><span>Next tier ETA</span><strong>${escapeHtml(result.nextTierEta ?? "Reached")}</strong></div>
      <div class="checker-metric"><span>Need to qualify</span><strong>${escapeHtml(result.tokensNeeded)} BTCBANK</strong></div>
      <div class="checker-metric"><span>wBTC earned</span><strong>${escapeHtml(result.totalWbtcEarned)} WBTC</strong></div>
    </div>
    <div class="checker-message">${escapeHtml(result.message)}</div>
  </div>`;
}

function renderInitialLeaderboardRows(holders) {
  if (!holders.length) {
    return `<tr><td colspan="7" class="lb-empty">No holder data yet. Data populates as rounds complete.</td></tr>`;
  }

  return holders.map((holder, index) => {
    const rankClass = index === 0 ? "gold" : index === 1 ? "silver" : index === 2 ? "bronze" : "";
    const satoshiClass = holder.tier === "Satoshi" ? "satoshi" : "";
    return `<tr>
      <td><span class="rank-num ${rankClass}">${index + 1}</span></td>
      <td><span class="addr-cell">${escapeHtml(holder.shortAddress)}</span></td>
      <td><span class="tier-pill ${satoshiClass}">${escapeHtml(holder.tierIcon)} ${escapeHtml(holder.tier)}</span></td>
      <td><span class="addr-cell">${escapeHtml(formatCount(holder.balance))}</span></td>
      <td><span class="mult-val">${escapeHtml(holder.multiplier.toFixed(2))}x</span></td>
      <td><span class="wbtc-val">${escapeHtml(holder.totalWbtcEarned.toFixed(8))}</span></td>
      <td><span style="font-family:var(--mono);font-size:11px;color:var(--muted)">${escapeHtml(String(holder.roundsQualified))}</span></td>
    </tr>`;
  }).join("");
}

function renderInitialTxRows(txs) {
  if (!txs.length) {
    return `<div class="tx-empty" id="txEmpty">No transactions yet. Data populates as rounds complete.</div>`;
  }

  const rows = txs.map((tx) => `
    <div class="tx-row">
      <span class="tx-addr">${escapeHtml(tx.shortAddress)}</span>
      <span class="tx-round">#${escapeHtml(formatCount(tx.round))}</span>
      <span class="tx-wbtc">${escapeHtml(tx.wbtcAmount.toFixed(8))}</span>
      <span><span class="tier-pill" style="font-size:10px">${escapeHtml(tx.tier)}</span></span>
      <span class="tx-time">${escapeHtml(timeAgo(tx.timestamp))}</span>
    </div>`).join("");

  return `<div class="tx-empty" id="txEmpty" style="display:none">Loading transactions...</div>${rows}`;
}

function renderSite(data, wallet, dexSummary) {
  const stats = data?.stats ?? {};
  const holders = Array.isArray(data?.holders) ? data.holders : [];
  const txs = Array.isArray(data?.txs) ? data.txs : [];
  const minimumTokens = safeInteger(stats.holderMinTokens ?? 300000, 300000);
  const allTimeUsd = safeNumber(stats.allTimeUsd, 0);
  const allTimeWbtc = safeNumber(stats.allTimeWbtc, 0);
  const holdersPaid = safeInteger(stats.holdersPaid, 0);
  const roundsCompleted = safeInteger(stats.roundsCompleted, 0);
  const currentRound = safeInteger(stats.currentRound, roundsCompleted);
  const qualifiedThisRound = safeInteger(stats.qualifiedThisRound, 0);
  const btcPrice = safeNumber(stats.btcPrice, 103240);
  const nextCycleSeconds = safeInteger(stats.nextCycleSeconds, 294);
  const holderMint = String(stats.holderMint ?? process.env.HOLDER_MINT ?? "").trim();
  const rewardMint = String(stats.rewardMint ?? process.env.REWARD_MINT ?? "").trim();
  const topHolders = holders
    .map((holder) => mapLeaderboardHolder(holder, minimumTokens))
    .filter((holder) => holder.qualified)
    .sort((a, b) => b.totalWbtcEarned - a.totalWbtcEarned)
    .slice(0, 50);
  const initialTxs = txs.map(mapTransaction).slice(0, 30);
  const walletResult = wallet
    ? buildWalletCheckResult(findHolderByWallet(holders, wallet), wallet, minimumTokens)
    : null;
  const checkerHtml = renderCheckerResultHtml(walletResult);
  const updatedAt = data?.updatedAt ?? Date.now();
  const currentRoundPaid = safeInteger(stats.paidThisRound ?? 0, 0);
  const currentRoundWbtc = safeNumber(stats.currentRoundWbtc ?? 0, 0);
  const currentRoundValue = safeNumber(stats.currentRoundUsd ?? stats.latestRoundUsd ?? 0, 0);
  const biggestRoundNumber = safeInteger(stats.biggestRoundNumber, currentRound);
  const biggestRoundPaid = safeInteger(stats.biggestRoundPaid, 0);
  const biggestRoundWbtc = safeNumber(stats.biggestRoundWbtc, 0);
  const biggestRoundUsdEstimate = biggestRoundWbtc * btcPrice;
  const topEarner = topHolders[0] ?? null;
  const totalRewardPower = holders.reduce((sum, holder) => {
    const shareCount = safeInteger(holder?.shareCount ?? holder?.shares ?? 0, 0);
    const multiplier = safeNumber(String(holder?.holdMultiplier ?? holder?.multiplier ?? "0").replace(/x$/i, ""), 0);
    return sum + (shareCount * multiplier);
  }, 0);
  const proofTxs = txs.map(mapTransaction).filter((tx) => tx.signature).slice(0, 8);
  const estimateExample = getBagRewardPower(minimumTokens * 2, minimumTokens, 7);
  const dexCard = dexSummary && dexSummary.url ? dexSummary : null;
  const shareDescription = `Every full ${formatCount(minimumTokens)} BTCBANK = 1 base share`;
  const tierModelJson = JSON.stringify(TIER_CALC_DEFS);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>$BTCBANK - Bitcoin Bank. Real Rewards.</title>
<meta name="description" content="Bitcoin Bank on Solana. Live creator-fee flow converts into wrapped Bitcoin for qualifying holders every cycle. Stop jeeting. Stop selling. Hold enough and hold long enough." />
<meta name="keywords" content="BTCBANK, Bitcoin Bank, wrapped bitcoin rewards, Solana, wBTC, Bitcoin rewards token, crypto holder rewards" />
<meta name="theme-color" content="#080808" />
<meta name="robots" content="index,follow,max-image-preview:large" />
<link rel="canonical" href="${SITE_URL}/" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="BTCBANK" />
<meta property="og:title" content="BTCBANK | Bitcoin Bank. Real Rewards." />
<meta property="og:description" content="The Bitcoin-bank thesis on Solana: creator-fee flow in, wrapped Bitcoin out. Live rounds, public proof, real holder tiers, and nonstop distribution." />
<meta property="og:url" content="${SITE_URL}/" />
<meta property="og:image" content="${SITE_URL}/api/og" />
<meta property="og:image:alt" content="BTCBANK - Bitcoin Bank. Real Rewards." />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="BTCBANK | Bitcoin Bank. Real Rewards." />
<meta name="twitter:description" content="Hold enough. Hold long enough. Creator-fee flow gets routed into wrapped Bitcoin for qualifying BTCBANK holders." />
<meta name="twitter:image" content="${SITE_URL}/api/og" />
<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "BTCBANK",
  alternateName: "Bitcoin Bank",
  url: SITE_URL,
  description: "A Solana-based Bitcoin reward system routing creator-fee flow into wrapped Bitcoin for qualifying holders.",
  sameAs: [COINGECKO_URL],
})}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--btc:#f7931a;--btc-dark:#c76a00;--bg:#080808;--bg2:#0d0d0d;--bg3:#111;--border:#1e1e1e;--border2:#2a2a2a;--text:#f0f0f0;--muted:#666;--muted2:#444;--green:#22c55e;--red:#ef4444;--mono:'JetBrains Mono',monospace;--display:'Bebas Neue',sans-serif;--body:'Space Grotesk',sans-serif}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--text);font-family:var(--body);font-size:16px;line-height:1.6;overflow-x:hidden}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:var(--bg)}::-webkit-scrollbar-thumb{background:var(--btc-dark);border-radius:2px}
.ticker-bar{background:#000;border-bottom:1px solid var(--border);height:36px;overflow:hidden;position:relative}
.ticker-track{display:flex;align-items:center;height:100%;animation:ticker 40s linear infinite;white-space:nowrap;width:max-content}
@keyframes ticker{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
.ticker-item{display:inline-flex;align-items:center;gap:8px;padding:0 32px;font-size:12px;font-family:var(--mono);color:var(--muted)}
.ticker-item .val{color:var(--btc);font-weight:600}
.ticker-item .sep{color:var(--border2)}
.ticker-up{color:var(--green)!important}
nav{position:sticky;top:0;z-index:100;background:rgba(8,8,8,0.95);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);padding:0 clamp(16px,4vw,40px);height:56px;display:flex;align-items:center;justify-content:space-between}
.nav-logo{display:flex;align-items:center;gap:8px;text-decoration:none}
.nav-coin{width:26px;height:26px;background:var(--btc);border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:13px;color:#000;flex-shrink:0}
.nav-name{font-family:var(--display);font-size:20px;letter-spacing:1px;color:#fff}
.nav-name span{color:var(--btc)}
.nav-links{display:flex;gap:20px;list-style:none}
.nav-links a{color:var(--muted);text-decoration:none;font-size:12px;font-weight:500;letter-spacing:0.5px;transition:color .2s}
.nav-links a:hover{color:var(--btc)}
.nav-cta{background:var(--btc);color:#000;font-weight:700;font-size:12px;padding:7px 16px;border-radius:6px;text-decoration:none;white-space:nowrap}
.nav-cta:hover{background:#fff}
.nav-mobile-menu{display:none;background:none;border:1px solid var(--border2);border-radius:6px;padding:6px 10px;color:var(--text);cursor:pointer;font-size:18px}
.hero{min-height:92vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px clamp(16px,4vw,40px) 40px;text-align:center;position:relative;overflow:hidden}
.hero-bg{position:absolute;inset:0;background:radial-gradient(ellipse 80% 50% at 50% 0%,rgba(247,147,26,.07) 0%,transparent 70%);pointer-events:none}
.hero-grid{position:absolute;inset:0;background-image:linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px);background-size:60px 60px;opacity:.25;pointer-events:none}
.live-badge{display:inline-flex;align-items:center;gap:7px;background:rgba(247,147,26,.1);border:1px solid rgba(247,147,26,.3);border-radius:20px;padding:5px 14px;margin-bottom:28px;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:var(--btc)}
.live-dot{width:6px;height:6px;background:var(--btc);border-radius:50%;animation:blink 1.5s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
.hero h1{font-family:var(--display);font-size:clamp(52px,11vw,128px);line-height:.9;letter-spacing:2px;margin-bottom:20px;color:#fff}
.hero h1 .orange{color:var(--btc)}
.hero h1 .outline{-webkit-text-stroke:2px var(--btc);color:transparent}
.hero-sub{font-size:clamp(15px,2vw,20px);color:var(--muted);max-width:620px;margin:0 auto 32px;font-weight:300;line-height:1.7}
.hero-sub strong{color:var(--text);font-weight:500}
.hero-stats{display:flex;gap:clamp(16px,4vw,40px);justify-content:center;margin-bottom:40px;flex-wrap:wrap}
.hero-stat-val{font-family:var(--mono);font-size:clamp(20px,3vw,28px);font-weight:600;color:#fff}
.hero-stat-val span{color:var(--btc)}
.hero-stat-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:2px}
.hero-buttons{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.btn-primary{background:var(--btc);color:#000;font-weight:700;font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none;transition:all .2s;display:inline-block}
.btn-primary:hover{background:#fff;transform:translateY(-2px)}
.btn-secondary{background:transparent;color:var(--text);font-weight:500;font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none;border:1px solid var(--border2);transition:all .2s;display:inline-block}
.btn-secondary:hover{border-color:var(--btc);color:var(--btc)}
section{padding:clamp(60px,8vw,100px) clamp(16px,4vw,40px)}
.container{max-width:1100px;margin:0 auto}
.section-label{font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:var(--btc);margin-bottom:12px}
.section-title{font-family:var(--display);font-size:clamp(36px,6vw,68px);line-height:1;margin-bottom:16px;color:#fff}
.section-title span{color:var(--btc)}
.section-desc{font-size:17px;color:var(--muted);max-width:660px;line-height:1.8;font-weight:300}
.problem-section{background:var(--bg2)}
.problem-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:48px}
.panel-card{background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:28px}
.panel-card h3{font-family:var(--display);font-size:26px;letter-spacing:1px;margin-bottom:14px;display:flex;align-items:center;gap:10px}
.icon-circle{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
.icon-red{background:rgba(239,68,68,.15);color:var(--red)}
.icon-green{background:rgba(34,197,94,.15);color:var(--green)}
.panel-card p{color:var(--muted);line-height:1.8;margin-bottom:12px;font-size:14px}
.step-list{list-style:none;display:flex;flex-direction:column;gap:10px;margin-top:4px}
.step-list li{display:flex;align-items:flex-start;gap:10px;font-size:13px;color:var(--muted)}
.step-num{width:22px;height:22px;background:var(--btc);border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:10px;color:#000;flex-shrink:0;margin-top:3px}
.step-list li strong{color:var(--text);display:block;font-weight:500;font-size:13px}
.alert-box{border-radius:8px;padding:14px 18px;margin-top:16px;font-size:13px;line-height:1.7}
.alert-warn{background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);color:var(--red)}
.alert-ok{background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.2);color:var(--green)}
.lore-section{background:var(--bg);position:relative;overflow:hidden}
.story-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:42px}
.story-column{background:var(--bg3);border:1px solid var(--border);border-radius:16px;padding:26px;position:relative;overflow:hidden}
.story-column::before{content:'';position:absolute;inset:0 0 auto 0;height:1px;background:linear-gradient(90deg,transparent,rgba(247,147,26,.55),transparent)}
.story-column.memes::before{background:linear-gradient(90deg,transparent,rgba(34,197,94,.45),transparent)}
.story-kicker{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--btc);margin-bottom:10px}
.story-column.memes .story-kicker{color:var(--green)}
.story-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
.story-head h3{font-family:var(--display);font-size:34px;line-height:1;letter-spacing:1px;color:#fff}
.story-head h3 span{color:var(--btc)}
.story-column.memes .story-head h3 span{color:var(--green)}
.story-lead{font-size:14px;color:var(--muted);line-height:1.8;font-weight:300;margin-bottom:18px}
.story-logos{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.story-logo{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:11px;font-weight:700;border:1px solid rgba(247,147,26,.3);background:rgba(247,147,26,.12);color:var(--btc);box-shadow:inset 0 0 18px rgba(247,147,26,.08)}
.story-logo.memes{border-color:rgba(34,197,94,.25);background:rgba(34,197,94,.08);color:#b8ffcc}
.story-logo img{width:24px;height:24px;object-fit:contain;display:block}
.timeline{margin-top:6px;display:flex;flex-direction:column;gap:0}
.tl-item{display:grid;grid-template-columns:100px 1fr;gap:32px;position:relative;padding-bottom:40px}
.tl-item:last-child{padding-bottom:0}
.tl-item::before{content:'';position:absolute;left:50px;top:28px;bottom:0;width:1px;background:linear-gradient(180deg,var(--btc),transparent)}
.tl-item:last-child::before{display:none}
.tl-year{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--btc);padding-top:4px;text-align:right}
.tl-dot{position:absolute;left:44px;top:6px;width:14px;height:14px;background:var(--btc);border-radius:50%;border:3px solid var(--bg)}
.story-column.memes .tl-item::before{background:linear-gradient(180deg,rgba(34,197,94,.75),transparent)}
.story-column.memes .tl-year{color:var(--green)}
.story-column.memes .tl-dot{background:var(--green)}
.tl-content h3{font-family:var(--display);font-size:24px;letter-spacing:1px;color:#fff;margin-bottom:6px}
.tl-content p{color:var(--muted);font-size:14px;line-height:1.8;font-weight:300}
.price-tag{display:inline-block;background:rgba(247,147,26,.1);border:1px solid rgba(247,147,26,.25);border-radius:5px;padding:3px 10px;font-family:var(--mono);font-size:12px;color:var(--btc);margin-top:8px}
.story-column.memes .price-tag{background:rgba(34,197,94,.08);border-color:rgba(34,197,94,.2);color:#9cf3b5}
.story-note{background:rgba(247,147,26,.06);border:1px solid rgba(247,147,26,.18);border-radius:10px;padding:16px 18px;margin-top:16px;font-size:13px;color:#e5e5e5;line-height:1.7}
.story-column.memes .story-note{background:rgba(34,197,94,.06);border-color:rgba(34,197,94,.18)}
.story-sources{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
.story-source{display:inline-flex;align-items:center;gap:6px;background:#0d0d0d;border:1px solid var(--border2);border-radius:999px;padding:6px 10px;font-size:11px;color:#c9c9c9;text-decoration:none}
.story-source:hover{border-color:rgba(247,147,26,.35);color:#fff}
.lore-quote{background:var(--bg3);border-left:3px solid var(--btc);border-radius:0 10px 10px 0;padding:24px 28px;margin-top:28px}
.lore-quote p{font-size:18px;color:var(--text);line-height:1.7;font-weight:300;font-style:italic}
.lore-quote span{display:block;margin-top:10px;font-size:12px;color:var(--muted);font-style:normal;font-family:var(--mono)}
.wbtc-section{background:var(--bg2)}
.wbtc-grid{display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:start;margin-top:48px}
.wbtc-flow-row{display:flex;align-items:center;gap:0;margin-bottom:12px}
.wbtc-node{background:var(--bg3);border:1px solid var(--border2);border-radius:8px;padding:16px 12px;flex:1;text-align:center}
.wbtc-node-icon{font-size:22px;margin-bottom:4px}
.wbtc-node-lbl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px}
.wbtc-node-val{font-family:var(--mono);font-size:13px;font-weight:600;color:#fff;margin-top:2px}
.wbtc-arr{color:var(--btc);font-size:18px;padding:0 6px;flex-shrink:0}
.wbtc-callout{background:rgba(247,147,26,.06);border:1px solid rgba(247,147,26,.2);border-radius:8px;padding:16px 20px;margin-bottom:12px}
.wbtc-callout p{font-size:13px;color:var(--text);line-height:1.7}
.wbtc-callout strong{color:var(--btc)}
.flow-steps{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:16px 20px}
.flow-step-row{display:flex;align-items:center;gap:10px;font-size:13px;padding:5px 0}
.flow-step-row:not(:last-child){border-bottom:1px solid var(--border)}
.flow-num{width:22px;height:22px;background:rgba(247,147,26,.15);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--btc);flex-shrink:0}
.wbtc-facts{display:flex;flex-direction:column;gap:18px}
.wbtc-fact{display:flex;gap:14px}
.wf-icon{width:34px;height:34px;border-radius:7px;background:rgba(247,147,26,.1);border:1px solid rgba(247,147,26,.2);display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0}
.wbtc-fact h4{font-size:14px;font-weight:600;color:#fff;margin-bottom:3px}
.wbtc-fact p{font-size:13px;color:var(--muted);line-height:1.6}
.how-section{background:var(--bg)}
.loop-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border-radius:12px;overflow:hidden;margin-top:48px}
.loop-step{background:var(--bg2);padding:24px 20px;position:relative}
.loop-num{font-family:var(--mono);font-size:10px;color:var(--btc);letter-spacing:1px;text-transform:uppercase;margin-bottom:10px}
.loop-step h3{font-family:var(--display);font-size:20px;letter-spacing:1px;color:#fff;margin-bottom:6px}
.loop-step p{font-size:12px;color:var(--muted);line-height:1.7}
.loop-arr{position:absolute;right:-10px;top:50%;transform:translateY(-50%);width:20px;height:20px;background:var(--btc);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;color:#000;font-weight:700;z-index:2}
.loop-note{background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:20px 24px;margin-top:20px;display:flex;align-items:flex-start;gap:14px}
.loop-note p{font-size:13px;color:var(--muted);line-height:1.7}
.loop-note p strong{color:var(--text)}
.buy-section{background:var(--bg2)}
.buy-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1px;background:var(--border);border-radius:12px;overflow:hidden;margin-top:48px}
.buy-step{background:var(--bg3);padding:28px 22px;position:relative}
.buy-step-num{font-family:var(--display);font-size:48px;color:rgba(247,147,26,.15);line-height:1;margin-bottom:10px}
.buy-step h3{font-size:15px;font-weight:600;color:#fff;margin-bottom:8px}
.buy-step p{font-size:13px;color:var(--muted);line-height:1.7}
.buy-step a{color:var(--btc);text-decoration:none;font-weight:500}
.buy-step a:hover{text-decoration:underline}
.buy-step .badge{display:inline-block;background:rgba(247,147,26,.1);border:1px solid rgba(247,147,26,.2);border-radius:4px;padding:2px 8px;font-family:var(--mono);font-size:11px;color:var(--btc);margin-top:8px}
.buy-warning{background:rgba(247,147,26,.06);border:1px solid rgba(247,147,26,.2);border-radius:10px;padding:18px 22px;margin-top:16px;display:flex;gap:12px;align-items:flex-start}
.buy-warning p{font-size:13px;color:var(--text);line-height:1.7}
.buy-warning p span{color:var(--btc);font-weight:600}
.tiers-section{background:var(--bg)}
.tiers-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:40px}
.tier-card{background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:18px 14px;text-align:center;transition:all .3s;position:relative;overflow:hidden}
.tier-card:hover{border-color:rgba(247,147,26,.3);transform:translateY(-3px)}
.tier-card.featured{border-color:rgba(247,147,26,.4);background:linear-gradient(135deg,rgba(247,147,26,.07) 0%,var(--bg3) 100%)}
.tier-card.featured::after{content:'MAX';position:absolute;top:7px;right:7px;background:var(--btc);color:#000;font-size:8px;font-weight:700;padding:2px 5px;border-radius:3px;letter-spacing:1px}
.tier-card.locked{background:rgba(239,68,68,.04);border-color:rgba(239,68,68,.15)}
.tier-icon{font-size:24px;margin-bottom:8px}
.tier-name{font-family:var(--display);font-size:18px;letter-spacing:1px;color:#fff;margin-bottom:2px}
.tier-card.locked .tier-name{color:var(--red)}
.tier-hold{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}
.tier-mult{font-family:var(--mono);font-size:20px;font-weight:600;color:var(--btc);margin-bottom:2px}
.tier-card.locked .tier-mult{color:var(--red);font-size:14px}
.tier-mult-lbl{font-size:9px;color:var(--muted2);text-transform:uppercase;letter-spacing:1px}
.tier-min{font-size:10px;color:var(--muted2);margin-top:8px;padding-top:8px;border-top:1px solid var(--border)}
.tiers-formula{background:var(--bg3);border:1px solid var(--border2);border-radius:10px;padding:20px 24px;margin-top:16px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.formula-item-lbl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
.formula-item-val{font-family:var(--mono);font-size:14px}
.formula-item-val.orange{color:var(--btc)}
.formula-item-val.red{color:var(--red)}
.formula-item-val.green{color:var(--green)}
.tier-check-grid{display:grid;grid-template-columns:1.05fr .95fr;gap:24px;margin-top:24px;align-items:start}
.tier-stack{display:flex;flex-direction:column;gap:16px}
.tier-notes{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.tier-note{background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:18px 20px}
.tier-note h4{font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--btc);margin-bottom:8px}
.tier-note p{font-size:13px;color:var(--muted);line-height:1.75}
.checker-anchor{display:block;position:relative;top:-78px;visibility:hidden}
.checker-shell{display:grid;grid-template-columns:1.05fr .95fr;gap:24px;margin-top:40px}
.checker-card{background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:24px}
.checker-card h3{font-family:var(--display);font-size:28px;letter-spacing:1px;margin-bottom:10px}
.checker-card p{font-size:14px;color:var(--muted);line-height:1.8}
.checker-card.sticky{position:sticky;top:84px}
.checker-card .checker-mini{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}
.checker-mini-card{background:#0d0d0d;border:1px solid var(--border2);border-radius:10px;padding:12px}
.checker-mini-card span{display:block;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
.checker-mini-card strong{display:block;font-family:var(--mono);font-size:13px;color:#fff}
.checker-form{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
.checker-form input{flex:1;min-width:240px;background:#0c0c0c;border:1px solid var(--border2);border-radius:8px;color:#fff;padding:14px 16px;font-size:14px;font-family:var(--mono)}
.checker-form input:focus{outline:none;border-color:rgba(247,147,26,.6)}
.checker-helper{margin-top:12px;font-size:12px;color:var(--muted)}
.checker-placeholder,.checker-result{background:#0d0d0d;border:1px solid var(--border2);border-radius:12px;padding:18px}
.checker-placeholder{font-size:14px;color:var(--muted);line-height:1.8}
.checker-state{font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:var(--btc);margin-bottom:8px}
.checker-wallet{font-family:var(--mono);font-size:12px;color:#c7c7c7;word-break:break-all}
.checker-topline{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
.checker-tier-pill{background:rgba(247,147,26,.1);border:1px solid rgba(247,147,26,.25);border-radius:999px;padding:6px 12px;font-size:11px;color:var(--btc);font-weight:700;letter-spacing:1px;text-transform:uppercase}
.checker-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.checker-metric{background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px}
.checker-metric span{display:block;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px}
.checker-metric strong{display:block;font-family:var(--mono);font-size:14px;color:#fff}
.checker-message{margin-top:14px;font-size:13px;line-height:1.7;color:#d9d9d9}
.checker-miss .checker-message{color:#fca5a5}
.lb-section{background:var(--bg2)}
.lb-controls{display:flex;gap:8px;margin:24px 0 16px;flex-wrap:wrap}
.lb-btn{background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:6px 14px;font-size:12px;color:var(--muted);cursor:pointer;transition:all .2s;font-family:var(--body)}
.lb-btn.active,.lb-btn:hover{background:rgba(247,147,26,.1);border-color:rgba(247,147,26,.3);color:var(--btc)}
.lb-table-wrap{background:var(--bg3);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.lb-table{width:100%;border-collapse:collapse;font-size:13px}
.lb-table th{background:var(--bg);padding:10px 16px;text-align:left;font-size:10px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border)}
.lb-table td{padding:10px 16px;border-bottom:1px solid var(--border);vertical-align:middle}
.lb-table tr:last-child td{border-bottom:none}
.lb-table tr:hover td{background:rgba(247,147,26,.03)}
.rank-num{font-family:var(--mono);font-size:12px;color:var(--muted2)}
.rank-num.gold{color:#fbbf24;font-weight:700}
.rank-num.silver{color:#94a3b8;font-weight:700}
.rank-num.bronze{color:#cd7c2f;font-weight:700}
.addr-cell{font-family:var(--mono);font-size:12px;color:var(--text)}
.tier-pill{display:inline-flex;align-items:center;gap:4px;background:rgba(247,147,26,.1);border:1px solid rgba(247,147,26,.2);border-radius:4px;padding:2px 7px;font-size:10px;color:var(--btc);font-weight:600}
.tier-pill.satoshi{background:rgba(247,147,26,.2);border-color:rgba(247,147,26,.4)}
.wbtc-val{font-family:var(--mono);font-size:12px;color:var(--btc);font-weight:600}
.mult-val{font-family:var(--mono);font-size:12px;color:var(--green)}
.lb-empty{text-align:center;padding:48px;color:var(--muted);font-size:14px}
.lb-loading{text-align:center;padding:32px;color:var(--muted);font-size:13px}
.tx-section{background:var(--bg)}
.tx-list{display:flex;flex-direction:column;gap:0;background:var(--bg3);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-top:24px}
.tx-row{display:grid;grid-template-columns:1fr auto auto auto auto;gap:16px;align-items:center;padding:12px 18px;border-bottom:1px solid var(--border);transition:background .15s}
.tx-row:last-child{border-bottom:none}
.tx-row:hover{background:rgba(247,147,26,.03)}
.tx-addr{font-family:var(--mono);font-size:12px;color:var(--text)}
.tx-round{font-family:var(--mono);font-size:11px;color:var(--muted)}
.tx-wbtc{font-family:var(--mono);font-size:12px;color:var(--btc);font-weight:600;text-align:right}
.tx-time{font-size:11px;color:var(--muted2);text-align:right;white-space:nowrap}
.tx-header{display:grid;grid-template-columns:1fr auto auto auto auto;gap:16px;padding:10px 18px;background:var(--bg);border-bottom:1px solid var(--border);font-size:10px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--muted)}
.tx-empty{text-align:center;padding:48px;color:var(--muted);font-size:14px}
.load-more{width:100%;padding:12px;background:var(--bg3);border:none;border-top:1px solid var(--border);color:var(--muted);font-size:13px;cursor:pointer;font-family:var(--body);transition:color .2s}
.load-more:hover{color:var(--btc)}
.stats-section{background:var(--bg2)}
.stats-panel{background:var(--bg3);border:1px solid var(--border);border-radius:14px;overflow:hidden;margin-top:36px}
.stats-hdr{background:var(--bg);border-bottom:1px solid var(--border);padding:14px 20px;display:flex;align-items:center;justify-content:space-between}
.stats-hdr-l{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px}
.stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border)}
.stat-cell{background:var(--bg3);padding:20px;text-align:center}
.stat-cell-val{font-family:var(--mono);font-size:22px;font-weight:600;color:#fff;margin-bottom:3px}
.stat-cell-val .o{color:var(--btc)}
.stat-cell-lbl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px}
.stats-ftr{padding:12px 20px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted)}
.why-section{background:var(--bg);position:relative;overflow:hidden}
.why-bg{position:absolute;inset:0;background:radial-gradient(ellipse 70% 40% at 50% 100%,rgba(247,147,26,.05) 0%,transparent 60%);pointer-events:none}
.why-grid{display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center;margin-top:48px}
.big-stmt{font-family:var(--display);font-size:clamp(36px,5vw,64px);line-height:.95;color:#fff}
.big-stmt span{color:var(--btc)}
.big-stmt .outline{-webkit-text-stroke:1.5px var(--btc);color:transparent}
.big-stmt-sub{font-size:15px;color:var(--muted);margin-top:18px;line-height:1.8;font-weight:300;max-width:380px}
.why-points{display:flex;flex-direction:column;gap:24px}
.why-point{display:flex;gap:14px}
.why-line{width:2px;background:linear-gradient(180deg,var(--btc),transparent);border-radius:2px;flex-shrink:0;min-height:56px}
.why-point h4{font-size:14px;font-weight:600;color:#fff;margin-bottom:4px}
.why-point p{font-size:13px;color:var(--muted);line-height:1.7}
.why-ctas{display:flex;gap:10px;margin-top:24px;flex-wrap:wrap}
.hero-live-strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;max-width:760px;width:100%;margin:0 auto 22px}
.hero-live-card{background:rgba(17,17,17,.86);border:1px solid var(--border);border-radius:10px;padding:14px 16px;text-align:left}
.hero-live-card span{display:block;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px}
.hero-live-card strong{display:block;font-family:var(--mono);font-size:16px;color:#fff}
.hero-live-card strong.o{color:var(--btc)}
.hero-qualify{max-width:860px;width:100%;margin:26px auto 0;display:grid;grid-template-columns:1.1fr .9fr;gap:14px;align-items:start}
.hero-check-card,.hero-round-card{background:rgba(17,17,17,.92);border:1px solid var(--border);border-radius:14px;padding:18px 18px 16px;text-align:left}
.hero-check-card h3,.hero-round-card h3{font-family:var(--display);font-size:26px;letter-spacing:1px;margin-bottom:6px}
.hero-check-card p,.hero-round-card p{font-size:13px;color:var(--muted);line-height:1.7}
.hero-round-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.hero-round-pill{background:#0d0d0d;border:1px solid var(--border2);border-radius:10px;padding:12px}
.hero-round-pill span{display:block;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
.hero-round-pill strong{display:block;font-family:var(--mono);font-size:14px;color:#fff}
.chart-shell{background:var(--bg3);border:1px solid var(--border);border-radius:14px;overflow:hidden;margin-top:26px}
.chart-shell iframe{display:block;width:100%;height:360px;border:0;background:#000}
.chart-shell-fallback{padding:26px}
.mini-links{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}
.mini-link{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:999px;border:1px solid var(--border2);background:#0d0d0d;color:#d7d7d7;text-decoration:none;font-size:12px}
.mini-link:hover{border-color:rgba(247,147,26,.35);color:#fff}
.proof-section,.calc-section,.faq-section,.manifesto-section,.brand-teaser-section{background:var(--bg)}
.proof-panel,.calc-panel,.faq-panel,.manifesto-panel,.brand-teaser-panel{background:var(--bg3);border:1px solid var(--border);border-radius:14px}
.proof-panel{overflow:hidden;margin-top:28px}
.proof-head{display:grid;grid-template-columns:1.2fr auto auto auto;gap:14px;padding:12px 18px;background:var(--bg);border-bottom:1px solid var(--border);font-size:10px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--muted)}
.proof-row{display:grid;grid-template-columns:1.2fr auto auto auto;gap:14px;align-items:center;padding:14px 18px;border-bottom:1px solid var(--border)}
.proof-row:last-child{border-bottom:none}
.proof-row:hover{background:rgba(247,147,26,.03)}
.proof-wallet{font-family:var(--mono);font-size:12px;color:#fff}
.proof-meta{font-size:11px;color:var(--muted);margin-top:3px}
.proof-amount,.proof-sig{font-family:var(--mono);font-size:12px}
.proof-amount{color:var(--btc)}
.proof-sig{color:#cfcfcf}
.proof-link{color:var(--btc);text-decoration:none;font-size:12px;font-weight:600}
.proof-empty{padding:28px 24px;font-size:14px;color:var(--muted)}
.proof-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:18px}
.proof-summary-card{background:#0d0d0d;border:1px solid var(--border2);border-radius:12px;padding:16px}
.proof-summary-card span{display:block;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:5px}
.proof-summary-card strong{display:block;font-family:var(--mono);font-size:16px;color:#fff}
.calc-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:30px}
.calc-panel{padding:22px}
.calc-panel h3{font-family:var(--display);font-size:26px;letter-spacing:1px;margin-bottom:8px}
.calc-panel p{font-size:13px;color:var(--muted);line-height:1.7}
.calc-fields{display:flex;flex-direction:column;gap:10px;margin-top:18px}
.calc-fields label{font-size:11px;color:var(--muted);letter-spacing:1px;text-transform:uppercase}
.calc-fields input{width:100%;background:#0c0c0c;border:1px solid var(--border2);border-radius:8px;color:#fff;padding:12px 14px;font-size:14px;font-family:var(--mono)}
.calc-result{margin-top:16px;background:#0d0d0d;border:1px solid var(--border2);border-radius:12px;padding:16px}
.calc-result-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.calc-result span{display:block;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
.calc-result strong{display:block;font-family:var(--mono);font-size:14px;color:#fff}
.compare-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:28px}
.compare-card{background:var(--bg3);border:1px solid var(--border);border-radius:14px;padding:22px}
.compare-card h3{font-family:var(--display);font-size:28px;letter-spacing:1px;margin-bottom:8px}
.compare-card h3 span{color:var(--btc)}
.compare-list{list-style:none;display:flex;flex-direction:column;gap:12px;margin-top:16px}
.compare-list li{font-size:13px;color:var(--muted);line-height:1.7}
.compare-list li strong{color:#fff}
.roadmap-wrap{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:30px}
.roadmap-card{background:var(--bg3);border:1px solid var(--border);border-radius:14px;padding:22px;position:relative}
.roadmap-badge{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px}
.roadmap-done .roadmap-badge{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.28);color:var(--green)}
.roadmap-building .roadmap-badge{background:rgba(247,147,26,.12);border:1px solid rgba(247,147,26,.28);color:var(--btc)}
.roadmap-future .roadmap-badge{background:#0d0d0d;border:1px solid var(--border2);color:var(--muted)}
.roadmap-card h3{font-family:var(--display);font-size:26px;letter-spacing:1px;margin-bottom:8px}
.roadmap-card p{font-size:13px;color:var(--muted);line-height:1.75}
.roadmap-points{list-style:none;display:flex;flex-direction:column;gap:10px;margin-top:14px}
.roadmap-points li{font-size:13px;color:#d8d8d8;line-height:1.65}
.roadmap-card.ghost{opacity:.68}
.faq-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:28px}
.faq-panel{padding:22px}
.faq-panel h3{font-size:16px;font-weight:600;color:#fff;margin-bottom:8px}
.faq-panel p{font-size:13px;color:var(--muted);line-height:1.8}
.manifesto-grid{display:grid;grid-template-columns:1.05fr .95fr;gap:22px;margin-top:28px}
.manifesto-panel{padding:26px}
.manifesto-panel h3{font-family:var(--display);font-size:32px;letter-spacing:1px;margin-bottom:10px}
.manifesto-panel p{font-size:14px;color:var(--muted);line-height:1.85;margin-bottom:12px}
.manifesto-list{list-style:none;display:flex;flex-direction:column;gap:14px;margin-top:12px}
.manifesto-list li{display:flex;gap:12px;font-size:13px;color:var(--muted);line-height:1.75}
.manifesto-list strong{color:#fff}
.manifesto-num{width:24px;height:24px;border-radius:50%;background:rgba(247,147,26,.14);border:1px solid rgba(247,147,26,.22);display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:10px;color:var(--btc);flex-shrink:0;margin-top:1px}
.brand-teaser-panel{padding:28px}
.brand-grid{display:grid;grid-template-columns:1fr auto;gap:20px;align-items:center}
.brand-actions{display:flex;gap:12px;flex-wrap:wrap}
footer{background:var(--bg3);border-top:1px solid var(--border);padding:48px clamp(16px,4vw,40px) 32px}
.footer-grid{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:2fr 1fr 1fr;gap:48px;margin-bottom:40px}
.footer-brand p{color:var(--muted);font-size:13px;line-height:1.8;margin-top:10px;max-width:280px}
.footer-col h4{font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:14px}
.footer-col ul{list-style:none;display:flex;flex-direction:column;gap:9px}
.footer-col ul li a{color:var(--muted);text-decoration:none;font-size:13px;transition:color .2s}
.footer-col ul li a:hover{color:var(--btc)}
.footer-bottom{max-width:1100px;margin:0 auto;padding-top:20px;border-top:1px solid var(--border);display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:11px;color:var(--muted2)}
.footer-disc{max-width:1100px;margin:12px auto 0;font-size:11px;color:var(--muted2);line-height:1.6}
@media(max-width:768px){
  .nav-links{display:none}
  .problem-grid,.story-grid,.wbtc-grid,.why-grid,.footer-grid,.checker-shell,.tier-check-grid,.tier-notes,.hero-qualify,.compare-grid,.faq-grid,.manifesto-grid,.brand-grid{grid-template-columns:1fr}
  .loop-grid{grid-template-columns:1fr}
  .loop-arr{display:none}
  .hero-live-strip,.proof-summary,.calc-grid,.roadmap-wrap{grid-template-columns:1fr}
  .stats-grid{grid-template-columns:1fr 1fr}
  .tiers-grid{grid-template-columns:repeat(2,1fr)}
  .tiers-formula{grid-template-columns:1fr}
  .tx-row,.tx-header{grid-template-columns:1fr auto auto}
  .proof-head,.proof-row{grid-template-columns:1fr auto}
  .tx-round,.tx-time .tx-sig{display:none}
  .buy-grid{grid-template-columns:1fr 1fr}
  .nav-mobile-menu{display:block}
  .checker-metrics{grid-template-columns:1fr 1fr}
  .checker-card.sticky{position:static}
}
@media(max-width:480px){
  .hero h1{font-size:48px}
  .stats-grid,.checker-metrics,.hero-live-strip,.proof-summary,.calc-grid,.roadmap-wrap,.calc-result-grid{grid-template-columns:1fr}
  .tiers-grid{grid-template-columns:1fr 1fr}
  .buy-grid{grid-template-columns:1fr}
}
.mobile-nav{display:none;position:fixed;inset:56px 0 0 0;background:rgba(8,8,8,.98);z-index:99;flex-direction:column;padding:24px 20px;gap:4px}
.mobile-nav.open{display:flex}
.mobile-nav a{color:var(--muted);text-decoration:none;font-size:16px;padding:12px 0;border-bottom:1px solid var(--border);transition:color .2s}
.mobile-nav a:hover{color:var(--btc)}
</style>
</head>
<body>
<div class="ticker-bar" aria-hidden="true">
  <div class="ticker-track">
    <span class="ticker-item">BTC <span class="val" id="t-btc">${escapeHtml(formatUsd(btcPrice, 0))}</span></span>
    <span class="ticker-item sep">·</span>
    <span class="ticker-item">wBTC <span class="val">1:1 BTC</span></span>
    <span class="ticker-item sep">·</span>
    <span class="ticker-item">All-Time Paid <span class="val" id="t-paid">${escapeHtml(formatUsd(allTimeUsd, 0))}</span></span>
    <span class="ticker-item sep">·</span>
    <span class="ticker-item">Rounds <span class="val" id="t-rounds">${escapeHtml(formatCount(roundsCompleted))}</span></span>
    <span class="ticker-item sep">·</span>
    <span class="ticker-item">wBTC Distributed <span class="val" id="t-wbtc">${escapeHtml(formatWbtc(allTimeWbtc, 5))} wBTC</span></span>
    <span class="ticker-item sep">·</span>
    <span class="ticker-item">Holders Paid <span class="val" id="t-holders">${escapeHtml(formatCount(holdersPaid))}</span></span>
    <span class="ticker-item sep">·</span>
    <span class="ticker-item">Supply <span class="val">21,000,000</span></span>
    <span class="ticker-item sep">·</span>
    <span class="ticker-item">Distribution <span class="val ticker-up">LIVE ●</span></span>
    <span class="ticker-item sep">·</span>
    <span class="ticker-item">BTC <span class="val">${escapeHtml(formatUsd(btcPrice, 0))}</span></span>
    <span class="ticker-item sep">·</span>
    <span class="ticker-item">wBTC <span class="val">1:1 BTC</span></span>
    <span class="ticker-item sep">·</span>
    <span class="ticker-item">All-Time Paid <span class="val">${escapeHtml(formatUsd(allTimeUsd, 0))}</span></span>
    <span class="ticker-item sep">·</span>
    <span class="ticker-item">Rounds <span class="val">${escapeHtml(formatCount(roundsCompleted))}</span></span>
    <span class="ticker-item sep">·</span>
    <span class="ticker-item">wBTC Distributed <span class="val">${escapeHtml(formatWbtc(allTimeWbtc, 5))} wBTC</span></span>
    <span class="ticker-item sep">·</span>
    <span class="ticker-item">Holders Paid <span class="val">${escapeHtml(formatCount(holdersPaid))}</span></span>
    <span class="ticker-item sep">·</span>
    <span class="ticker-item">Supply <span class="val">21,000,000</span></span>
    <span class="ticker-item sep">·</span>
    <span class="ticker-item">Distribution <span class="val ticker-up">LIVE ●</span></span>
    <span class="ticker-item sep">·</span>
  </div>
</div>

<nav>
  <a href="#" class="nav-logo">
    <div class="nav-coin">₿</div>
    <div class="nav-name">BTC<span>BANK</span></div>
  </a>
  <ul class="nav-links">
    <li><a href="#problem">Fix Rewards</a></li>
    <li><a href="#lore">The Story</a></li>
    <li><a href="#buy">How to Buy</a></li>
    <li><a href="#tiers">Tiers</a></li>
    <li><a href="#checker">Check Tier</a></li>
    <li><a href="#proof">Proof</a></li>
    <li><a href="#leaderboard">Leaderboard</a></li>
    <li><a href="#stats">Live Stats</a></li>
    <li><a href="#brand-kit">Brand Kit</a></li>
  </ul>
  <a href="#buy" class="nav-cta">Get Started</a>
  <button class="nav-mobile-menu" onclick="toggleMobileNav()" aria-label="Menu">☰</button>
</nav>
<div class="mobile-nav" id="mobileNav">
  <a href="#problem" onclick="closeMobileNav()">Fix Rewards</a>
  <a href="#lore" onclick="closeMobileNav()">The Bitcoin Story</a>
  <a href="#wbtc" onclick="closeMobileNav()">What is wBTC?</a>
  <a href="#buy" onclick="closeMobileNav()">How to Buy</a>
  <a href="#tiers" onclick="closeMobileNav()">Tier System</a>
  <a href="#checker" onclick="closeMobileNav()">Check Your Tier</a>
  <a href="#proof" onclick="closeMobileNav()">Proof Explorer</a>
  <a href="#leaderboard" onclick="closeMobileNav()">Leaderboard</a>
  <a href="#stats" onclick="closeMobileNav()">Live Stats</a>
  <a href="#brand-kit" onclick="closeMobileNav()">Brand Kit</a>
</div>

<section class="hero">
  <div class="hero-bg"></div><div class="hero-grid"></div>
  <div class="live-badge"><div class="live-dot"></div>Distribution running 24/7</div>
  <h1>BITCOIN<br><span class="orange">BANK.</span><br><span class="outline">REAL REWARDS.</span></h1>
  <p class="hero-sub">The only token routing creator-fee flow into <strong>wrapped Bitcoin</strong> for real holders. No claiming. No staking. No babysitting every cycle. <strong>Stop jeeting. Stop selling.</strong> Hold the line and let the Bitcoin side stack for you.</p>
  <div class="hero-stats">
    <div class="hero-stat"><div class="hero-stat-val" id="h-paid"><span>$</span>${escapeHtml(formatCount(allTimeUsd))}</div><div class="hero-stat-label">Paid to holders</div></div>
    <div class="hero-stat"><div class="hero-stat-val" id="h-holders">${escapeHtml(formatCompactCount(holdersPaid))}<span></span></div><div class="hero-stat-label">Wallets paid</div></div>
    <div class="hero-stat"><div class="hero-stat-val" id="h-wbtc">${escapeHtml(formatWbtc(allTimeWbtc, 4))}<span> wBTC</span></div><div class="hero-stat-label">Distributed total</div></div>
    <div class="hero-stat"><div class="hero-stat-val" id="h-rounds">${escapeHtml(formatCount(roundsCompleted))}</div><div class="hero-stat-label">Rounds completed</div></div>
  </div>
  <div class="hero-buttons">
    <a href="#buy" class="btn-primary">How to Buy →</a>
    <a href="#problem" class="btn-secondary">Fix wBTC Display</a>
  </div>
</section>

<section class="problem-section" id="problem">
  <div class="container">
    <div class="section-label">Important — Read This First</div>
    <h2 class="section-title">Your Rewards Are <span>Already There.</span></h2>
    <p class="section-desc">The #1 issue new holders face. Your wBTC rewards are landing in your wallet — your wallet just needs a one-time unlock to show them.</p>
    <div class="alert-box alert-ok" style="margin-bottom:20px">✓ Already had wBTC in your wallet before? You're fine — rewards are landing automatically. This fix is only needed if your wallet has <em>never</em> held wBTC.</div>
    <div class="problem-grid">
      <div class="panel-card">
        <h3><div class="icon-circle icon-red">!</div>Why Some Wallets Can't See Them</h3>
        <p>Solana wallets like Phantom and Solflare only display a token if your wallet has <strong>previously received or held it</strong>. If you've never had wBTC in your wallet before, rewards arrive silently — the balance shows zero even though the tokens are genuinely there.</p>
        <p>This affects wallets that are brand new to wBTC. If you've ever swapped for wBTC, received it, or traded it before — you're already good. Your rewards are showing up fine.</p>
        <div class="alert-box alert-warn" style="margin-top:12px">⚠ This is a Solana token account mechanic — not a bug in $BTCBANK. Our distribution system works correctly. This is a one-time wallet setup, needed only once.</div>
      </div>
      <div class="panel-card">
        <h3><div class="icon-circle icon-green">✓</div>The One-Time Fix (New wBTC Wallets Only)</h3>
        <p>If you've never held wBTC before, do this once — then you're set forever:</p>
        <ul class="step-list">
          <li><div class="step-num">1</div><div><strong>Check if you already have it</strong>Open Phantom or Solflare and search for wBTC in your token list. If it shows up (even at $0), you're already done — skip these steps.</div></li>
          <li><div class="step-num">2</div><div><strong>Swap a tiny amount of SOL → wBTC</strong>Go to <a href="https://jup.ag" target="_blank" rel="noopener" style="color:var(--btc)">jup.ag</a> and swap even $0.50 worth of SOL to wBTC. This creates your wBTC token account on-chain.</div></li>
          <li><div class="step-num">3</div><div><strong>Or receive wBTC from any source</strong>Ask someone to send you a dust amount of wBTC, or buy a tiny amount on any DEX. Any incoming wBTC transaction activates the account.</div></li>
          <li><div class="step-num">4</div><div><strong>Done — permanently</strong>Your wBTC account is now active. Every past and future $BTCBANK reward will be visible. No further action ever needed.</div></li>
        </ul>
        <div class="alert-box alert-ok">✓ Most holders who've been in crypto a while already have wBTC accounts active and never need this step at all.</div>
      </div>
    </div>
  </div>
</section>

<section class="lore-section" id="lore">
  <div class="container">
    <div class="section-label">The Story</div>
    <h2 class="section-title">Bitcoin <span>vs Memecoins</span></h2>
    <p class="section-desc">Memecoins proved the internet can move attention, identity, and capital frighteningly fast. Bitcoin proved what survives after the noise, the ridicule, and the cycle reset. BTCBANK was built around that difference.</p>
    <div class="story-grid">
      <div class="story-column memes">
        <div class="story-kicker">Left side of the culture trade</div>
        <div class="story-head">
          <div>
            <h3>Memecoins: <span>attention, distribution, identity</span></h3>
            <p class="story-lead">The honest version is not "memes are fake." The honest version is that memes are real internet-native markets. They move because people recognize the character, the joke, the tribe, and the ticker before they read a whitepaper.</p>
          </div>
          <div class="story-logos">
            <div class="story-logo memes"><img src="${STORY_LOGO_URLS.doge}" alt="Dogecoin logo" /></div>
            <div class="story-logo memes"><img src="${STORY_LOGO_URLS.shib}" alt="Shiba Inu logo" /></div>
            <div class="story-logo memes"><img src="${STORY_LOGO_URLS.bonk}" alt="Bonk logo" /></div>
          </div>
        </div>
        <div class="timeline">
          <div class="tl-item"><div class="tl-year">2013</div><div class="tl-dot"></div><div class="tl-content"><h3>Dogecoin made the joke liquid</h3><p>Dogecoin's own history page says it was created as a joke by Billy Markus and Jackson Palmer, launched on December 6, 2013, and rapidly became a tipping currency on Reddit. It also became a charity machine: the Jamaican bobsled team, Kenya water wells, and a long list of community-funded stunts proved that a meme could coordinate real money surprisingly fast.</p><div class="price-tag">Meme first, utility second</div></div></div>
          <div class="tl-item"><div class="tl-year">2020</div><div class="tl-dot"></div><div class="tl-content"><h3>SHIB showed scale through community obsession</h3><p>Shiba Inu did not copy Bitcoin's thesis. It copied internet behavior. It spread through branding, speed, social identity, and an army mentality. Over time, the official SHIB ecosystem expanded into swaps, governance, identity, and Shibarium. That is what memecoins can become at their best: a huge distribution layer that tries to grow real utility after culture captures attention.</p><div class="price-tag">Culture can bootstrap an ecosystem</div></div></div>
          <div class="tl-item"><div class="tl-year">2022</div><div class="tl-dot"></div><div class="tl-content"><h3>BONK was a morale reset on Solana</h3><p>BONK's own about page says it began after the market disruption of late 2022, launched on Christmas Day, and distributed more than half its supply to Solana developers and creators. That mattered because it did not feel like a sterile venture launch. It felt like a community gift in a damaged ecosystem, which is exactly the kind of moment where a meme can become a movement.</p><div class="price-tag">Distribution is the real product</div></div></div>
          <div class="tl-item"><div class="tl-year">Lesson</div><div class="tl-dot"></div><div class="tl-content"><h3>What memes proved</h3><p>Memecoins proved that character, comedy, belonging, and distribution are not side issues. They are part of price discovery now. But most memes do not become the final place serious capital hides. They are usually the spark, not the reserve asset.</p><div class="price-tag">Fast attention, uneven permanence</div></div></div>
        </div>
        <div class="story-note">Memecoins are real because communities are real. But most meme cycles still end with one question: which asset do people rotate into when they stop gambling and start preserving?</div>
      </div>
      <div class="story-column">
        <div class="story-kicker">Right side of the long game</div>
        <div class="story-head">
          <div>
            <h3>Bitcoin: <span>ignored, mocked, then adopted</span></h3>
            <p class="story-lead">Bitcoin did not win by being funny or fast-moving. It won by surviving every dismissal cycle long enough for the market to slowly admit what fixed supply, self-custody, and a global neutral asset actually mean.</p>
          </div>
          <div class="story-logos">
            <div class="story-logo"><img src="${STORY_LOGO_URLS.btc}" alt="Bitcoin logo" /></div>
            <div class="story-logo">2008</div>
            <div class="story-logo">ETF</div>
          </div>
        </div>
        <div class="timeline">
          <div class="tl-item"><div class="tl-year">2008</div><div class="tl-dot"></div><div class="tl-content"><h3>A whitepaper and an email</h3><p>On October 31, 2008, Satoshi Nakamoto sent the Bitcoin paper to the cryptography mailing list. It entered the world as a technical proposal, not a marketed launch. Almost nobody cared. That is the pattern every early conviction trade shares: first invisibility, then ridicule, then the slow realization that something durable has been growing under the surface.</p><div class="price-tag">1 BTC approx. $0.00</div></div></div>
          <div class="tl-item"><div class="tl-year">2010</div><div class="tl-dot"></div><div class="tl-content"><h3>Free Bitcoin. Almost no demand.</h3><p>Gavin Andresen's faucet handed out 5 BTC for solving a CAPTCHA because adoption was the problem, not valuation. In the same era, the famous pizza purchase proved Bitcoin could function as money, even when the world treated it like a toy. The key lesson is not the price hindsight. It is that the earliest holders had to act without social proof.</p><div class="price-tag">1 BTC approx. $0.008</div></div></div>
          <div class="tl-item"><div class="tl-year">2011-2017</div><div class="tl-dot"></div><div class="tl-content"><h3>The network survived the ridicule stage</h3><p>Bitcoin spent years being called dead, useless, criminal, speculative, or "just lucky" after each new high. But blocks kept arriving, self-custody kept working, and more people kept discovering that an asset with a hard cap behaves differently from everything around it. By the time Bitcoin crossed into five figures, patience was being misread as luck.</p><div class="price-tag">1 BTC approx. $1 to $10,000</div></div></div>
          <div class="tl-item"><div class="tl-year">2024</div><div class="tl-dot"></div><div class="tl-content"><h3>The institutions acknowledged it late</h3><p>On January 10, 2024, the SEC approved the listing and trading of spot Bitcoin exchange-traded products in the United States. That did not create Bitcoin's legitimacy. It formalized demand after more than a decade of resistance. Once the institutions arrived, they were not discovering Bitcoin early. They were buying what the patient had already endured long enough to own.</p><div class="price-tag">1 BTC approx. $100,000+</div></div></div>
        </div>
        <div class="story-note">Bitcoin's edge was never that everyone understood it immediately. Its edge was that it kept functioning until the doubters slowly became buyers.</div>
      </div>
    </div>
    <div class="story-sources">
      <a class="story-source" href="https://bitcoin.org/en/bitcoin-paper" target="_blank" rel="noopener">Bitcoin whitepaper</a>
      <a class="story-source" href="https://satoshi.nakamotoinstitute.org/emails/cryptography/" target="_blank" rel="noopener">Satoshi mailing list post</a>
      <a class="story-source" href="https://www.sec.gov/newsroom/speeches-statements/gensler-statement-spot-bitcoin-011023" target="_blank" rel="noopener">SEC Jan. 10, 2024 statement</a>
      <a class="story-source" href="https://dogecoin.com/dogepedia/articles/history-of-dogecoin/" target="_blank" rel="noopener">Dogecoin history</a>
      <a class="story-source" href="https://shib.io/tokens/shib" target="_blank" rel="noopener">SHIB official token page</a>
      <a class="story-source" href="https://www.bonkcoin.com/about" target="_blank" rel="noopener">BONK about page</a>
    </div>
    <div class="lore-quote">
      <p>"Every cycle the regret sounds the same: I should have accumulated the serious asset while everyone was distracted. BTCBANK was designed around that exact mistake."</p>
      <span>- The BTCBANK thesis · deeper story page at <a href="/history" style="color:var(--btc);text-decoration:none">Bitcoin vs Memes</a></span>
    </div>
  </div>
</section>

<section class="wbtc-section" id="wbtc">
  <div class="container">
    <div class="section-label">The Reward Asset</div>
    <h2 class="section-title">What Is <span>Wrapped Bitcoin?</span></h2>
    <p class="section-desc">wBTC is Bitcoin — engineered to move at Solana speed. That means the reward can settle fast, cheaply, and still track the asset the market keeps coming back to.</p>
    <div class="wbtc-grid">
      <div>
        <div class="wbtc-flow-row">
          <div class="wbtc-node"><div class="wbtc-node-icon">₿</div><div class="wbtc-node-lbl">Bitcoin</div><div class="wbtc-node-val" id="btcPriceNode">${escapeHtml(formatUsd(btcPrice, 0))}</div></div>
          <div class="wbtc-arr">→</div>
          <div class="wbtc-node"><div class="wbtc-node-icon">⚡</div><div class="wbtc-node-lbl">Wrapped</div><div class="wbtc-node-val">1:1 Peg</div></div>
          <div class="wbtc-arr">→</div>
          <div class="wbtc-node"><div class="wbtc-node-icon">◎</div><div class="wbtc-node-lbl">On Solana</div><div class="wbtc-node-val">Fast & Cheap</div></div>
        </div>
        <div class="wbtc-callout">
          <p><strong>1 wBTC = 1 BTC in price, always.</strong> When Bitcoin appreciates, your accumulated wBTC appreciates with it. This is not a random alt reward. This is direct Bitcoin-linked exposure arriving automatically.</p>
        </div>
        <div class="flow-steps">
          <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Reward cycle — nonstop</div>
          <div class="flow-step-row"><div class="flow-num">1</div><span style="color:var(--muted);font-size:13px">Bot claims <strong style="color:var(--text)">SOL creator rewards</strong></span></div>
          <div class="flow-step-row"><div class="flow-num">2</div><span style="color:var(--muted);font-size:13px">SOL converts to <strong style="color:var(--text)">wBTC on-chain</strong></span></div>
          <div class="flow-step-row"><div class="flow-num">3</div><span style="color:var(--muted);font-size:13px">wBTC lands in <strong style="color:var(--text)">qualifying holder wallets</strong></span></div>
        </div>
      </div>
      <ul class="wbtc-facts">
        <li class="wbtc-fact"><div class="wf-icon">₿</div><div><h4>Bitcoin's scarcity, Solana's speed</h4><p>21 million BTC cap, forever. wBTC inherits that scarcity while settling instantly on Solana for fractions of a cent.</p></div></li>
        <li class="wbtc-fact"><div class="wf-icon">📈</div><div><h4>Rewards that grow with Bitcoin</h4><p>Stablecoins stay flat. wBTC tracks Bitcoin. The rewards you accumulate now can become more valuable if Bitcoin's long-term trend continues.</p></div></li>
        <li class="wbtc-fact"><div class="wf-icon">🔁</div><div><h4>Every cycle comes back to Bitcoin</h4><p>Alt narratives change fast. Bitcoin keeps surviving the full cycle. $BTCBANK routes your reward stream back into the asset the market still treats as the final benchmark.</p></div></li>
        <li class="wbtc-fact"><div class="wf-icon">🤝</div><div><h4>Zero action required</h4><p>Hold $BTCBANK. The system handles everything else. Stop jeeting. Stop selling. Let the timer and the stack work.</p></div></li>
      </ul>
    </div>
  </div>
</section>

<section class="how-section" id="how">
  <div class="container">
    <div class="section-label">The Mechanism</div>
    <h2 class="section-title">The Self-Reinforcing <span>Loop</span></h2>
    <p class="section-desc">This is not just a reward system. It's a flywheel. Trading feeds SOL, SOL buys Bitcoin exposure, and holding longer increases your slice of the next round.</p>
    <div class="loop-grid">
      <div class="loop-step"><div class="loop-num">Step 01</div><h3>PumpFun Pays Creators</h3><p>Every trade of $BTCBANK on pump.fun generates creator fees in SOL. The bot claims these automatically — no manual action, ever.</p><div class="loop-arr">→</div></div>
      <div class="loop-step"><div class="loop-num">Step 02</div><h3>SOL Hits the Treasury</h3><p>Claimed SOL flows into the $BTCBANK treasury. This is the raw fuel for every distribution — real on-chain revenue from real trading activity.</p><div class="loop-arr">→</div></div>
      <div class="loop-step"><div class="loop-num">Step 03</div><h3>Treasury Swaps to wBTC</h3><p>The bot swaps treasury SOL into wrapped Bitcoin on-chain. SOL goes in. Bitcoin exposure comes out.</p></div>
      <div class="loop-step"><div class="loop-num">Step 04</div><h3>wBTC Distributed to Holders</h3><p>wBTC is sent proportionally to every qualifying wallet. Bigger bags and longer holds = larger share.</p><div class="loop-arr">→</div></div>
      <div class="loop-step"><div class="loop-num">Step 05</div><h3>Holders Earn Bitcoin Exposure</h3><p>Every holder automatically accumulates wBTC — which tracks Bitcoin 1:1. The longer you keep qualifying, the more your historical distributions matter.</p><div class="loop-arr">→</div></div>
      <div class="loop-step"><div class="loop-num">Step 06</div><h3>Loop Repeats Constantly</h3><p>More trading → more creator fees → more SOL → more wBTC → more rewards. The system is built to keep feeding the next round.</p></div>
    </div>
    <div class="loop-note"><div style="font-size:22px;flex-shrink:0">💡</div><p><strong>The simple version:</strong> People trade $BTCBANK → the fees get claimed as SOL → SOL gets swapped to wBTC → wBTC lands in your wallet. Stop jeeting. Stop selling. Keep the timer alive.</p></div>
  </div>
</section>

<section class="buy-section" id="buy">
  <div class="container">
    <div class="section-label">Get Started</div>
    <h2 class="section-title">How to <span>Buy $BTCBANK</span></h2>
    <p class="section-desc">Five steps from zero to earning wBTC automatically. The setup is simple, but the important part is what happens after: hold enough and hold long enough.</p>
    <div class="buy-grid">
      <div class="buy-step"><div class="buy-step-num">01</div><h3>Get a Solana Wallet</h3><p>Download <a href="https://phantom.app" target="_blank" rel="noopener">Phantom</a> or <a href="https://solflare.com" target="_blank" rel="noopener">Solflare</a>. Write your seed phrase on paper — never digitally. This wallet is your bank.</p><div class="badge">phantom.app · solflare.com</div></div>
      <div class="buy-step"><div class="buy-step-num">02</div><h3>Get Some SOL</h3><p>Buy SOL on Coinbase, Kraken, or Binance. Send it to your Phantom/Solflare wallet address. Keep a little extra for transaction fees.</p><div class="badge">Coinbase · Kraken · Binance</div></div>
      <div class="buy-step"><div class="buy-step-num">03</div><h3>Activate wBTC First</h3><p>Before buying $BTCBANK, swap a tiny amount of SOL to wBTC on <a href="https://jup.ag" target="_blank" rel="noopener">jup.ag</a>. Even $0.50 is enough to activate the token account.</p><div class="badge">jup.ag — swap SOL → wBTC</div></div>
      <div class="buy-step"><div class="buy-step-num">04</div><h3>Buy $BTCBANK</h3><p>On <a href="https://jup.ag" target="_blank" rel="noopener">Jupiter</a> or <a href="https://raydium.io" target="_blank" rel="noopener">Raydium</a>, swap SOL for $BTCBANK. You need at least <strong>${escapeHtml(formatCount(minimumTokens))} tokens</strong> to qualify for rewards.</p><div class="badge">Min ${escapeHtml(formatCount(minimumTokens))} $BTCBANK</div></div>
      <div class="buy-step"><div class="buy-step-num">05</div><h3>Hold and Earn</h3><p>That's it. wBTC rewards arrive automatically. The longer you hold without falling below the line, the higher your tier multiplier and the bigger your share.</p><div class="badge">Stop jeeting · keep the timer alive</div></div>
    </div>
    <div class="buy-warning"><div style="font-size:20px;flex-shrink:0">⚠️</div><p>Always verify the <span>contract address</span> before buying. Use official BTCBANK links only. If someone DMs you a "better" contract, it's a scam.</p></div>
  </div>
</section>

<section class="tiers-section" id="tiers">
  <div class="container">
    <div class="section-label">Hold More. Earn More.</div>
    <h2 class="section-title">The <span>Tier System</span></h2>
    <p class="section-desc">Your multiplier increases with time. The bag qualifies you. The clock boosts you. Selling below the line resets the timer.</p>
    <div class="tier-check-grid">
      <div class="tier-stack">
        <div class="tiers-grid">
          <div class="tier-card locked"><div class="tier-icon">🔒</div><div class="tier-name">Locked</div><div class="tier-hold">Under ${escapeHtml(formatCount(minimumTokens))} tokens</div><div class="tier-mult">No Rewards</div><div class="tier-mult-lbl">not eligible</div><div class="tier-min">Buy ${escapeHtml(formatCount(minimumTokens))}+ to qualify</div></div>
          <div class="tier-card"><div class="tier-icon">🪙</div><div class="tier-name">Holder</div><div class="tier-hold">Just qualified</div><div class="tier-mult">1.00x</div><div class="tier-mult-lbl">base reward</div><div class="tier-min">${escapeHtml(formatCount(minimumTokens))} min</div></div>
          <div class="tier-card"><div class="tier-icon">📦</div><div class="tier-name">Stacker</div><div class="tier-hold">24 hours+</div><div class="tier-mult">1.01x</div><div class="tier-mult-lbl">multiplier</div><div class="tier-min">Don't sell for 24h</div></div>
          <div class="tier-card"><div class="tier-icon">⛏️</div><div class="tier-name">Miner</div><div class="tier-hold">72 hours+</div><div class="tier-mult">1.03x</div><div class="tier-mult-lbl">multiplier</div><div class="tier-min">3 days held</div></div>
          <div class="tier-card"><div class="tier-icon">🧱</div><div class="tier-name">Veteran</div><div class="tier-hold">7 days+</div><div class="tier-mult">1.07x</div><div class="tier-mult-lbl">multiplier</div><div class="tier-min">One week strong</div></div>
          <div class="tier-card"><div class="tier-icon">🏦</div><div class="tier-name">OG</div><div class="tier-hold">14 days+</div><div class="tier-mult">1.12x</div><div class="tier-mult-lbl">multiplier</div><div class="tier-min">Two weeks in</div></div>
          <div class="tier-card featured"><div class="tier-icon">₿</div><div class="tier-name">Satoshi</div><div class="tier-hold">30 days+</div><div class="tier-mult">1.20x</div><div class="tier-mult-lbl">max multiplier</div><div class="tier-min">The true believers</div></div>
        </div>
        <div class="tiers-formula">
          <div><div class="formula-item-lbl">Your reward power</div><div class="formula-item-val orange">Shares x Hold Multiplier</div></div>
          <div><div class="formula-item-lbl">Sell below ${escapeHtml(formatCount(minimumTokens))}</div><div class="formula-item-val red">Hold timer resets to 0</div></div>
          <div><div class="formula-item-lbl">Bigger bag means</div><div class="formula-item-val green">More shares = more wBTC</div></div>
        </div>
        <div class="tier-notes">
          <div class="tier-note"><h4>What counts as a share</h4><p>Every full ${escapeHtml(formatCount(minimumTokens))} BTCBANK equals one base share. If a wallet holds 900,000 BTCBANK, that wallet has three base shares before the hold bonus is applied.</p></div>
          <div class="tier-note"><h4>What actually grows the payout</h4><p>Two things matter: bag size and hold time. Bigger bags create more shares. Longer holds raise the multiplier. BTCBANK is designed to punish panic-selling and reward the people who let the timer live.</p></div>
        </div>
      </div>
      <div class="checker-card sticky">
        <span class="checker-anchor" id="checker"></span>
        <div class="section-label" style="margin-bottom:8px">Wallet Checker</div>
        <h3>Check Your Tier Before You Jeet</h3>
        <p>Paste a wallet and see the real answer: how much BTCBANK it holds, whether it qualifies, how many full shares it has, how old the hold is, what multiplier it gets, and whether it is WBTC-ready right now.</p>
        <div class="checker-mini">
          <div class="checker-mini-card"><span>Reward line</span><strong>${escapeHtml(formatCount(minimumTokens))} BTCBANK</strong></div>
          <div class="checker-mini-card"><span>Max tier</span><strong>Satoshi at 30 days</strong></div>
        </div>
        <form id="walletCheckerForm" class="checker-form">
          <input id="walletInput" type="text" name="wallet" placeholder="Enter Solana wallet address" value="${escapeHtml(wallet ?? "")}" autocomplete="off" spellcheck="false" />
          <button class="btn-primary" type="submit">Check Wallet</button>
        </form>
        <div class="checker-helper">It will tell people the exact thing they want to know: am I qualified, what tier am I in, how much longer until the next multiplier, and did I accidentally reset myself?</div>
        <div id="checkerResult" style="margin-top:16px">${checkerHtml}</div>
      </div>
    </div>
  </div>
</section>

<section class="lb-section" id="leaderboard">
  <div class="container">
    <div class="section-label">Top Holders</div>
    <h2 class="section-title">Leaderboard</h2>
    <p class="section-desc">The wallets earning the most wBTC. Sorted by total rewards earned, balance, or multiplier tier.</p>
    <div class="lb-controls">
      <button class="lb-btn active" onclick="loadLeaderboard('rewards',this)">Top Rewards</button>
      <button class="lb-btn" onclick="loadLeaderboard('balance',this)">Top Balance</button>
      <button class="lb-btn" onclick="loadLeaderboard('multiplier',this)">Top Multiplier</button>
    </div>
    <div class="lb-table-wrap">
      <table class="lb-table">
        <thead><tr><th>#</th><th>Wallet</th><th>Tier</th><th>Balance</th><th>Multiplier</th><th>wBTC Earned</th><th>Rounds</th></tr></thead>
        <tbody id="lbBody">${renderInitialLeaderboardRows(topHolders)}</tbody>
      </table>
    </div>
    <div id="lbTotal" style="font-size:12px;color:var(--muted);margin-top:10px;text-align:right">${escapeHtml(formatCount(topHolders.length))} qualifying wallets shown</div>
  </div>
</section>

<section class="tx-section" id="txs">
  <div class="container">
    <div class="section-label">On-Chain Activity</div>
    <h2 class="section-title">Recent <span>Transactions</span></h2>
    <p class="section-desc">Every wBTC distribution, live from the blockchain. All payouts are permanent and verifiable on Solana.</p>
    <div class="tx-list" id="txList">
      <div class="tx-header"><span>Wallet</span><span>Round</span><span>wBTC</span><span>Tier</span><span>Time</span></div>
      ${renderInitialTxRows(initialTxs)}
      <button class="load-more" id="loadMoreBtn" onclick="loadMoreTxs()" style="display:${txs.length > 30 ? "block" : "none"}">Load more transactions ↓</button>
    </div>
  </div>
</section>

<section class="stats-section" id="stats">
  <div class="container">
    <div class="section-label">On-Chain, Right Now</div>
    <h2 class="section-title">Live <span>Stats</span></h2>
    <p class="section-desc">Real-time data from the distribution engine. Public numbers, live update cycle, and the current round snapshot in one place.</p>
    <div class="stats-panel">
      <div class="stats-hdr"><div class="stats-hdr-l"><div class="live-dot"></div>$BTCBANK Distribution Engine</div><div style="font-family:var(--mono);font-size:11px;color:var(--muted)">Updates every 30s</div></div>
      <div class="stats-grid">
        <div class="stat-cell"><div class="stat-cell-val"><span class="o">$</span><span id="s-paid">${escapeHtml(formatCount(allTimeUsd))}</span></div><div class="stat-cell-lbl">All-time USD paid</div></div>
        <div class="stat-cell"><div class="stat-cell-val"><span id="s-wbtc">${escapeHtml(formatWbtc(allTimeWbtc, 4))}</span> <span class="o">wBTC</span></div><div class="stat-cell-lbl">Total wBTC distributed</div></div>
        <div class="stat-cell"><div class="stat-cell-val"><span id="s-holders">${escapeHtml(formatCompactCount(holdersPaid))}</span></div><div class="stat-cell-lbl">Wallets paid ever</div></div>
        <div class="stat-cell"><div class="stat-cell-val" id="s-round">${escapeHtml(formatCount(currentRound))}</div><div class="stat-cell-lbl">Current round</div></div>
        <div class="stat-cell"><div class="stat-cell-val" id="s-qualified">${escapeHtml(formatCount(qualifiedThisRound))}</div><div class="stat-cell-lbl">Qualified this round</div></div>
        <div class="stat-cell"><div class="stat-cell-val"><span class="o" id="s-countdown">${Math.floor(nextCycleSeconds / 60)}</span>:<span id="s-countdown-s">${String(nextCycleSeconds % 60).padStart(2, "0")}</span></div><div class="stat-cell-lbl">Next cycle</div></div>
      </div>
      <div class="stats-ftr"><div class="live-dot"></div>Live · 21M supply · Backed 1:1 Bitcoin · Updated ${escapeHtml(timeAgo(updatedAt))}</div>
    </div>
  </div>
</section>

<section class="why-section" id="why">
  <div class="why-bg"></div>
  <div class="container">
    <div class="why-grid">
      <div>
        <div class="big-stmt">YOU ARE<br><span>EARLY.</span><br><span class="outline">AGAIN.</span></div>
        <p class="big-stmt-sub">Tiny market cap. Real on-chain proof. Live rounds. Public payouts. The market usually notices late and then rewrites patience as luck.</p>
        <div class="why-ctas">
          <a href="#buy" class="btn-primary">How to Buy</a>
          <a href="#checker" class="btn-secondary">Check Your Tier</a>
        </div>
      </div>
      <div class="why-points">
        <div class="why-point"><div class="why-line"></div><div><h4>Tiny marketcap. Massive runway.</h4><p>$BTCBANK has already paid real Bitcoin exposure to real wallets. The market cap still has room to catch up to what the system has already proven.</p></div></div>
        <div class="why-point"><div class="why-line"></div><div><h4>The chain proves it — not promises.</h4><p>Every completed round, every wallet paid, every wBTC distribution is public and permanent. This is not theory. It is a visible receipt.</p></div></div>
        <div class="why-point"><div class="why-line"></div><div><h4>Every cycle flows back to Bitcoin.</h4><p>Alt narratives rotate. Bitcoin remains the benchmark asset. $BTCBANK keeps routing the reward side back into the asset that gets respected when the dust settles.</p></div></div>
        <div class="why-point"><div class="why-line"></div><div><h4>Current round, current value.</h4><p>${escapeHtml(formatCount(currentRoundPaid))} wallets paid in the latest live round snapshot, with roughly ${escapeHtml(formatUsd(currentRoundValue, 2))} of value routed to holders.</p></div></div>
      </div>
    </div>
  </div>
</section>

<section style="background:var(--bg2);padding:clamp(60px,8vw,100px) clamp(16px,4vw,40px)" id="exchanges">
  <div class="container">
    <div class="section-label">Exchange Roadmap</div>
    <h2 class="section-title">Where You Can <span>Trade $BTCBANK</span></h2>
    <p class="section-desc">Already live on Solana DEXs. Centralized exchange listings are a growth path, but the proof starts on-chain.</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:40px">
      <div style="background:var(--bg3);border:1px solid rgba(34,197,94,0.3);border-radius:12px;padding:24px 20px;position:relative"><div style="position:absolute;top:12px;right:12px;background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.3);border-radius:4px;padding:2px 8px;font-size:10px;color:var(--green);font-weight:600;letter-spacing:1px">LIVE NOW</div><div style="font-size:28px;margin-bottom:12px">🌊</div><h3 style="font-size:15px;font-weight:600;color:#fff;margin-bottom:8px">pump.fun + Solana DEXs</h3><p style="font-size:13px;color:var(--muted);line-height:1.7">Buy $BTCBANK right now on pump.fun or swap instantly on Jupiter and Raydium. Always open, always on-chain.</p></div>
      <div style="background:var(--bg3);border:1px solid rgba(247,147,26,0.25);border-radius:12px;padding:24px 20px;position:relative"><div style="position:absolute;top:12px;right:12px;background:rgba(247,147,26,0.1);border:1px solid rgba(247,147,26,0.25);border-radius:4px;padding:2px 8px;font-size:10px;color:var(--btc);font-weight:600;letter-spacing:1px">IN PROGRESS</div><div style="font-size:28px;margin-bottom:12px">📊</div><h3 style="font-size:15px;font-weight:600;color:#fff;margin-bottom:8px">Tier 3 CEX Listings</h3><p style="font-size:13px;color:var(--muted);line-height:1.7">Community metrics, volume, and proof of utility are the foundation. We are building the part exchanges actually care about.</p></div>
      <div style="background:var(--bg3);border:1px solid rgba(247,147,26,0.25);border-radius:12px;padding:24px 20px;position:relative"><div style="position:absolute;top:12px;right:12px;background:rgba(247,147,26,0.1);border:1px solid rgba(247,147,26,0.25);border-radius:4px;padding:2px 8px;font-size:10px;color:var(--btc);font-weight:600;letter-spacing:1px">TARGETED</div><div style="font-size:28px;margin-bottom:12px">🔥</div><h3 style="font-size:15px;font-weight:600;color:#fff;margin-bottom:8px">Tier 2 — MEXC & BingX</h3><p style="font-size:13px;color:var(--muted);line-height:1.7">As the proof strengthens, the conversation gets easier. The system needs signal, not fake hype.</p></div>
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:24px 20px;position:relative;opacity:0.65"><div style="position:absolute;top:12px;right:12px;background:var(--bg);border:1px solid var(--border2);border-radius:4px;padding:2px 8px;font-size:10px;color:var(--muted);font-weight:600;letter-spacing:1px">FUTURE</div><div style="font-size:28px;margin-bottom:12px">🏆</div><h3 style="font-size:15px;font-weight:600;color:#fff;margin-bottom:8px">Tier 1 — KuCoin & Beyond</h3><p style="font-size:13px;color:var(--muted);line-height:1.7">The goal is simple: more proof, more community, more real distribution history, better exchange conversations.</p></div>
    </div>
  </div>
</section>

<section style="background:var(--bg);padding:clamp(60px,8vw,100px) clamp(16px,4vw,40px)" id="tangem">
  <div class="container">
    <div class="section-label">Official Partnership</div>
    <h2 class="section-title">The $BTCBANK <span>Bank Card</span></h2>
    <p class="section-desc">We've partnered with Tangem — the world's most secure NFC hardware wallet — to offer exclusive $BTCBANK branded cards to our community. Because if you're going to be a Bitcoin bank, you should have a card.</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:48px;align-items:start">
      <div>
        <div style="background:linear-gradient(135deg,rgba(247,147,26,0.12) 0%,rgba(247,147,26,0.03) 100%);border:1px solid rgba(247,147,26,0.3);border-radius:16px;padding:32px 28px;margin-bottom:16px">
          <div style="font-size:11px;color:var(--btc);text-transform:uppercase;letter-spacing:1.5px;font-weight:600;margin-bottom:16px">Standard Edition</div>
          <div style="font-family:var(--display);font-size:42px;color:#fff;line-height:1;margin-bottom:8px">350 <span style="color:var(--btc)">CARDS</span></div>
          <div style="font-size:14px;color:var(--muted);margin-bottom:20px;line-height:1.7">Classic $BTCBANK branded Tangem NFC hardware wallet cards. Self-custody, no seed phrase, tap-to-sign with your phone.</div>
        </div>
        <div style="background:linear-gradient(135deg,rgba(251,191,36,0.1) 0%,rgba(247,147,26,0.04) 100%);border:1px solid rgba(251,191,36,0.3);border-radius:16px;padding:32px 28px">
          <div style="font-size:11px;color:#fbbf24;text-transform:uppercase;letter-spacing:1.5px;font-weight:600;margin-bottom:16px">Limited Edition</div>
          <div style="font-family:var(--display);font-size:42px;color:#fff;line-height:1;margin-bottom:8px">1,000 <span style="color:#fbbf24">COLORED</span></div>
          <div style="font-size:14px;color:var(--muted);margin-bottom:20px;line-height:1.7">Special full-color edition cards. Limited run. Once they're gone, they're gone.</div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:16px">
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:24px"><h3 style="font-size:16px;font-weight:600;color:#fff;margin-bottom:12px">Why Tangem?</h3><p style="font-size:13px;color:var(--muted);line-height:1.8">No seed phrase. No USB cable. No screen. Just tap your card to your phone to sign transactions. This is what a real Bitcoin bank card looks like.</p></div>
        <div style="background:rgba(247,147,26,0.06);border:1px solid rgba(247,147,26,0.2);border-radius:10px;padding:18px 20px"><p style="font-size:13px;color:var(--text);line-height:1.7">The Tangem partnership is part of the $BTCBANK identity — this isn't just a token, it's a <strong style="color:var(--btc)">Bitcoin bank</strong>. A physical card that stores your Bitcoin and wBTC rewards fits the whole thesis.</p></div>
      </div>
    </div>
  </div>
</section>

<footer>
  <div class="footer-grid">
    <div class="footer-brand">
      <div style="display:flex;align-items:center;gap:8px"><div class="nav-coin">₿</div><div class="nav-name">BTC<span style="color:var(--btc)">BANK</span></div></div>
      <p>The only token that automatically routes creator-fee value into wrapped Bitcoin for holders. Stop jeeting. Stop selling. Hold enough and hold long enough.</p>
    </div>
    <div class="footer-col">
      <h4>Learn</h4>
      <ul>
        <li><a href="#problem">Fix wBTC display</a></li>
        <li><a href="#lore">Bitcoin history</a></li>
        <li><a href="/history">Bitcoin vs Memes</a></li>
        <li><a href="#wbtc">What is wBTC?</a></li>
      </ul>
    </div>
    <div class="footer-col">
      <h4>Earn & Buy</h4>
      <ul>
        <li><a href="#buy">How to buy</a></li>
        <li><a href="#tiers">Tier system</a></li>
        <li><a href="#checker">Wallet checker</a></li>
        <li><a href="#leaderboard">Leaderboard</a></li>
      </ul>
    </div>
  </div>
  <div class="footer-bottom"><span>$BTCBANK — Bitcoin Bank. Real Rewards.</span><span>21,000,000 supply · 1:1 Bitcoin backed</span></div>
  <div class="footer-disc">Not financial advice. $BTCBANK is a community token on Solana. All reward data is on-chain and publicly verifiable. Past distributions do not guarantee future performance. Crypto assets carry substantial risk. Do your own research.</div>
</footer>

<script>
const API_BASE = '';
let secs = ${nextCycleSeconds};
let lbSort = 'rewards';
let txOffset = 30;
const TX_PAGE = 30;

function toggleMobileNav(){document.getElementById('mobileNav').classList.toggle('open')}
function closeMobileNav(){document.getElementById('mobileNav').classList.remove('open')}

function setText(id,val){const el=document.getElementById(id);if(el)el.textContent=val}
function fmt(n,dec){const number=Number(n||0);return number.toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec});}
function fmtK(n){const number=Number(n||0);if(number>=1000000)return (number/1000000).toFixed(1)+'M';if(number>=1000)return Math.round(number/1000)+'K';return String(Math.round(number));}
function timeAgo(ts){const diff=Math.floor((Date.now()-Number(ts||Date.now()))/1000);if(diff<60)return diff+'s ago';if(diff<3600)return Math.floor(diff/60)+'m ago';if(diff<86400)return Math.floor(diff/3600)+'h ago';return Math.floor(diff/86400)+'d ago';}
function esc(str){return String(str==null?'':str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

function tickClock(){
  secs--; if(secs<0) secs=294;
  const m=Math.floor(secs/60), s=String(secs%60).padStart(2,'0');
  setText('s-countdown',m); setText('s-countdown-s',s);
}
setInterval(tickClock,1000);

async function fetchStats(){
  try{
    const r=await fetch(API_BASE+'/api/stats',{cache:'no-store'});
    const d=await r.json();
    if(!d.ok) return;
    const s=d.stats||{};
    setText('h-paid','$'+fmt(s.allTimeUsd,0));
    setText('h-holders',fmtK(s.holdersPaid));
    setText('h-wbtc',Number(s.allTimeWbtc||0).toFixed(4)+' wBTC');
    setText('h-rounds',fmt(s.roundsCompleted,0));
    setText('s-paid',fmt(s.allTimeUsd,0));
    setText('s-wbtc',Number(s.allTimeWbtc||0).toFixed(4));
    setText('s-holders',fmtK(s.holdersPaid));
    setText('s-round',fmt(s.currentRound,0));
    setText('s-qualified',fmt(s.qualifiedThisRound,0));
    setText('btcPriceNode','$'+fmt(s.btcPrice||0,0));
    setText('t-btc','$'+fmt(s.btcPrice||0,0));
    setText('t-paid','$'+fmt(s.allTimeUsd,0));
    setText('t-rounds',fmt(s.roundsCompleted,0));
    setText('t-wbtc',Number(s.allTimeWbtc||0).toFixed(5)+' wBTC');
    setText('t-holders',fmt(s.holdersPaid,0));
    if(Number.isFinite(Number(s.nextCycleSeconds))) secs = Number(s.nextCycleSeconds);
  }catch(e){console.warn('[stats]',e);}
}

async function loadLeaderboard(sort, btn){
  lbSort = sort;
  document.querySelectorAll('.lb-btn').forEach(function(node){ node.classList.remove('active'); });
  if(btn) btn.classList.add('active');
  const body=document.getElementById('lbBody');
  body.innerHTML='<tr><td colspan="7" class="lb-loading">Loading...</td></tr>';
  try{
    const r=await fetch(API_BASE+'/api/holders?sort='+encodeURIComponent(sort)+'&limit=50',{cache:'no-store'});
    const d=await r.json();
    if(!d.ok || !Array.isArray(d.holders) || !d.holders.length){
      body.innerHTML='<tr><td colspan="7" class="lb-empty">No holder data yet. Data populates as rounds complete.</td></tr>';
      return;
    }
    body.innerHTML=d.holders.map(function(h,i){
      const rankClass=i===0?'gold':i===1?'silver':i===2?'bronze':'';
      const satoshiClass=h.tier==='Satoshi'?'satoshi':'';
      return '<tr>'
        +'<td><span class="rank-num '+rankClass+'">'+(i+1)+'</span></td>'
        +'<td><span class="addr-cell">'+esc(h.shortAddress)+'</span></td>'
        +'<td><span class="tier-pill '+satoshiClass+'">'+esc(h.tierIcon)+' '+esc(h.tier)+'</span></td>'
        +'<td><span class="addr-cell">'+fmt(h.balance,0)+'</span></td>'
        +'<td><span class="mult-val">'+Number(h.multiplier||0).toFixed(2)+'x</span></td>'
        +'<td><span class="wbtc-val">'+Number(h.totalWbtcEarned||0).toFixed(8)+'</span></td>'
        +'<td><span style="font-family:var(--mono);font-size:11px;color:var(--muted)">'+fmt(h.roundsQualified||0,0)+'</span></td>'
        +'</tr>';
    }).join('');
    setText('lbTotal',fmt(d.total||0,0)+' total qualifying wallets');
  }catch(e){
    body.innerHTML='<tr><td colspan="7" class="lb-empty">Could not load leaderboard.</td></tr>';
  }
}

async function loadTxs(append){
  const list=document.getElementById('txList');
  const empty=document.getElementById('txEmpty');
  const btn=document.getElementById('loadMoreBtn');
  if(!append){
    txOffset = 0;
    list.querySelectorAll('.tx-row').forEach(function(node){ node.remove(); });
    if(empty){ empty.style.display='block'; empty.textContent='Loading transactions...'; }
  }
  try{
    const r=await fetch(API_BASE+'/api/txs?limit='+TX_PAGE+'&offset='+txOffset,{cache:'no-store'});
    const d=await r.json();
    if(!d.ok) throw new Error('bad txs');
    if(!Array.isArray(d.txs) || !d.txs.length){
      if(!append && empty){
        empty.style.display='block';
        empty.textContent='No transactions yet. Data populates as rounds complete.';
      }
      if(btn) btn.style.display='none';
      return;
    }
    if(empty) empty.style.display='none';
    const frag=document.createDocumentFragment();
    d.txs.forEach(function(tx){
      const row=document.createElement('div');
      row.className='tx-row';
      row.innerHTML='<span class="tx-addr">'+esc(tx.shortAddress||'—')+'</span>'
        +'<span class="tx-round">#'+fmt(tx.round||0,0)+'</span>'
        +'<span class="tx-wbtc">'+Number(tx.wbtcAmount||0).toFixed(8)+'</span>'
        +'<span><span class="tier-pill" style="font-size:10px">'+esc(tx.tier||'Holder')+'</span></span>'
        +'<span class="tx-time">'+esc(timeAgo(tx.timestamp))+'</span>';
      frag.appendChild(row);
    });
    list.insertBefore(frag, btn);
    txOffset += TX_PAGE;
    if(btn) btn.style.display = (d.total || 0) > txOffset ? 'block' : 'none';
  }catch(e){
    if(empty){ empty.style.display='block'; empty.textContent='Could not load transactions.'; }
  }
}

function loadMoreTxs(){ loadTxs(true); }

function renderCheckResult(result){
  const mount=document.getElementById('checkerResult');
  if(!mount) return;
  if(!result || !result.found){
    mount.innerHTML='<div class="checker-result checker-miss"><div class="checker-state">Wallet not found</div><div class="checker-message">'+esc((result && result.message) || 'Wallet not found in the current qualifying-holder snapshot.')+'</div></div>';
    return;
  }
  const readyText = result.hasWbtcAccount === null ? 'Live feed does not expose this yet' : (result.hasWbtcAccount ? 'Ready' : 'Needs one-time wBTC unlock');
  const payableText = result.payableNow === null ? 'Waiting on richer live feed' : (result.payableNow ? 'Yes' : 'Not yet');
  mount.innerHTML=''
    +'<div class="checker-result checker-hit">'
    +'<div class="checker-topline"><div><div class="checker-state">Wallet found</div><div class="checker-wallet">'+esc(result.wallet)+'</div></div><div class="checker-tier-pill">'+esc(result.holdTier)+'</div></div>'
    +'<div class="checker-metrics">'
    +'<div class="checker-metric"><span>Balance</span><strong>'+esc(result.balanceTokens)+' BTCBANK</strong></div>'
    +'<div class="checker-metric"><span>Qualified</span><strong>'+(result.qualifiesNow?'YES':'NO')+'</strong></div>'
    +'<div class="checker-metric"><span>Full shares</span><strong>'+esc(String(result.shareCount))+'</strong></div>'
    +'<div class="checker-metric"><span>Hold age</span><strong>'+esc(result.holdAge)+'</strong></div>'
    +'<div class="checker-metric"><span>Bonus</span><strong>'+esc(result.holdMultiplier)+'</strong></div>'
    +'<div class="checker-metric"><span>Reward power</span><strong>'+esc(result.rewardPower)+'</strong></div>'
    +'<div class="checker-metric"><span>WBTC ready</span><strong>'+esc(readyText)+'</strong></div>'
    +'<div class="checker-metric"><span>Payable now</span><strong>'+esc(payableText)+'</strong></div>'
    +'<div class="checker-metric"><span>Next tier</span><strong>'+esc(result.nextTier || 'Top tier')+'</strong></div>'
    +'<div class="checker-metric"><span>Next tier ETA</span><strong>'+esc(result.nextTierEta || 'Reached')+'</strong></div>'
    +'<div class="checker-metric"><span>Need to qualify</span><strong>'+esc(result.tokensNeeded)+' BTCBANK</strong></div>'
    +'<div class="checker-metric"><span>wBTC earned</span><strong>'+esc(result.totalWbtcEarned)+' WBTC</strong></div>'
    +'</div><div class="checker-message">'+esc(result.message)+'</div></div>';
}

async function checkWallet(wallet){
  const trimmed=(wallet||'').trim();
  if(!trimmed) return;
  try{
    const r=await fetch(API_BASE+'/api/check?wallet='+encodeURIComponent(trimmed),{cache:'no-store'});
    const d=await r.json();
    renderCheckResult(d);
    const nextUrl=new URL(window.location.href);
    nextUrl.searchParams.set('wallet',trimmed);
    nextUrl.hash='checker';
    history.replaceState(null,'',nextUrl.toString());
  }catch(e){
    renderCheckResult({ found:false, message:'Could not check this wallet right now.' });
  }
}

document.getElementById('walletCheckerForm').addEventListener('submit',function(event){
  event.preventDefault();
  checkWallet(document.getElementById('walletInput').value);
});

function connect(){
  const es = new EventSource(API_BASE + '/api/stream');
  es.onmessage = function(){
    fetchStats();
    loadLeaderboard(lbSort);
    loadTxs(false);
    const currentWallet = document.getElementById('walletInput').value.trim();
    if(currentWallet) checkWallet(currentWallet);
  };
  es.addEventListener('reconnect', function(){ es.close(); setTimeout(connect, 2000); });
  es.onerror = function(){ es.close(); setTimeout(connect, 5000); };
}

fetchStats();
loadLeaderboard('rewards');
loadTxs(false);
connect();
</script>
</body>
</html>`;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  const url = new URL(req.url || "/", "http://localhost");
  const wallet = url.searchParams.get("wallet") ?? "";

  let data = null;
  try {
    data = await getLivePayload();
  } catch {
    data = null;
  }

  res.statusCode = 200;
  res.end(renderSite(data, wallet));
}
