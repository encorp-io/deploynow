/**
 * Background poller — runs inside the Next.js Node.js process.
 * Started via src/instrumentation.ts on server boot.
 * Polls Portainer + registries every N seconds (from Settings).
 */

let timer: ReturnType<typeof setInterval> | null = null;
let started = false;

export function startBackgroundPolling() {
  if (started) return;
  started = true;

  console.log("[deployer] Background poller starting...");

  // Initial run after 5s to allow DB to be ready
  setTimeout(() => runCycle(), 5000);
}

async function runCycle() {
  try {
    const { prisma } = await import("./prisma");
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
    });

    const intervalSecs = settings?.pollingInterval ?? 60;

    // Run the actual check
    const { syncServicesFromPortainer, checkForUpdates } = await import(
      "./polling"
    );

    if (settings?.portainerUrl && settings?.portainerApiKey) {
      await syncServicesFromPortainer();
      await checkForUpdates();
      console.log("[deployer] Poll cycle complete");
    }

    // Schedule next run (re-read interval each cycle so setting changes take effect)
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => runCycle(), intervalSecs * 1000);
  } catch (err) {
    console.error("[deployer] Poll cycle error:", err);
    // Retry after 60s on error
    timer = setTimeout(() => runCycle(), 60 * 1000);
  }
}
