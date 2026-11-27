export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runUpgrade } = await import("./lib/upgrade");
    try {
      await runUpgrade();
    } catch (err) {
      console.error("[deployer] Upgrade step failed:", err instanceof Error ? err.message : "unknown error");
    }

    // The platform domain (Settings → Domain): load it, then put its Traefik route back
    const { reconcilePlatformDomain } = await import("./lib/platformDomain");
    await reconcilePlatformDomain();

    const { startWsServer } = await import("./lib/wsServer");
    startWsServer();

    const { startAgentHub } = await import("./lib/agent/hub");
    startAgentHub().catch((err) => console.error("[deployer] Agent hub failed to start:", err instanceof Error ? err.message : err));

    const { startWorker } = await import("./lib/jobs");
    startWorker();

    const { startBackupWorker } = await import("./lib/backup/worker");
    startBackupWorker();
    const { startScheduler } = await import("./lib/scheduler");
    startScheduler();
    const { startMonitor } = await import("./lib/monitor");
    startMonitor();
    const { startContainerMetrics } = await import("./lib/containerMetrics");
    startContainerMetrics();

    const { startUpdateChecker } = await import("./lib/updates");
    startUpdateChecker();
    // Reports a finished self-update and runs auto-update (Settings → Updates)
    const { startSelfUpdateWorker } = await import("./lib/selfUpdate");
    startSelfUpdateWorker();
    const { startUptimeChecker } = await import("./lib/uptime");
    startUptimeChecker();

    const { startBackgroundPolling, startHealthMonitorSchedule } = await import("./lib/backgroundPoller");
    startBackgroundPolling();
    startHealthMonitorSchedule();
  }
}
