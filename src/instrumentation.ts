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

    const { startAgentHub } = await import("./lib/agent/hub");
    startAgentHub().catch((err) => console.error("[deployer] Agent hub failed to start:", err instanceof Error ? err.message : err));

    const { startWorker } = await import("./lib/jobs");
    startWorker();

    const { startBackgroundPolling, startHealthMonitorSchedule } = await import("./lib/backgroundPoller");
    startBackgroundPolling();
    startHealthMonitorSchedule();
  }
}
