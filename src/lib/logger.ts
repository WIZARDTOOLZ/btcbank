import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import chalk from "chalk";

type Level = "info" | "warn" | "error" | "success" | "debug";
type Tone = "brand" | "info" | "success" | "hold" | "error";
type CalloutKind = "settled" | "resumed" | "qualified" | "queued" | "live" | "hold";

const toneStyles: Record<Tone, (text: string) => string> = {
  brand: chalk.hex("#f59e0b"),
  info: chalk.hex("#69d4ff"),
  success: chalk.hex("#6de01f"),
  hold: chalk.hex("#ffd15a"),
  error: chalk.hex("#fca5a5"),
};

const calloutStyles: Record<CalloutKind, (text: string) => string> = {
  settled: chalk.bgHex("#6de01f").black.bold,
  resumed: chalk.bgHex("#69d4ff").black.bold,
  qualified: chalk.bgHex("#1d4ed8").white.bold,
  queued: chalk.bgHex("#ff8c00").black.bold,
  live: chalk.bgWhite.black.bold,
  hold: chalk.bgHex("#ffd15a").black.bold,
};

const BANNER_WIDTH = 72;
const BOX_MIN_WIDTH = 38;
const BOX_MAX_WIDTH = 68;
const BOX_LABEL_WIDTH = 16;
const SUMMARY_REPEAT_COOLDOWN_MS = 60_000;
const CALLOUT_REPEAT_COOLDOWN_MS = 30_000;
const SUPPRESSED_SUMMARY_TITLES = new Set([
  "Replay Queue",
  "Replay Round",
  "Swap Queue",
  "Round Complete",
  "Paid Summary",
]);

export class Logger {
  private readonly logPath: string;
  private readonly recentSummaryState = new Map<string, { signature: string; at: number }>();
  private readonly recentCalloutState = new Map<string, number>();

  public constructor(baseDir = "data/logs") {
    this.logPath = join(baseDir, "runtime.jsonl");
  }

  public async init(): Promise<void> {
    await mkdir(dirname(this.logPath), { recursive: true });
  }

  public banner(title: string, details: string[]): void {
    const line = "═".repeat(BANNER_WIDTH);
    console.log(chalk.hex("#8a5b14")(line));
    console.log(chalk.bgHex("#0b0907").hex("#fb923c").bold(`  ${title}`));
    for (const detail of details) {
      console.log(chalk.hex("#e7d7bf")(`  ${detail}`));
    }
    console.log(chalk.hex("#8a5b14")(line));
  }

  public info(message: string): void {
    this.print("info", chalk.hex("#69d4ff")("INFO"), message);
  }

  public warn(message: string): void {
    this.print("warn", chalk.hex("#ffd15a")("HOLD"), message);
  }

  public error(message: string): void {
    this.print("error", chalk.hex("#f87171")("ERROR"), message);
  }

  public success(message: string): void {
    this.print("success", chalk.hex("#6de01f")("OK"), message);
  }

  public debug(message: string): void {
    this.print("debug", chalk.hex("#c084fc")("DEBUG"), message);
  }

  public section(title: string): void {
    console.log(chalk.bold.hex("#fbbf24")(`\n[${title}]`));
    void this.persist("info", `[section] ${title}`, { kind: "section", title });
  }

  public kv(label: string, value: string): void {
    console.log(`${chalk.hex("#cdb88f")(label.padEnd(24))} ${chalk.whiteBright(value)}`);
    void this.persist("info", `${label}: ${value}`, { kind: "kv", label, value });
  }

  public accent(message: string): void {
    console.log(chalk.bgHex("#ff8c00").black.bold(` ${message} `));
    void this.persist("info", message, { kind: "accent" });
  }

  public ops(message: string): void {
    const timestamp = new Date().toLocaleTimeString("en-US", {
      hour12: false,
    });
    console.log(`${chalk.hex("#b7a17b")(timestamp)} ${chalk.hex("#d7c29a")("ops")} ${chalk.hex("#e7d7bf")(message)}`);
    void this.persist("info", message, { kind: "ops" });
  }

  public tx(label: string, signature: string): void {
    console.log(
      `${chalk.hex("#cdb88f")(label.padEnd(24))} ${chalk.hex("#69d4ff")(this.shorten(signature, 8, 8))} ${chalk.hex("#b7a17b")(signature)}`,
    );
    void this.persist("info", `${label}: ${signature}`, { kind: "tx", label, signature });
  }

  public callout(kind: CalloutKind, message: string): void {
    const repeatKey = `${kind}:${message}`;
    const now = Date.now();
    const previousAt = this.recentCalloutState.get(repeatKey);
    if (previousAt && now - previousAt < CALLOUT_REPEAT_COOLDOWN_MS) {
      return;
    }

    this.recentCalloutState.set(repeatKey, now);
    console.log(calloutStyles[kind](` ${message} `));
    void this.persist("info", message, { kind: "callout", calloutKind: kind });
  }

