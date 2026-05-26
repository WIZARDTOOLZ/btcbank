import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { coinCreatorVaultAtaPda, coinCreatorVaultAuthorityPda } from "@pump-fun/pump-swap-sdk";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";

export class PumpService {
  private readonly sdk: OnlinePumpSdk;

  public constructor(sdk: OnlinePumpSdk) {
    this.sdk = sdk;
  }

  public async getClaimableLamports(creator: PublicKey): Promise<bigint> {
    const [pumpBalance, ammBalance] = await Promise.all([
      this.sdk.getCreatorVaultBalance(creator),
      this.getAmmCreatorVaultBalance(creator),
    ]);

    return bnToBigInt(pumpBalance.add(ammBalance));
  }

  public async buildClaimInstructions(creator: PublicKey): Promise<TransactionInstruction[]> {
    return await this.sdk.collectCoinCreatorFeeInstructions(creator);
  }

  private async getAmmCreatorVaultBalance(creator: PublicKey): Promise<BN> {
    const connection = (this.sdk as unknown as { connection: import("@solana/web3.js").Connection }).connection;
    const authority = coinCreatorVaultAuthorityPda(creator);
    const vaultAta = coinCreatorVaultAtaPda(authority, NATIVE_MINT, TOKEN_PROGRAM_ID);
    const balance = await connection.getTokenAccountBalance(vaultAta, "confirmed").catch(() => null);
    return new BN(balance?.value.amount ?? "0");
  }
}

function bnToBigInt(value: BN): bigint {
  return BigInt(value.toString(10));
}
