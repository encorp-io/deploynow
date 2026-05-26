export async function register() {
  // Only run in the Node.js runtime (not Edge), and only in production or when explicitly enabled
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startBackgroundPolling, startHealthMonitorSchedule } = await import("./lib/backgroundPoller");
    startBackgroundPolling();
    startHealthMonitorSchedule();
  }
}
