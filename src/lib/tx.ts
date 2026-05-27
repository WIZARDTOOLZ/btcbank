import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const TX_STEP_TIMEOUT_MS = Number(process.env.TX_STEP_TIMEOUT_MS ?? "60000");

export interface SentTransaction {
  signature: string;
  feeLamports: bigint;
}

export async function sendInstructions(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
  priorityFeeMicroLamports: number,
  computeUnitLimit = 400_000,
  fetchFeeDetails = true,
): Promise<SentTransaction> {
  const latestBlockhash = await withTimeout(
    "fetch latest blockhash",
    connection.getLatestBlockhash("confirmed"),
  );

  const finalInstructions = [
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFeeMicroLamports,
    }),
    ComputeBudgetProgram.setComputeUnitLimit({
      units: computeUnitLimit,
    }),
    ...instructions,
  ];

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: finalInstructions,
  }).compileToV0Message();
  const estimatedFee = await withTimeout(
    "estimate transaction fee",
    connection.getFeeForMessage(message, "confirmed"),
  );

  const transaction = new VersionedTransaction(message);
  transaction.sign([payer]);

  const signature = await withTimeout(
    "send transaction",
    connection.sendTransaction(transaction, {
      skipPreflight: false,
      maxRetries: 5,
    }),
  );

  const confirmation = await withTimeout(
    "confirm transaction",
    connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed",
    ),
  );

  if (confirmation.value.err) {
    throw new Error(`Transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  if (!fetchFeeDetails) {
    return {
      signature,
      feeLamports: BigInt(estimatedFee.value ?? 0),
    };
  }

  const transactionInfo = await withTimeout(
    "fetch confirmed transaction",
    connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }),
  );

  return {
    signature,
    feeLamports: BigInt(transactionInfo?.meta?.fee ?? 0),
  };
}

async function withTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Transaction step failed to ${label} within ${Math.floor(TX_STEP_TIMEOUT_MS / 1000)}s`));
        }, TX_STEP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
