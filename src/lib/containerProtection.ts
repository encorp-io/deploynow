/**
 * Containers that hold DeployNow's own secrets.
 *
 * DeployNow's container carries AUTH_SECRET and ADMIN_PASSWORD (anyone with
 * AUTH_SECRET can forge a session and decrypt every stored secret). The
 * updater carries the same environment, and backup, restore and task helpers
 * carry restic passwords, S3 keys and database credentials. Endpoint-level
 * permissions (container.env, container.exec, …) are not enough for these:
 * their env is never shown, nobody gets a console in them, only admins read
 * their logs and only owners may stop or remove them.
 *
 * Proxy and UI-route containers (deploynow.role) hold TLS keys: admin only.
 */
import { can, effectiveRole, normalizeRole, roleAtLeast, type Role, type Subject } from "./rbac";
import { prisma } from "./prisma";
import { isSelfContainer } from "./selfUpdate";
import { UPDATER_LABEL } from "./selfUpdate/shared";
import { HELPER_LABEL } from "./backup/helper";

export const SELF_LABEL = "io.deploynow.self";

export type ContainerKind = "deploynow" | "helper" | "platform" | "app" | "other";
export type ContainerAction = "env" | "exec" | "logs" | "control" | "remove";

/** Enough of a Docker inspect (or list) result to classify a container. */
export interface ContainerLike {
  Id: string;
  Config?: { Image?: string; Labels?: Record<string, string> | null } | null;
  Image?: string;
  Labels?: Record<string, string> | null;
}

// ghcr.io/encorp-io/deploynow:1.0.0, encorp-io/deploynow@sha256:…, the v1 name
const SELF_IMAGE_RE = /(^|\/)(encorp-io\/deploynow|deployer-for-portainer)(:|@|$)/i;

export function containerKind(c: ContainerLike): ContainerKind {
  const labels = c.Config?.Labels ?? c.Labels ?? {};
  const image = c.Config?.Image ?? c.Image ?? "";
  if (
    labels[SELF_LABEL] === "true" ||
    labels[UPDATER_LABEL] === "true" ||
    labels["deploynow.role"] === "updater" ||
    SELF_IMAGE_RE.test(image) ||
    (/^[0-9a-f]{12,64}$/.test(c.Id) && isSelfContainer(c.Id))
  ) {
    return "deploynow";
  }
  if (labels[HELPER_LABEL]) return "helper";
  if (labels["deploynow.role"]) return "platform";
  if (labels["deploynow.app"]) return "app";
  return "other";
}

/** Minimum role per action for protected kinds; null = nobody. Other kinds follow rbac.ts alone. */
const POLICY: Partial<Record<ContainerKind, Record<ContainerAction, Role | null>>> = {
  deploynow: { env: null, exec: null, logs: "admin", control: "owner", remove: "owner" },
  helper: { env: null, exec: null, logs: "admin", control: "owner", remove: "owner" },
  platform: { env: "admin", exec: "admin", logs: "operator", control: "admin", remove: "admin" },
};

/** Whether the protection rules allow this action. The caller still checks the rbac permission. */
export function protectionAllows(subject: Subject, endpointId: string, kind: ContainerKind, action: ContainerAction): boolean {
  const rule = POLICY[kind];
  if (!rule) return true;
  const min = rule[action];
  if (min === null) return false;
  return roleAtLeast(effectiveRole(subject, { endpointId }), min);
}

export function protectionMessage(kind: ContainerKind, action: ContainerAction): string {
  const what = kind === "deploynow" ? "DeployNow's own containers" : kind === "helper" ? "DeployNow's backup and task helpers" : "DeployNow's proxy containers";
  switch (action) {
    case "exec":
      return `Consoles are turned off for ${what}`;
    case "env":
      return `Environment values of ${what} are never shown`;
    case "logs":
      return `Only admins can read the logs of ${what}`;
    default:
      return `Only ${kind === "platform" ? "admins" : "owners"} can change ${what}`;
  }
}

/**
 * An app container's env holds that app's decrypted secrets: showing it needs
 * app.secrets on the app's project. A label pointing at a
 * deleted or unknown app may still carry its secrets: owners only.
 */
export async function appSecretsAllowed(subject: Subject, labels: Record<string, string> | null | undefined): Promise<boolean> {
  const appId = labels?.["deploynow.app"];
  if (!appId) return true;
  const app = await prisma.application
    .findUnique({ where: { id: appId }, select: { environment: { select: { projectId: true } } } })
    .catch(() => null);
  if (!app) return normalizeRole(subject.role) === "owner";
  return can(subject, "app.secrets", { projectId: app.environment.projectId });
}
