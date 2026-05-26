import {
  buildWalletCheckResult,
  findHolderByWallet,
  getLivePayload,
  safeInteger,
} from "./_shared.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    const url = new URL(req.url || "/", "http://localhost");
    const wallet = (url.searchParams.get("wallet") ?? "").trim();
    if (!wallet) {
      res.statusCode = 400;
      res.end(JSON.stringify({ found: false, message: "Missing wallet parameter." }));
      return;
    }

    const payload = await getLivePayload();
    const stats = payload?.stats ?? {};
    const minimumTokens = safeInteger(stats.holderMinTokens ?? 300000, 300000);
    const holders = payload?.holders ?? [];
    const result = buildWalletCheckResult(findHolderByWallet(holders, wallet), wallet, minimumTokens);

    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ found: false, message: error?.message ?? "wallet_check_error" }));
  }
}
