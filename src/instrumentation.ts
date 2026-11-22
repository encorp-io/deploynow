export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runUpgrade } = await import("./lib/upgrade");
    try {
      await runUpgrade();
    } catch (err) {
      console.error("[deployer] Upgrade step failed:", err instanceof Error ? err.message : "unknown error");
    }

    const { startWsServer } = await import("./lib/wsServer");
    startWsServer();

    const { startBackgroundPolling, startHealthMonitorSchedule } = await import("./lib/backgroundPoller");
    startBackgroundPolling();
    startHealthMonitorSchedule();
  }
}
