/**
 * Background loops inside the Next.js Node.js process, started from
 * src/instrumentation.ts. (Phase 2 moves long work to a separate worker.)
 */

const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;

let started = false;
let healthStarted = false;

export function startBackgroundPolling() {
  if (started) return;
  started = true;
  console.log("[deployer] Background poller starting...");
  setTimeout(() => runCycle(), 5000);
}

export function startHealthMonitorSchedule() {
  if (healthStarted) return;
  healthStarted = true;
  console.log("[deployer] Health monitor starting (every 5 min)...");
  setTimeout(() => runHealthCycle(), 15_000);
}

async function runCycle() {
  let intervalSecs = 60;
  try {
    const { prisma } = await import("./prisma");
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
    intervalSecs = settings?.pollingInterval ?? 60;

    const { syncServices, checkForUpdates } = await import("./polling");
    await syncServices();
    await checkForUpdates();
    // Image, compose and Git apps with auto-update on
    const { runAutoUpdates } = await import("./apps/autoUpdate");
    await runAutoUpdates();
  } catch (err) {
    // Message only: the full error object may contain credentials
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[deployer] Poll cycle error:", msg);
  }
  setTimeout(() => runCycle(), intervalSecs * 1000);
}

async function runHealthCycle() {
  try {
    const { runHealthMonitor } = await import("./healthMonitor");
    await runHealthMonitor();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[health] Cycle error:", msg);
  }
  setTimeout(() => runHealthCycle(), HEALTH_CHECK_INTERVAL_MS);
}
