import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getMint } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { config as loadEnv } from "dotenv";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

loadEnv();

const rpcUrls = (process.env.SOLANA_RPC_URLS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

if (!rpcUrls.length) {
  throw new Error("SOLANA_RPC_URLS is required");
}

const holderMint = new PublicKey(process.env.HOLDER_MINT);
const normalMinimumTokens = Number(process.env.HOLDER_MIN_TOKENS ?? "500000");
const grandfatherMinimumTokens = Number(process.env.GRANDFATHER_MIN_TOKENS ?? "300000");
const outputPath = process.env.GRANDFATHER_FILE_PATH || "data/grandfathered.json";
const publicOutputPath = process.env.PUBLIC_GRANDFATHER_FILE_PATH || "api/grandfathered.json";
const excludedOwners = new Set(
  [
    process.env.TREASURY_ADDRESS,
    process.env.WORKER_ADDRESS,
    ...(process.env.EXCLUDED_HOLDER_ADDRESSES ?? "").split(","),
  ]
    .map((entry) => entry?.trim())
    .filter(Boolean),
);

async function withRpc(fn) {
  let lastError;
  for (const rpcUrl of rpcUrls) {
    const connection = new Connection(rpcUrl, "confirmed");
    try {
      return await fn(connection);
    } catch (error) {
      lastError = error;
      console.warn(`[grandfather] RPC failed ${rpcUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw lastError ?? new Error("all RPCs failed");
}

async function getMintProgram(connection) {
  const account = await connection.getAccountInfo(holderMint, "confirmed");
  if (!account) {
    throw new Error(`Holder mint not found: ${holderMint.toBase58()}`);
  }
  return account.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

function tokenAccountFilters(tokenProgram) {
  if (tokenProgram.equals(TOKEN_PROGRAM_ID)) {
    return [
      { dataSize: 165 },
      { memcmp: { offset: 0, bytes: holderMint.toBase58() } },
    ];
  }

  return [
    { memcmp: { offset: 0, bytes: holderMint.toBase58() } },
  ];
}

const snapshot = await withRpc(async (connection) => {
  const tokenProgram = await getMintProgram(connection);
  const mint = await getMint(connection, holderMint, "confirmed", tokenProgram);
  const accounts = await connection.getParsedProgramAccounts(tokenProgram, {
    commitment: "confirmed",
    filters: tokenAccountFilters(tokenProgram),
  });
  const balances = new Map();

  for (const account of accounts) {
    const parsed = account.account.data;
    if (!("parsed" in parsed)) {
      continue;
    }

    const owner = parsed.parsed?.info?.owner;
    const amount = parsed.parsed?.info?.tokenAmount?.amount;
    if (!owner || !amount || excludedOwners.has(owner)) {
      continue;
    }

    const ownerKey = new PublicKey(owner);
    if (!PublicKey.isOnCurve(ownerKey.toBytes())) {
      continue;
    }

    balances.set(owner, (balances.get(owner) ?? 0n) + BigInt(amount));
  }

  const grandfatherRaw = BigInt(Math.floor(grandfatherMinimumTokens * 10 ** mint.decimals));
  const wallets = [...balances.entries()]
    .filter(([, rawBalance]) => rawBalance >= grandfatherRaw)
    .sort((left, right) => {
      if (left[1] === right[1]) {
        return left[0].localeCompare(right[0]);
      }
      return left[1] > right[1] ? -1 : 1;
    })
    .map(([owner, rawBalance]) => {
      const whole = rawBalance / 10n ** BigInt(mint.decimals);
      const fraction = rawBalance % 10n ** BigInt(mint.decimals);
      const paddedFraction = fraction.toString().padStart(mint.decimals, "0");
      return {
        owner,
        snapshotRawBalance: rawBalance.toString(),
        snapshotUiBalance: `${whole.toString()}.${paddedFraction}`,
      };
    });

  return {
    createdAt: new Date().toISOString(),
    holderMint: holderMint.toBase58(),
    normalMinimumTokens,
    grandfatherMinimumTokens,
    wallets,
  };
});

async function writeSnapshot(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

await writeSnapshot(outputPath);
await writeSnapshot(publicOutputPath);

console.log(`[grandfather] wrote ${snapshot.wallets.length} wallets >= ${grandfatherMinimumTokens.toLocaleString()} BTCBANK to ${outputPath} and ${publicOutputPath}`);
