import { getLivePayload, safeInteger, safeNumber } from "./_shared.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    const payload = await getLivePayload();
    const stats = payload?.stats ?? {};
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: true,
      stats: {
        allTimeUsd: safeNumber(stats.allTimeUsd, 0),
        allTimeWbtc: safeNumber(stats.allTimeWbtc, 0),
        holdersPaid: safeInteger(stats.holdersPaid, 0),
        roundsCompleted: safeInteger(stats.roundsCompleted, 0),
        currentRound: safeInteger(stats.currentRound, safeInteger(stats.roundsCompleted, 0)),
        qualifiedThisRound: safeInteger(stats.qualifiedThisRound, 0),
        nextCycleSeconds: safeInteger(stats.nextCycleSeconds, 294),
        btcPrice: safeNumber(stats.btcPrice, 0),
      },
    }));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: error?.message ?? "stats_error" }));
  }
}
