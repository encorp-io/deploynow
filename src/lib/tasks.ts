/**
 * Scheduled tasks: a shell command on a cron schedule, run with exec in a
 * running container or in a one-off container.
 */
import type { ScheduledTask, TaskRun } from "@prisma/client";
import { prisma } from "./prisma";
import { dockerFor } from "./endpoints";
import { execIn, runHelper } from "./backup/helper";
import { BackupConfigError, nextRun } from "./backup/config";
import { notify } from "./notify";
import { audit } from "./audit";

export class TaskError extends BackupConfigError {}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._\-/:@]{0,254}$/i;
const MAX_LOG = 100_000;

export function validateTask(raw: Record<string, unknown>, existing?: ScheduledTask) {
  const name = String(raw.name ?? existing?.name ?? "").trim();
  if (!name || name.length > 80) throw new TaskError("Give the task a name");
  const schedule = String(raw.schedule ?? existing?.schedule ?? "").trim();
  nextRun(schedule);
  const mode = String(raw.mode ?? existing?.mode ?? "exec");
  if (mode !== "exec" && mode !== "run") throw new TaskError("Mode must be exec or run");
  const container = String(raw.container ?? existing?.container ?? "").trim();
  const image = String(raw.image ?? existing?.image ?? "").trim();
  if (mode === "exec" && !NAME_RE.test(container)) throw new TaskError("Name the container to run the command in");
  if (mode === "run" && !IMAGE_RE.test(image)) throw new TaskError("Give the image to run, e.g. alpine:3.20");
  const command = String(raw.command ?? existing?.command ?? "").trim();
  if (!command || command.length > 4000) throw new TaskError("Enter the command (up to 4000 characters)");
  const env = String(raw.env ?? existing?.env ?? "").trim();
  for (const line of env.split("\n").filter((l) => l.trim())) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(line.trim())) throw new TaskError(`Environment lines look like KEY=value (got "${line.slice(0, 40)}")`);
  }
  const timeoutSec = Number(raw.timeoutSec ?? existing?.timeoutSec ?? 3600);
  if (!Number.isInteger(timeoutSec) || timeoutSec < 5 || timeoutSec > 86400) throw new TaskError("Timeout must be 5 to 86400 seconds");
  const enabled = raw.enabled !== undefined ? Boolean(raw.enabled) : (existing?.enabled ?? true);
  return { name, schedule, mode, container: mode === "exec" ? container : "", image: mode === "run" ? image : "", command, env, timeoutSec, enabled };
}

const running = new Set<string>();

export function isTaskRunning(id: string) {
  return running.has(id);
}

/** Run a task now. Skips (returns null) if it's already running. */
export async function runTask(taskId: string, trigger = "schedule", actorEmail = ""): Promise<TaskRun | null> {
  if (running.has(taskId)) return null;
  running.add(taskId);
  try {
    const task = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: taskId }, include: { endpoint: true } });
    const run = await prisma.taskRun.create({ data: { taskId, trigger } });
    let log = "";
    const onLine = (l: string) => {
      log += l + "\n";
      if (log.length > MAX_LOG) log = "…\n" + log.slice(-MAX_LOG);
    };
    let exitCode = -1;
    let error = "";
    try {
      const docker = dockerFor(task.endpoint);
      const timeoutMs = task.timeoutSec * 1000;
      if (task.mode === "exec") {
        exitCode = (await execIn(docker, task.container, task.command, { onLine, timeoutMs })).code;
      } else {
        const env: Record<string, string> = {};
        for (const line of task.env.split("\n")) {
          const i = line.indexOf("=");
          if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1);
        }
        exitCode = (await runHelper(docker, { image: task.image, entrypoint: ["sh", "-c"], cmd: [task.command], env, timeoutMs, onLine, name: `deploynow-task-${run.id}`.slice(0, 60) })).code;
      }
      if (exitCode !== 0) error = `Exited with code ${exitCode}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      onLine(`Error: ${error}`);
    }
    const ok = !error;
    const finished = await prisma.taskRun.update({ where: { id: run.id }, data: { status: ok ? "success" : "failed", exitCode: exitCode >= 0 ? exitCode : null, log, finishedAt: new Date() } });
    await prisma.scheduledTask.update({ where: { id: taskId }, data: { lastRunAt: new Date(), lastStatus: ok ? "success" : "failed" } });
    // Keep the last 50 runs
    const old = await prisma.taskRun.findMany({ where: { taskId }, orderBy: { startedAt: "desc" }, skip: 50, select: { id: true } });
    if (old.length) await prisma.taskRun.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    if (!ok) {
      await notify({ event: "task.failure", ok: false, title: `Task ${task.name} on ${task.endpoint.name} failed`, text: error, fields: { Command: task.command.slice(0, 200) } });
    }
    if (trigger === "manual") {
      await audit({ actor: actorEmail ? { id: "", email: actorEmail } : null, action: "task.run", targetType: "task", targetId: taskId, endpointId: task.endpointId, outcome: ok ? "success" : "failure", message: `Ran task ${task.name}`, details: error });
    }
    return finished;
  } finally {
    running.delete(taskId);
  }
}
