/**
 * The updater: runs in a short-lived container ("deploynow-updater") that
 * DeployNow starts from its own image, so it keeps running while DeployNow's
 * container is replaced. Compiled to plain CommonJS at image build time
 * (npm run build:updater) and started as `node /app/updater/selfUpdate/runner.js`.
 *
 *   1. stop the DeployNow container, keeping it renamed as <name>-old-<time>
 *   2. copy the SQLite database while nothing has it open
 *   3. create and start the new container with the same configuration
 *   4. wait for its health check
 *   5. healthy: remove the old container (and move DEPLOYNOW_TAG in the compose .env)
 *      otherwise: remove the new one, put the database copy back, start the old one
 *
 * Progress and the outcome go to <data>/self-update/status.json, which the
 * DeployNow instance that comes up afterwards reads, logs and notifies about.
 */
import fs from "fs";
import path from "path";
import Docker from "dockerode";
import { RollbackError, stagedRecreate } from "../docker/recreate";
import {
  chownLike,
  demuxLogs,
  readStatus,
  restoreDb,
  setEnvValue,
  snapshotDb,
  waitHealthy,
  writeStatus,
  type SelfUpdatePlan,
  type SelfUpdateStatus,
} from "./shared";

const log = (m: string) => console.log(`[deploynow-updater] ${m}`);

async function main() {
  const plan = JSON.parse(
    process.env.SELF_UPDATE_PLAN || "{}",
  ) as SelfUpdatePlan;
  if (!plan.selfId || !plan.targetRef || !plan.statusFile)
    throw new Error("SELF_UPDATE_PLAN is missing or incomplete");
  const docker = new Docker({
    socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
  });

  const base: SelfUpdateStatus = readStatus(plan.statusFile) ?? {
    id: plan.id,
    state: "starting",
    fromVersion: "",
    fromImage: "",
    targetRef: plan.targetRef,
    targetVersion: "",
    startedAt: new Date().toISOString(),
  };
  let status: SelfUpdateStatus = { ...base, id: plan.id };
  const save = (patch: Partial<SelfUpdateStatus>) => {
    status = { ...status, ...patch };
    try {
      writeStatus(plan.statusFile, status);
    } catch (err) {
      log(`Couldn't write the status file: ${(err as Error).message}`);
    }
  };
  const finish = (
    state: SelfUpdateStatus["state"],
    message: string,
    extra: Partial<SelfUpdateStatus> = {},
  ) => {
    log(message);
    save({ state, message, finishedAt: new Date().toISOString(), ...extra });
  };

  // Let DeployNow finish answering the request that started this
  await new Promise((r) => setTimeout(r, plan.delayMs ?? 3000));

  // Start only the image DeployNow pulled and checked: if the tag was moved since, stop here
  if (plan.targetImageId) {
    let id = "";
    try {
      id = (await docker.getImage(plan.targetRef).inspect()).Id;
    } catch {
      /* gone */
    }
    if (id !== plan.targetImageId)
      return finish(
        "failed",
        `${plan.targetRef} no longer points at the image that was checked (${plan.targetImageId.slice(0, 19)}…), so nothing was changed.`,
      );
  }

  const snapDir = path.join(path.dirname(plan.statusFile), "pre-update-db");
  let snapshotted = false;
  save({ state: "replacing" });
  log(`Replacing ${plan.selfId.slice(0, 12)} with ${plan.targetRef}`);

  let staged;
  try {
    staged = await stagedRecreate(docker, plan.selfId, {
      image: plan.targetRef,
      afterStop: () => {
        if (!plan.dbFile || !fs.existsSync(plan.dbFile)) return;
        snapshotDb(plan.dbFile, snapDir);
        snapshotted = true;
        log("Database copied");
      },
    });
  } catch (err) {
    if (err instanceof RollbackError)
      return finish(
        "failed",
        `${err.message}. DeployNow is stopped: start it with docker compose up -d.`,
      );
    // stagedRecreate already put the old container back
    return finish(
      "failed",
      `Couldn't start the new container, so the old one runs again: ${(err as Error).message}`,
    );
  }

  save({ state: "checking" });
  log(
    `New container ${staged.newId.slice(0, 12)} started; waiting for its health check`,
  );
  const health = await waitHealthy(docker, staged.newId, {
    timeoutMs: plan.healthTimeoutMs || 300_000,
  });

  if (health.ok) {
    await staged.commit();
    let envFile = "";
    if (plan.envFile && plan.envTag) {
      try {
        const text = fs.readFileSync(plan.envFile, "utf8");
        const next = setEnvValue(text, "DEPLOYNOW_TAG", plan.envTag);
        if (next !== null && next !== text) {
          fs.writeFileSync(plan.envFile, next);
          envFile = plan.envFile;
          log(`DEPLOYNOW_TAG=${plan.envTag} written to the compose .env`);
        }
      } catch (err) {
        log(`Couldn't update the compose .env: ${(err as Error).message}`);
      }
    }
    fs.rmSync(snapDir, { recursive: true, force: true });
    return finish(
      "succeeded",
      `Updated to ${plan.targetRef}`,
      envFile ? { envFile: plan.envFileHost || envFile } : {},
    );
  }

  // Not healthy: keep what it printed, then go back
  let logs = "";
  try {
    const buf = (await docker
      .getContainer(staged.newId)
      .logs({ stdout: true, stderr: true, tail: 60 })) as unknown as Buffer;
    logs = demuxLogs(
      Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)),
    ).slice(-6000);
  } catch {
    /* gone already */
  }
  log(`${health.reason}; rolling back`);
  let restored = false;
  try {
    await staged.rollback(() => {
      if (!snapshotted || !plan.dbFile) return;
      try {
        restoreDb(plan.dbFile, snapDir);
        for (const s of ["", "-wal", "-shm"])
          if (fs.existsSync(plan.dbFile + s))
            chownLike(path.dirname(plan.dbFile), plan.dbFile + s);
        restored = true;
      } catch (err) {
        log(`Couldn't restore the database copy: ${(err as Error).message}`);
      }
    });
  } catch (err) {
    return finish(
      "failed",
      `${health.reason}, and starting the previous version again failed: ${(err as Error).message}. DeployNow is stopped: start it with docker compose up -d${snapshotted ? " (the database copy from before the update is in self-update/pre-update-db on the data volume)" : ""}.`,
      { logs },
    );
  }
  return finish(
    "rolled_back",
    `${health.reason}. The previous version runs again${restored ? " with the database as it was before the update" : ""}.`,
    { logs },
  );
}

main().catch((err) => {
  console.error(`[deploynow-updater] ${(err as Error).message}`);
  try {
    const plan = JSON.parse(
      process.env.SELF_UPDATE_PLAN || "{}",
    ) as SelfUpdatePlan;
    const s = plan.statusFile ? readStatus(plan.statusFile) : null;
    if (s && plan.statusFile)
      writeStatus(plan.statusFile, {
        ...s,
        state: "failed",
        message: `The updater stopped: ${(err as Error).message}`,
        finishedAt: new Date().toISOString(),
      });
  } catch {
    /* nothing more to do */
  }
  process.exitCode = 1;
});
