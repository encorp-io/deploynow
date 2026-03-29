/**
 * Background poller — runs inside the Next.js Node.js process.
 * Started via src/instrumentation.ts on server boot.
 */

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

export function startBackgroundPolling() {
  if (started) return;
  started = true;
  console.log("[deployer] Background poller starting...");
  // Initial run after 5s to allow DB to be ready
  timer = setTimeout(() => runCycle(), 5000);
}

async function runCycle() {
  try {
    const { prisma } = await import("./prisma");
    const settings   = await prisma.settings.findUnique({ where: { id: "singleton" } });
    const intervalSecs = settings?.pollingInterval ?? 60;

    if (settings?.portainerUrl && settings?.portainerApiKey) {
      const { syncServicesFromPortainer, checkForUpdates } = await import("./polling");
      await syncServicesFromPortainer();
      await checkForUpdates();
      console.log("[deployer] Poll cycle complete");
    }

    timer = setTimeout(() => runCycle(), intervalSecs * 1000);
  } catch (err) {
    // Log only the message, not the full error object — may contain credentials
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[deployer] Poll cycle error:", msg);
    timer = setTimeout(() => runCycle(), 60 * 1000);
  }
}
