import { redisSetJson } from "./_kv.js";

const INGEST_SECRET = process.env.INGEST_SECRET ?? "";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return;
  }

  const secret = req.headers["x-btcbank-secret"] ?? "";
  if (!INGEST_SECRET || secret !== INGEST_SECRET) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return;
  }

  let body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    res.statusCode = 400;
    res.end("Bad Request");
    return;
  }

  const { stats, holders, txs } = body;
  if (!stats || !holders || !txs) {
    res.statusCode = 400;
    res.end("Missing stats, holders, or txs");
    return;
  }

  const payload = {
    stats,
    holders,
    txs,
    updatedAt: Date.now(),
  };

  await redisSetJson("btcbank:live", payload, 3600);

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true }));
}
