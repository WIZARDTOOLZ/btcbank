import bs58 from "bs58";

function toUint8Array(values: unknown[]): Uint8Array {
  if (values.length === 0) {
    throw new Error("Private key array must not be empty");
  }

  const bytes = values.map((value) => {
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 255) {
      throw new Error("Private key array must contain bytes between 0 and 255");
    }
    return numeric;
  });

  return Uint8Array.from(bytes);
}

export function parsePrivateKey(raw: string): Uint8Array {
  const value = raw.trim();
  if (!value) {
    throw new Error("DEV_PRIVATE_KEY is empty");
  }

  if (value.startsWith("[")) {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("DEV_PRIVATE_KEY JSON must be an array of bytes");
    }
    return toUint8Array(parsed);
  }

  return bs58.decode(value);
}
