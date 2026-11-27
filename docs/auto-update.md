# Auto-update for apps

Every app, whatever it is deployed from, can update itself: open the app, go to
**Settings → Auto-update** and turn on *Update this app automatically*.

| App source | What is checked |
|---|---|
| Image | A new digest for the image tag (a new `:latest`, `:16`, ...) |
| Compose file (pasted) | A new digest for any image in the compose file |
| Dockerfile from Git | A new commit on the tracked branch |
| Compose from Git | A new commit on the branch, and new digests for the compose file's images |

Services with a `build:` section and images pinned to a digest (`image@sha256:...`) are
left alone. Images written as `${VAR}` are resolved with the app's environment variables.
Image digests are looked up on GHCR, Docker Hub and any other registry that speaks the
Docker Registry v2 API (Quay, lscr.io, GitLab, a self-hosted registry), with the same
registry login the deployment pulls with. Commits are read with `git ls-remote`, using the
GitHub token from Settings for private repositories.

When something new is found, DeployNow deploys it through the normal pipeline: the
deployment shows up in the Deployments tab with the trigger `auto-update`, with the full log.

## Settings

- **Check**: every minute up to once a day (default every 15 minutes).
- **Maintenance window** (optional): the days and the hours updates may be installed in,
  for example Mon to Fri, 02:00 to 04:00. A window such as 22:00 to 04:00 runs past
  midnight and belongs to the day it starts on. Updates found outside the window wait,
  and the app shows what is waiting; the check runs again as soon as the window opens.
- **Time zone** for the window, such as `Europe/Sofia`. Empty means the server's.
- **Roll back when an update fails or is unhealthy** (on by default).

## Health check and rollback

1. The deployment itself must succeed. Image and Dockerfile apps start the new container
   next to the old one and wait until it is healthy, so a failed start never replaces the
   running version. Compose apps run `docker compose up --wait`.
2. One minute after the deployment, the new containers must still be running (or have
   exited with code 0, like a migration job), must not be restarting, and must be healthy
   if they have a Docker health check.
3. If either step fails, DeployNow deploys the previous deployment again. For compose apps
   the rollback starts the exact images that ran before, pinned by digest, even though the
   tag now points to the new release.

An update that was tried once is not tried again, so a broken release isn't deployed and
rolled back every few minutes. As soon as something newer comes out (another commit or
digest), that is tried. **Retry update** on the card tries the same one again, and a manual
deploy always works.

## Notifications and audit log

Two notification events (Settings → Notifications): *App auto-updated* and *App auto-update
failed or rolled back*. Channels that already get deploy notifications get these too after
the upgrade. Every step is in the audit log: `app.auto_update` (started, installed, failed,
rolled back), `app.auto_update_available` (waiting for the window) and
`app.auto_update_check` (a check that failed, or a check started by hand).

## With GitHub webhooks

Push to deploy (the GitHub webhook) still works and is independent of auto-update: a push
deploys right away. Auto-update is the way to follow a branch without a webhook, for example
when DeployNow isn't reachable from GitHub, and it catches anything a webhook missed.

## API

The settings are fields of the app (`PATCH /api/apps/{id}`): `autoUpdate`, `autoUpdateEvery`
(minutes: 1, 5, 15, 30, 60, 360 or 1440), `autoUpdateDays` (0 = Sunday ... 6), `autoUpdateFrom`
and `autoUpdateTo` (`HH:MM`), `autoUpdateTimezone` and `autoUpdateRollback`.
`GET /api/apps/{id}/auto-update` returns the status and the recent automatic updates, and
`POST /api/apps/{id}/auto-update` with `{"action": "check"}` checks now (`"retry"` also forgets
the update that failed). The old `updatePolicy: "auto-digest"` is still accepted and turns
auto-update on.
