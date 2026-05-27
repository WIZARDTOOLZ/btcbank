import {
  getHolderMultiplier,
  getHolderTier,
  getHolderTokens,
  getLivePayload,
  mapLeaderboardHolder,
  resolveBtcPrice,
  safeInteger,
} from "./_shared.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    const url = new URL(req.url || "/", "http://localhost");
    const sort = (url.searchParams.get("sort") ?? "rewards").toLowerCase();
    const limit = Math.min(200, Math.max(1, safeInteger(url.searchParams.get("limit"), 50)));
    const payload = await getLivePayload();
    const stats = payload?.stats ?? {};
    const minimumTokens = Math.max(500000, safeInteger(stats.holderMinTokens ?? 500000, 500000));
    const btcPrice = resolveBtcPrice(stats);
    const holders = (payload?.holders ?? [])
      .map((holder) => mapLeaderboardHolder(holder, minimumTokens, btcPrice))
      .filter((holder) => holder.qualified);

    holders.sort((a, b) => {
      if (sort === "balance") {
        return b.balance - a.balance;
      }
      if (sort === "multiplier") {
        const tierDelta = getHolderTier({ holdTier: b.tier }, minimumTokens).multiplier - getHolderTier({ holdTier: a.tier }, minimumTokens).multiplier;
        if (tierDelta !== 0) {
          return tierDelta;
        }
        return b.balance - a.balance;
      }
      return b.totalWbtcEarned - a.totalWbtcEarned || b.balance - a.balance;
    });

    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: true,
      total: holders.length,
      holders: holders.slice(0, limit),
    }));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: error?.message ?? "holders_error", holders: [] }));
  }
}
