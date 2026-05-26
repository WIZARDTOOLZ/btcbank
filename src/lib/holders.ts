import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getMint,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
} from "@solana/web3.js";

export interface HolderSummary {
  tokenProgram: PublicKey;
  decimals: number;
  eligible: {
    owner: PublicKey;
    rawBalance: bigint;
    shareCount: bigint;
    isGrandfathered: boolean;
  }[];
  totalOwners: number;
  totalShares: bigint;
  grandfatheredEligibleCount: number;
}

export async function getHolderSummary(
  connection: Connection,
  mint: PublicKey,
  minimumUiTokens: number,
  excludedOwners: Set<string>,
  skipOffCurveOwners: boolean,
): Promise<HolderSummary> {
  const mintAccountInfo = await connection.getAccountInfo(mint, "confirmed");
  if (!mintAccountInfo) {
    throw new Error(`Mint account not found: ${mint.toBase58()}`);
  }

  const tokenProgram = mintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  const mintInfo = await getMint(connection, mint, "confirmed", tokenProgram);
  const minimumRawBalance = BigInt(Math.floor(minimumUiTokens * 10 ** mintInfo.decimals));

  const accounts = await connection.getParsedProgramAccounts(tokenProgram, {
    commitment: "confirmed",
    filters: tokenProgram.equals(TOKEN_PROGRAM_ID)
      ? [
          { dataSize: 165 },
          {
            memcmp: {
              offset: 0,
              bytes: mint.toBase58(),
            },
          },
        ]
      : [
          {
            memcmp: {
              offset: 0,
              bytes: mint.toBase58(),
            },
          },
        ],
  });

  const ownerBalances = new Map<string, bigint>();

  for (const account of accounts) {
    const parsed = account.account.data;
    if (!("parsed" in parsed)) {
      continue;
    }

    const info = parsed.parsed.info as {
      owner?: string;
      tokenAmount?: {
        amount?: string;
      };
    };

    const owner = info.owner;
    const amount = info.tokenAmount?.amount;

    if (!owner || !amount) {
      continue;
    }

    if (excludedOwners.has(owner)) {
      continue;
    }

    const ownerKey = new PublicKey(owner);
    if (skipOffCurveOwners && !PublicKey.isOnCurve(ownerKey.toBytes())) {
      continue;
    }

    const current = ownerBalances.get(owner) ?? 0n;
    ownerBalances.set(owner, current + BigInt(amount));
  }

  const eligible = [...ownerBalances.entries()]
    .map(([owner, rawBalance]) => {
      if (rawBalance < minimumRawBalance) {
        return null;
      }

      return {
        owner: new PublicKey(owner),
        rawBalance,
        shareCount: rawBalance / minimumRawBalance,
        isGrandfathered: false,
      };
    })
    .filter((holder): holder is {
      owner: PublicKey;
      rawBalance: bigint;
      shareCount: bigint;
      isGrandfathered: boolean;
    } => holder !== null)
    .sort((left, right) => {
      if (left.rawBalance === right.rawBalance) {
        return left.owner.toBase58().localeCompare(right.owner.toBase58());
      }
      return left.rawBalance > right.rawBalance ? -1 : 1;
    });

  const totalShares = eligible.reduce((total, holder) => total + holder.shareCount, 0n);
  const grandfatheredEligibleCount = eligible.filter((holder) => holder.isGrandfathered).length;

  return {
    tokenProgram,
    decimals: mintInfo.decimals,
    eligible,
    totalOwners: ownerBalances.size,
    totalShares,
    grandfatheredEligibleCount,
  };
}
