import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  try {
    const payload = await kv.get("btcbank:live");
    if (!payload) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: "No data yet. Bot has not pushed any data." }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify(payload));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err?.message ?? "KV error" }));
  }
}
