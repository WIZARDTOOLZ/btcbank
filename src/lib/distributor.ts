import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { config } from "../config.js";
import { sendInstructions } from "./tx.js";

export interface DistributionRecipient {
  owner: PublicKey;
  amountRaw: bigint;
}

export interface DistributionBatchResult {
  signature: string;
  deliveredOwners: string[];
  feeLamports: bigint;
  createdAtaCount: number;
  createdAtaRentLamports: bigint;
}

const mintDecimalsCache = new Map<string, number>();
const TOKEN_ACCOUNT_RENT_SPACE = 165;
const ATA_RENT_BUFFER_LAMPORTS = 500_000n;

export async function sendDistributionBatch(params: {
  connection: Connection;
  signer: Keypair;
  mint: PublicKey;
  tokenProgram: PublicKey;
  recipients: DistributionRecipient[];
  maxRecipientsPerTx: number;
  priorityFeeMicroLamports: number;
}): Promise<DistributionBatchResult> {
  const {
    connection,
    signer,
    mint,
    tokenProgram,
    recipients,
    maxRecipientsPerTx,
    priorityFeeMicroLamports,
  } = params;

  const mintCacheKey = `${mint.toBase58()}:${tokenProgram.toBase58()}`;
  let mintDecimals = mintDecimalsCache.get(mintCacheKey);
  if (mintDecimals === undefined) {
    const mintInfo = await getMint(connection, mint, "confirmed", tokenProgram);
    mintDecimals = mintInfo.decimals;
    mintDecimalsCache.set(mintCacheKey, mintDecimals);
  }
  const sourceAta = getAssociatedTokenAddressSync(mint, signer.publicKey, false, tokenProgram);
  const candidateRecipients = recipients.slice(0, Math.max(maxRecipientsPerTx * 4, maxRecipientsPerTx));
  const candidateTargets = candidateRecipients.map((recipient) => ({
    recipient,
    recipientAta: getAssociatedTokenAddressSync(
      mint,
      recipient.owner,
      true,
      tokenProgram,
    ),
  }));
  const recipientAtaInfos = await connection.getMultipleAccountsInfo(
    candidateTargets.map((target) => target.recipientAta),
    "confirmed",
  );
  const orderedTargets = candidateTargets
    .map((target, index) => ({
      ...target,
      ataExists: recipientAtaInfos[index] !== null,
      originalIndex: index,
    }))
    .sort((left, right) => {
      if (left.ataExists === right.ataExists) {
        return left.originalIndex - right.originalIndex;
      }
      return left.ataExists ? -1 : 1;
    })
    .slice(0, maxRecipientsPerTx);
  const payerBalanceLamports = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
  const ataRentLamports = BigInt(await connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_RENT_SPACE));
  const maxCreatableAtas = config.autoCreateRecipientAtas
    ? (ataRentLamports > 0n && payerBalanceLamports > ATA_RENT_BUFFER_LAMPORTS
        ? Number((payerBalanceLamports - ATA_RENT_BUFFER_LAMPORTS) / ataRentLamports)
        : 0)
    : 0;
  let creatableAtasUsed = 0;
  let createdAtaCount = 0;
  const instructions = [];
  const deliveredOwners: string[] = [];

  for (const target of orderedTargets) {
    const canCreateAta = target.ataExists || creatableAtasUsed < maxCreatableAtas;

    if (!canCreateAta) {
      continue;
    }

    if (!target.ataExists) {
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          signer.publicKey,
          target.recipientAta,
          target.recipient.owner,
          mint,
          tokenProgram,
        ),
      );
      creatableAtasUsed += 1;
      createdAtaCount += 1;
    }

    instructions.push(
      createTransferCheckedInstruction(
        sourceAta,
        mint,
        target.recipientAta,
        signer.publicKey,
        target.recipient.amountRaw,
        mintDecimals,
        [],
        tokenProgram,
      ),
    );
    deliveredOwners.push(target.recipient.owner.toBase58());
  }

  if (deliveredOwners.length === 0) {
    throw new Error(
      config.autoCreateRecipientAtas
        ? "Payout hold: the sender wallet needs a little more SOL for wallet setup"
        : "Payout hold: remaining wallets are still no-WBTC accounts",
    );
  }

  const sent = await sendInstructions(
    connection,
    signer,
    instructions,
    priorityFeeMicroLamports,
    1_200_000,
    false,
  );

  return {
    signature: sent.signature,
    deliveredOwners,
    feeLamports: sent.feeLamports,
    createdAtaCount,
    createdAtaRentLamports: ataRentLamports * BigInt(createdAtaCount),
  };
}
