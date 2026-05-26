function getRedisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (!url || !token) {
    throw new Error("Missing Redis REST environment variables.");
  }
  return { url: url.replace(/\/+$/, ""), token };
}

async function redisCommand(command) {
  const { url, token } = getRedisConfig();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error ?? `Redis command failed with ${response.status}`);
  }
  if (body?.error) {
    throw new Error(body.error);
  }
  return body?.result;
}

export async function redisGetJson(key) {
  const result = await redisCommand(["GET", key]);
  if (result === null || result === undefined) {
    return null;
  }
  if (typeof result === "string") {
    return JSON.parse(result);
  }
  return result;
}

export async function redisSetJson(key, value, ttlSeconds) {
  const serialized = JSON.stringify(value);
  if (ttlSeconds) {
    await redisCommand(["SET", key, serialized, "EX", String(ttlSeconds)]);
    return;
  }
  await redisCommand(["SET", key, serialized]);
}
