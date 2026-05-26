import {
  buildWalletCheckResult,
  findHolderByWallet,
  getLivePayload,
  safeInteger,
} from "./_shared.js";
import { getMint, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

async function buildDirectWalletCheck(wallet, minimumTokens) {
  const rpcUrl = (process.env.SOLANA_RPC_URLS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)[0];
  const holderMintRaw = process.env.HOLDER_MINT?.trim();
  const rewardMintRaw = process.env.REWARD_MINT?.trim();

  if (!rpcUrl || !holderMintRaw || !rewardMintRaw) {
    return null;
  }

  const connection = new Connection(rpcUrl, "confirmed");
  const owner = new PublicKey(wallet);
  const holderMint = new PublicKey(holderMintRaw);
  const rewardMint = new PublicKey(rewardMintRaw);
  const holderMintAccount = await connection.getAccountInfo(holderMint, "confirmed");

  if (!holderMintAccount) {
    return null;
  }

  const holderTokenProgram = holderMintAccount.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
  const holderMintInfo = await getMint(connection, holderMint, "confirmed", holderTokenProgram);
  const holderAccounts = await connection.getParsedTokenAccountsByOwner(
    owner,
    { programId: holderTokenProgram },
    "confirmed",
  );

  let holderBalanceRaw = 0n;
  for (const account of holderAccounts.value) {
    const parsed = account.account.data?.parsed?.info;
    if (parsed?.mint !== holderMint.toBase58()) {
      continue;
    }
    holderBalanceRaw += BigInt(parsed?.tokenAmount?.amount ?? "0");
  }

  const minimumRaw = BigInt(Math.floor(minimumTokens * 10 ** holderMintInfo.decimals));
  const qualifiesNow = holderBalanceRaw >= minimumRaw;
  const shareCount = qualifiesNow && minimumRaw > 0n ? holderBalanceRaw / minimumRaw : 0n;

  const rewardMintAccount = await connection.getAccountInfo(rewardMint, "confirmed");
  let hasWbtcAccount = null;
  if (rewardMintAccount) {
    const rewardAta = getAssociatedTokenAddressSync(
      rewardMint,
      owner,
      true,
      rewardMintAccount.owner,
    );
    hasWbtcAccount = (await connection.getAccountInfo(rewardAta, "confirmed")) !== null;
  }

  const tokens = Number(holderBalanceRaw) / 10 ** holderMintInfo.decimals;
  const tokensNeeded = qualifiesNow ? 0 : Math.max(0, minimumTokens - tokens);

  return {
    found: true,
    wallet: owner.toBase58(),
    minimumTokens,
    balanceTokens: tokens.toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 6,
    }),
    balanceRaw: tokens,
    qualifiesNow,
    shareCount: Number(shareCount),
    holdAge: qualifiesNow ? "timer active after live sync" : "timer inactive",
    holdTier: qualifiesNow ? "Holder" : "below minimum",
    holdMultiplier: qualifiesNow ? "1.00x" : "0.00x",
    rewardPower: qualifiesNow ? Number(shareCount).toFixed(2) : "0.00",
    eligibleSince: null,
    nextTier: null,
    nextTierEta: null,
    tokensNeeded: tokensNeeded.toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 6,
    }),
    hasWbtcAccount,
    payableNow: hasWbtcAccount === null ? null : qualifiesNow && hasWbtcAccount,
    totalWbtcEarned: "0.00000000",
    message: qualifiesNow
      ? "This wallet qualifies on-chain right now. Hold-time bonus details appear once the live tracker syncs it."
      : `This wallet is below the ${minimumTokens.toLocaleString("en-US")} BTCBANK reward line right now.`,
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    const url = new URL(req.url || "/", "http://localhost");
    const wallet = (url.searchParams.get("wallet") ?? "").trim();
    if (!wallet) {
      res.statusCode = 400;
      res.end(JSON.stringify({ found: false, message: "Missing wallet parameter." }));
      return;
    }

    const payload = await getLivePayload();
    const stats = payload?.stats ?? {};
    const minimumTokens = safeInteger(stats.holderMinTokens ?? 300000, 300000);
    const holders = payload?.holders ?? [];
    let result = buildWalletCheckResult(findHolderByWallet(holders, wallet), wallet, minimumTokens);
    if (!result.found) {
      const directResult = await buildDirectWalletCheck(wallet, minimumTokens);
      if (directResult) {
        result = directResult;
      }
    }

    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ found: false, message: error?.message ?? "wallet_check_error" }));
  }
}
