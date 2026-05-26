const SITE_URL = (process.env.SITE_URL ?? "https://www.btcbank.help").replace(/\/+$/, "");
const HOLDER_MINT = process.env.HOLDER_MINT ?? "9s96G11xGsHczudfJqKQzQxzvubQgJXSySJ1wRgxpump";

function svg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#0a0a0a"/>
      <stop offset="100%" stop-color="#060606"/>
    </linearGradient>
    <linearGradient id="glow" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0%" stop-color="#f7931a" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#f7931a" stop-opacity="0.02"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="46" y="46" width="1108" height="538" rx="28" fill="none" stroke="#2f2417"/>
  <rect x="46" y="46" width="1108" height="538" rx="28" fill="url(#glow)"/>
  <text x="84" y="118" fill="#f7931a" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="700" letter-spacing="4">BITCOIN BANK</text>
  <text x="84" y="248" fill="#f5f0e8" font-family="Arial Black, Impact, sans-serif" font-size="116" font-weight="900">STOP JEETING.</text>
  <text x="84" y="354" fill="#f7931a" font-family="Arial Black, Impact, sans-serif" font-size="116" font-weight="900">STOP SELLING.</text>
  <text x="84" y="430" fill="#d0c7b8" font-family="Georgia, serif" font-size="34">Hold enough. Hold long enough. Earn wrapped Bitcoin.</text>
  <text x="84" y="484" fill="#8f8678" font-family="Consolas, monospace" font-size="22">Main site: ${SITE_URL.replace(/^https?:\/\//, "")}</text>
  <text x="84" y="516" fill="#8f8678" font-family="Consolas, monospace" font-size="18">CA: ${HOLDER_MINT.slice(0, 18)}...${HOLDER_MINT.slice(-10)}</text>
  <rect x="84" y="532" width="496" height="42" rx="21" fill="#111111" stroke="#3a3127"/>
  <text x="108" y="560" fill="#f7931a" font-family="Consolas, monospace" font-size="18">$BTCBANK | Listed on CoinGecko | CMC in process</text>
</svg>`;
}

export default function handler(req, res) {
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=600");
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.statusCode = 200;
  res.end(svg());
}
