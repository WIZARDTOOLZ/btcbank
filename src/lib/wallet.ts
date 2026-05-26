import { Keypair } from "@solana/web3.js";

import { parsePrivateKey } from "./privateKey.js";

export function loadKeypair(rawPrivateKey: string): Keypair {
  return Keypair.fromSecretKey(parsePrivateKey(rawPrivateKey));
}
