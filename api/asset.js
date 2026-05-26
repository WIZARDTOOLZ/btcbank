import { proxyFetch, sendSetupError } from "./_proxy.js";

export default async function handler(req, res) {
  try {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    const name = requestUrl.searchParams.get("name");

    if (name !== "ryan-on-stream.png") {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Unknown asset");
      return;
    }

    await proxyFetch(req, res, `/assets/${name}`);
  } catch (error) {
    sendSetupError(res, error instanceof Error ? error.message : String(error));
  }
}
