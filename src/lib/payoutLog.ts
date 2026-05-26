import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { formatTokenAmount } from "./format.js";

export interface PayoutLogRecord {
  paidAt: string;
  roundId: string;
  owner: string;
  amountRaw: string;
  amountUi: string;
  rewardMint: string;
  txSignature: string;
  shareCount?: string;
  holdTierLabel?: string;
  holdMultiplierBps?: number;
  holderBalanceRaw?: string;
}

const CSV_HEADER = [
  "paid_at",
  "round_id",
  "owner",
  "amount_wbtc",
  "amount_raw",
  "reward_mint",
  "tx_signature",
  "share_count",
  "hold_tier",
  "hold_multiplier_bps",
  "holder_balance_raw",
].join(",");

export class PayoutLog {
  public constructor(
    private readonly jsonlPath = "data/logs/payouts.jsonl",
    private readonly csvPath = "data/logs/payouts.csv",
  ) {}

  public async init(): Promise<void> {
    await mkdir(dirname(this.jsonlPath), { recursive: true });
    try {
      await access(this.csvPath);
    } catch {
      await writeFile(this.csvPath, `${CSV_HEADER}\n`, "utf8");
    }
  }

  public async appendBatch(params: {
    roundId: string;
    rewardMint: string;
    rewardDecimals: number;
    txSignature: string;
    paidAt: string;
    recipients: Array<{
      owner: string;
      amountRaw: string;
      shareCount?: string;
      holdTierLabel?: string;
      holdMultiplierBps?: number;
      holderBalanceRaw?: string;
    }>;
  }): Promise<void> {
    if (params.recipients.length === 0) {
      return;
    }

    const jsonlRows: string[] = [];
    const csvRows: string[] = [];

    for (const recipient of params.recipients) {
      const amountUi = formatTokenAmount(BigInt(recipient.amountRaw), params.rewardDecimals, params.rewardDecimals);
      const record: PayoutLogRecord = {
        paidAt: params.paidAt,
        roundId: params.roundId,
        owner: recipient.owner,
        amountRaw: recipient.amountRaw,
        amountUi,
        rewardMint: params.rewardMint,
        txSignature: params.txSignature,
        shareCount: recipient.shareCount,
        holdTierLabel: recipient.holdTierLabel,
        holdMultiplierBps: recipient.holdMultiplierBps,
        holderBalanceRaw: recipient.holderBalanceRaw,
      };
      jsonlRows.push(JSON.stringify(record));
      csvRows.push([
        csvEscape(record.paidAt),
        csvEscape(record.roundId),
        csvEscape(record.owner),
        csvEscape(record.amountUi),
        csvEscape(record.amountRaw),
        csvEscape(record.rewardMint),
        csvEscape(record.txSignature),
        csvEscape(record.shareCount ?? ""),
        csvEscape(record.holdTierLabel ?? ""),
        csvEscape(record.holdMultiplierBps?.toString() ?? ""),
        csvEscape(record.holderBalanceRaw ?? ""),
      ].join(","));
    }

    await appendFile(this.jsonlPath, `${jsonlRows.join("\n")}\n`, "utf8");
    await appendFile(this.csvPath, `${csvRows.join("\n")}\n`, "utf8");
  }
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}
