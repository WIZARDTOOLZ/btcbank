const BENIGN_PATTERNS = [
  "Error fetching token account TokenAccountNotFoundError",
  "ws error: Unexpected server response: 429",
  "Server responded with 429 Too Many Requests.",
];

function shouldSuppress(text: string): boolean {
  const normalized = text.trim();
  return BENIGN_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) {
        return `${arg.name}: ${arg.message}`;
      }
      return String(arg);
    })
    .join(" ");
}

export function installRuntimeNoiseFilter(): void {
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);

  console.error = (...args: unknown[]) => {
    if (shouldSuppress(stringifyArgs(args))) {
      return;
    }

    originalError(...args);
  };

  console.warn = (...args: unknown[]) => {
    if (shouldSuppress(stringifyArgs(args))) {
      return;
    }

    originalWarn(...args);
  };

  process.stderr.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (error?: Error | null) => void) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding ?? "utf8");
    if (shouldSuppress(text)) {
      if (cb) {
        cb();
      }
      return true;
    }

    return originalStderrWrite(chunk as never, encoding as never, cb as never);
  }) as typeof process.stderr.write;

  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (error?: Error | null) => void) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding ?? "utf8");
    if (shouldSuppress(text)) {
      if (cb) {
        cb();
      }
      return true;
    }

    return originalStdoutWrite(chunk as never, encoding as never, cb as never);
  }) as typeof process.stdout.write;
}
