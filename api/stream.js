import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.statusCode = 200;

  let lastSentAt = 0;

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const tick = async () => {
    try {
      const payload = await kv.get("btcbank:live");
      if (payload && payload.updatedAt !== lastSentAt) {
        lastSentAt = payload.updatedAt;
        send(payload);
      }
    } catch {
      // non-fatal, just skip this tick
    }
  };

  // Send immediately on connect
  await tick();

  // Then poll every 5 seconds
  const interval = setInterval(tick, 5000);

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 20000);

  req.on("close", () => {
    clearInterval(interval);
    clearInterval(heartbeat);
  });

  // Vercel serverless functions time out after 30s on hobby plan.
  // Keep alive for 25s then let client reconnect.
  setTimeout(() => {
    clearInterval(interval);
    clearInterval(heartbeat);
    res.write("event: reconnect\ndata: {}\n\n");
    res.end();
  }, 25000);
}