  public progress(label: string, current: number, total: number, detail?: string): void {
    const safeTotal = Math.max(total, 1);
    const width = 14;
    const filled = Math.max(0, Math.min(width, Math.round((current / safeTotal) * width)));
    const bar = `${"■".repeat(filled)}${"·".repeat(width - filled)}`;
    const prefix = `${label} ${current}/${total}`;
    const suffix = detail ? ` ${detail}` : "";
    console.log(
      `${chalk.hex("#cdb88f")(prefix.padEnd(20))} ${chalk.hex("#69d4ff")(bar)}${chalk.hex("#e7d7bf")(suffix)}`,
    );
    void this.persist("info", `${label} ${current}/${total}${detail ? ` ${detail}` : ""}`, {
      kind: "progress",
      label,
      current,
      total,
      detail: detail ?? null,
    });
  }

  public summaryBox(title: string, rows: Array<{ label: string; value: string }>, tone: Tone = "info"): void {
    const signature = JSON.stringify(rows);
    const repeatKey = `${title}:${tone}`;
    const previous = this.recentSummaryState.get(repeatKey);
    const now = Date.now();
    const suppressRepeats = SUPPRESSED_SUMMARY_TITLES.has(title);

    if (suppressRepeats && previous && previous.signature === signature && now - previous.at < SUMMARY_REPEAT_COOLDOWN_MS) {
      return;
    }

    this.recentSummaryState.set(repeatKey, { signature, at: now });

    const style = toneStyles[tone];
    const rawWidths = rows.map((row) => BOX_LABEL_WIDTH + 1 + this.stripAnsi(row.value).length + 4);
    const width = Math.min(
      BOX_MAX_WIDTH,
      Math.max(title.length + 4, ...rawWidths, BOX_MIN_WIDTH),
    );
    const top = `┌${"─".repeat(width - 2)}┐`;
    const bottom = `└${"─".repeat(width - 2)}┘`;
    console.log(style(top));
    console.log(style(this.padBoxLine(` ${title}`, width)));
    console.log(style(`├${"─".repeat(width - 2)}┤`));
    for (const row of rows) {
      const wrapped = this.wrapText(row.value, Math.max(12, width - 2 - BOX_LABEL_WIDTH - 1));
      wrapped.forEach((line, index) => {
        const label = index === 0 ? row.label.padEnd(BOX_LABEL_WIDTH) : "".padEnd(BOX_LABEL_WIDTH);
        const body = `${chalk.hex("#e7d7bf")(label)} ${chalk.whiteBright(line)}`;
        console.log(style("│") + this.padMixedBoxLine(body, width - 2) + style("│"));
      });
    }
    console.log(style(bottom));
    void this.persist("info", `[summary] ${title}`, {
      kind: "summary",
      title,
      tone,
      rows,
    });
  }

  public async persist(level: Level, message: string, context?: Record<string, unknown>): Promise<void> {
    const row = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message,
      ...context,
    });

    await appendFile(this.logPath, `${row}\n`, "utf8");
  }

  private print(level: Level, tag: string, message: string): void {
    const timestamp = new Date().toLocaleTimeString("en-US", {
      hour12: false,
    });
    console.log(`${chalk.hex("#b7a17b")(timestamp)} ${tag} ${chalk.whiteBright(message)}`);
    void this.persist(level, message);
  }

  private padBoxLine(text: string, width: number): string {
    const bodyWidth = width - 2;
    return `│${text.padEnd(bodyWidth)}│`;
  }

  private padMixedBoxLine(text: string, bodyWidth: number): string {
    const visibleLength = this.stripAnsi(text).length;
    return `${text}${" ".repeat(Math.max(0, bodyWidth - visibleLength))}`;
  }

  private stripAnsi(value: string): string {
    return value.replace(/\x1B\[[0-9;]*m/g, "");
  }

  private shorten(value: string, left: number, right: number): string {
    if (value.length <= left + right + 3) {
      return value;
    }
    return `${value.slice(0, left)}...${value.slice(-right)}`;
  }

  private wrapText(value: string, width: number): string[] {
    const clean = value.trim();
    if (clean.length <= width) {
      return [clean];
    }

    const words = clean.split(/\s+/);
    const lines: string[] = [];
    let current = "";

    for (const word of words) {
      if (!current) {
        current = word;
        continue;
      }

      if ((current + " " + word).length <= width) {
        current += ` ${word}`;
        continue;
      }

      lines.push(current);
      current = word;
    }

    if (current) {
      lines.push(current);
    }

    return lines;
  }
}
