import { getLivePayload, mapTransaction, safeInteger } from "./_shared.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    const url = new URL(req.url || "/", "http://localhost");
    const limit = Math.min(100, Math.max(1, safeInteger(url.searchParams.get("limit"), 30)));
    const offset = Math.max(0, safeInteger(url.searchParams.get("offset"), 0));
    const payload = await getLivePayload();
    const txs = (payload?.txs ?? [])
      .map(mapTransaction)
      .sort((a, b) => b.timestamp - a.timestamp);

    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: true,
      total: txs.length,
      txs: txs.slice(offset, offset + limit),
    }));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: error?.message ?? "txs_error", txs: [] }));
  }
}
