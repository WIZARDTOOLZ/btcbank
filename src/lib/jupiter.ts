import { PublicKey, VersionedTransaction } from "@solana/web3.js";

import { config } from "../config.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUPITER_API_BASES = [
  "https://api.jup.ag/swap/v1",
  "https://lite-api.jup.ag/swap/v1",
  "https://quote-api.jup.ag/v6",
] as const;
const JUPITER_HTTP_TIMEOUT_MS = 20_000;
const JUPITER_TX_TIMEOUT_MS = 45_000;
const JUPITER_SKIP_PREFLIGHT =
  (process.env.JUPITER_SKIP_PREFLIGHT ?? process.env.TX_SKIP_PREFLIGHT ?? "true").toLowerCase() !== "false";

export interface SwapResult {
  signature: string;
  quotedOutAmount: bigint;
  feeLamports: bigint;
}

export interface QuoteResult {
  outAmount: bigint;
}

interface SwapParams {
  connection: import("@solana/web3.js").Connection;
  signer: import("@solana/web3.js").Keypair;
  outputMint: PublicKey;
  lamportsIn: bigint;
  slippageBps: number;
}

export async function swapSolForToken({
  connection,
  signer,
  outputMint,
  lamportsIn,
  slippageBps,
}: SwapParams): Promise<SwapResult> {
  try {
    const { quoteResponse, swapTransaction } = await buildSwapWithFallback({
      outputMint,
      lamportsIn,
      slippageBps,
      userPublicKey: signer.publicKey.toBase58(),
    });
    const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    transaction.sign([signer]);

    const signature = await withTxTimeout(
      "send Jupiter swap",
      connection.sendTransaction(transaction, {
        skipPreflight: JUPITER_SKIP_PREFLIGHT,
        maxRetries: 3,
      }),
    );

    const confirmation = await withTxTimeout(
      "confirm Jupiter swap",
      connection.confirmTransaction(signature, "confirmed"),
    );

    if (confirmation.value.err) {
      throw new Error(formatJupiterSwapError(confirmation.value.err));
    }

    const transactionInfo = await withTxTimeout(
      "fetch Jupiter swap receipt",
      connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }),
    );

    return {
      signature,
      quotedOutAmount: BigInt(quoteResponse.outAmount),
      feeLamports: BigInt(transactionInfo?.meta?.fee ?? 0),
    };
  } catch (error) {
    throw new Error(formatJupiterSwapError(error));
  }
}

function formatJupiterSwapError(error: unknown): string {
  const encoded = normalizeErrorText(error);

  if (encoded.includes("\"custom\":6001") || encoded.includes("0x1771") || encoded.includes("slippagetoleranceexceeded")) {
    return "Swap held: market moved beyond slippage, will retry next cycle";
  }

  if (encoded.includes("\"custom\":6024") || encoded.includes("0x1788") || encoded.includes("insufficientfunds")) {
    return "Swap held: wallet balance was not enough for the route and fees";
  }

  if (encoded.includes("\"custom\":6017") || encoded.includes("0x1781") || encoded.includes("exactoutamountnotmatched")) {
    return "Swap held: route output no longer matched the quoted amount";
  }

  return `Swap held: Jupiter rejected the route, will retry next cycle`;
}

function normalizeErrorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.toLowerCase();
  }

  try {
    return JSON.stringify(error).toLowerCase();
  } catch {
    return String(error).toLowerCase();
  }
}

export async function quoteTokenToUsd(inputMint: PublicKey, amountRaw: bigint): Promise<number | null> {
  if (amountRaw <= 0n) {
    return 0;
  }

  try {
    const quoteResponse = await quoteWithFallback({
      inputMint: inputMint.toBase58(),
      outputMint: USDC_MINT,
      amount: amountRaw,
      slippageBps: 100,
    });
    return Number(BigInt(quoteResponse.outAmount)) / 1_000_000;
  } catch {
    return null;
  }
}

async function buildSwapWithFallback(params: {
  outputMint: PublicKey;
  lamportsIn: bigint;
  slippageBps: number;
  userPublicKey: string;
}): Promise<{ quoteResponse: { outAmount: string }; swapTransaction: string }> {
  let lastError: unknown;

  for (const baseUrl of JUPITER_API_BASES) {
    try {
      return await buildSwapWithBase(baseUrl, params);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`All Jupiter endpoints failed: ${String(lastError)}`);
}

async function quoteWithFallback(params: {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
}): Promise<{ outAmount: string }> {
  let lastError: unknown;

  for (const baseUrl of JUPITER_API_BASES) {
    try {
      return await buildQuoteWithBase(baseUrl, params);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`All Jupiter quote endpoints failed: ${String(lastError)}`);
}

async function buildSwapWithBase(
  baseUrl: string,
  params: {
    outputMint: PublicKey;
    lamportsIn: bigint;
    slippageBps: number;
    userPublicKey: string;
  },
): Promise<{ quoteResponse: { outAmount: string }; swapTransaction: string }> {
  const quoteUrl = new URL(`${baseUrl}/quote`);
  quoteUrl.searchParams.set("inputMint", SOL_MINT);
  quoteUrl.searchParams.set("outputMint", params.outputMint.toBase58());
  quoteUrl.searchParams.set("amount", params.lamportsIn.toString());
  quoteUrl.searchParams.set("slippageBps", params.slippageBps.toString());
  quoteUrl.searchParams.set("onlyDirectRoutes", "false");
  quoteUrl.searchParams.set("restrictIntermediateTokens", "true");

  const headers = buildHeaders();
  const quoteRes = await fetchWithTimeout(quoteUrl.toString(), { headers });
  if (!quoteRes.ok) {
    throw new Error(`Quote failed at ${baseUrl}: ${quoteRes.status} ${await quoteRes.text()}`);
  }

  const quoteResponse = (await quoteRes.json()) as { outAmount: string };

  const swapRes = await fetchWithTimeout(`${baseUrl}/swap`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: params.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });

  if (!swapRes.ok) {
    throw new Error(`Swap build failed at ${baseUrl}: ${swapRes.status} ${await swapRes.text()}`);
  }

  const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };
  return {
    quoteResponse,
    swapTransaction,
  };
}

async function buildQuoteWithBase(
  baseUrl: string,
  params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
  },
): Promise<{ outAmount: string }> {
  const quoteUrl = new URL(`${baseUrl}/quote`);
  quoteUrl.searchParams.set("inputMint", params.inputMint);
  quoteUrl.searchParams.set("outputMint", params.outputMint);
  quoteUrl.searchParams.set("amount", params.amount.toString());
  quoteUrl.searchParams.set("slippageBps", params.slippageBps.toString());
  quoteUrl.searchParams.set("onlyDirectRoutes", "false");
  quoteUrl.searchParams.set("restrictIntermediateTokens", "true");

  const headers = buildHeaders();
  const quoteRes = await fetchWithTimeout(quoteUrl.toString(), { headers });
  if (!quoteRes.ok) {
    throw new Error(`Quote failed at ${baseUrl}: ${quoteRes.status} ${await quoteRes.text()}`);
  }

  return (await quoteRes.json()) as { outAmount: string };
}

function buildHeaders(): Record<string, string> {
  if (!config.jupiterApiKey) {
    return {};
  }

  return {
    "x-api-key": config.jupiterApiKey,
  };
}

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JUPITER_HTTP_TIMEOUT_MS);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Jupiter request timed out after ${Math.floor(JUPITER_HTTP_TIMEOUT_MS / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function withTxTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.floor(JUPITER_TX_TIMEOUT_MS / 1000)}s`));
        }, JUPITER_TX_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
