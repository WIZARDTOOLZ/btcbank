import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import localtunnel from "localtunnel";

const port = Number(process.env.OVERLAY_PORT ?? "3030");
const dashboardPath = "/dashboard";

function isWindows(): boolean {
  return process.platform === "win32";
}

function checkDashboardReady(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: dashboardPath,
        method: "GET",
        timeout: 2500,
      },
      (res) => {
        resolve((res.statusCode ?? 500) < 500);
        res.resume();
      },
    );

    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function waitForDashboard(maxAttempts = 25): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await checkDashboardReady()) {
      return true;
    }
    await sleep(1500);
  }
  return false;
}

function launchOverlay(): ChildProcess {
  const npmCommand = isWindows() ? "npm.cmd" : "npm";
  return spawn(npmCommand, ["run", "overlay"], {
    stdio: "inherit",
    shell: false,
    env: process.env,
  });
}

async function main(): Promise<void> {
  let overlayProcess: ChildProcess | null = null;
  let overlayStartedHere = false;

  if (!(await checkDashboardReady())) {
    console.log("[share] Dashboard is not running yet. Starting overlay server...");
    overlayProcess = launchOverlay();
    overlayStartedHere = true;
  }

  const ready = await waitForDashboard();
  if (!ready) {
    throw new Error(`Dashboard did not come online at http://127.0.0.1:${port}${dashboardPath}`);
  }

  const tunnel = await localtunnel({ port });
  const publicDashboardUrl = `${tunnel.url}${dashboardPath}`;

  console.log("");
  console.log("[share] Public dashboard is live:");
  console.log(`[share] ${publicDashboardUrl}`);
  console.log("");
  console.log("[share] Keep this window open to keep the public link alive.");

  const shutdown = async (): Promise<void> => {
    tunnel.close();
    if (overlayStartedHere && overlayProcess) {
      overlayProcess.kill();
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  await new Promise<void>(() => {});
}

main().catch((error) => {
  console.error("[share]", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
