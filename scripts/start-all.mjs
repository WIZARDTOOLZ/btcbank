import { spawn } from "node:child_process";

const processes = [
  { name: "worker", command: "node", args: ["dist/index.js"], alreadyRunning: false },
  { name: "overlay", command: "node", args: ["dist/overlay.js"], alreadyRunning: false },
];

const children = processes.map((entry) => {
  const child = spawn(entry.command, entry.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
    shell: false,
  });

  const prefix = `[${entry.name}] `;
  const writeLines = (chunk, stream) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.length) {
        if (entry.name === "worker" && line.includes("Another payer worker is already running")) {
          entry.alreadyRunning = true;
        }
        stream.write(`${prefix}${line}\n`);
      }
    }
  };

  child.stdout.on("data", (chunk) => writeLines(chunk, process.stdout));
  child.stderr.on("data", (chunk) => writeLines(chunk, process.stderr));
  child.on("exit", (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    process.stderr.write(`${prefix}exited with ${reason}\n`);
    if (entry.name === "worker" && entry.alreadyRunning) {
      process.stderr.write("[start:all] Existing payout worker detected. Keeping overlay running.\n");
      return;
    }
    stopAll(child.pid);
  });

  return child;
});

function stopAll(skipPid = null) {
  for (const child of children) {
    if (child.pid && child.pid !== skipPid && !child.killed) {
      child.kill("SIGINT");
    }
  }
}

process.on("SIGINT", () => {
  stopAll();
  setTimeout(() => process.exit(0), 500);
});

process.on("SIGTERM", () => {
  stopAll();
  setTimeout(() => process.exit(0), 500);
});
