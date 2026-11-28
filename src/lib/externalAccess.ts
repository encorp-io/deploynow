/** What a person may do with external containers on an endpoint (see externalContainers.ts). */
import { can, type Subject } from "./rbac";
import { canPlaceOn } from "./apps/placement";

export interface ExternalAllowed {
  logs: boolean;
  console: boolean;
  control: boolean;
  remove: boolean;
  /** Turning a stack into an app reads its env values and puts an app on the endpoint (the project's app.manage is checked on submit) */
  adopt: boolean;
}

export function externalAllowed(user: Subject, endpointId: string): ExternalAllowed {
  const scope = { endpointId };
  return {
    logs: can(user, "container.logs", scope),
    console: can(user, "container.exec", scope),
    control: can(user, "container.control", scope),
    remove: can(user, "container.remove", scope),
    adopt: can(user, "container.env", scope) && canPlaceOn(user, endpointId),
  };
}
