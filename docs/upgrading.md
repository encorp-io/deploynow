# Upgrading DeployNow

## Versions and image tags

DeployNow follows [semantic versioning](https://semver.org/). Patch releases (1.0.1)
fix bugs, minor releases (1.1.0) add features, and a major release (2.0.0) may need a
manual step, which the [changelog](../CHANGELOG.md) lists under **Upgrading**.

| Tag | Moves when | Use it for |
|---|---|---|
| `1.0.0` | never | Production: you choose when to upgrade |
| `1.0` | each 1.0.x patch | Production with automatic bug fixes |
| `latest` | each stable release | Trying DeployNow, small setups |
| `edge` | each commit on `main` | Testing what's next; may break |
| `sha-abc1234` | never | One exact build |

The agent image (`ghcr.io/encorp-io/deploynow-agent`) has the same tags. New join
commands use the agent of the server's own version.

## Upgrade

### From the UI

Settings → Updates → **Update now** (admins). DeployNow:

1. pulls the new image and checks it (nothing changes if either fails): the image's
   cosign signature must come from this repository's release workflow, for the git ref
   the tag stands for (`refs/tags/v1.1.0` for `1.1.0`, `main` for `edge`, any release
   tag for `latest`), and for a release, its digest must match the `image-digests.txt`
   attached to the GitHub release. From here on the update uses that exact image: the
   updater refuses to start if the tag points elsewhere by then;
2. starts a short-lived `deploynow-updater` container from its own image, with the
   Docker socket and DeployNow's data volume and no network. A container can't replace
   itself, because stopping it ends the process doing the work, so the updater does it;
3. the updater stops DeployNow (kept as `deploynow-old-<time>`), copies the database,
   and starts the new version with the same ports, volumes, environment, labels and
   restart policy;
4. it waits up to five minutes for the new container's health check. Healthy: the old
   container is removed. Not healthy, crashing or exited: the new container is removed,
   the database copy is put back and the old container starts again.

The page reconnects on its own and shows the outcome, with what the new version printed
when it failed. It is also in the audit log, and channels that subscribe to "DeployNow
updated itself (or rolled back)" get it.

Which image: a pinned tag (`1.0.0`) moves to the newest release, and when DeployNow was
started with Docker Compose, `DEPLOYNOW_TAG` in the project's `.env` is moved too, so a
later `docker compose up -d` keeps the new version. A tag that moves (`latest`, `1.0`,
`edge`) is pulled again. If your `docker-compose.yml` names a version itself instead of
`${DEPLOYNOW_TAG}`, change it there after updating.

**Update channel** (same page) picks what updates follow:

| Channel | Update now and auto-update move to |
|---|---|
| Stable | the newest release, pinned (`1.0.0`), even from `latest` or `edge` |
| Edge | the `edge` image, built from every commit on `main` |
| Keep the running tag (default) | the newest release for a pinned tag, the same tag again for `latest`, `2.0` or `edge` |

Switching channel moves `DEPLOYNOW_TAG` in the compose `.env` on the next update.

**Install updates automatically** (same page) does this on its own when a newer release
is out, or for `edge` and other moving tags when a new image is published. You can keep
it to one hour of the day (server time). A version that rolled back is not tried again
until the next one.

It needs `/var/run/docker.sock` mounted (the default compose file does) and `/data` on a
volume. `DEPLOYNOW_SELF_UPDATE=off` turns it off; the steps below always work.

The signature check runs cosign in a container (`ghcr.io/sigstore/cosign/cosign`, pinned
by digest) and needs to reach ghcr.io and Sigstore (`rekor.sigstore.dev`,
`tuf-repo-cdn.sigstore.dev`). `DEPLOYNOW_VERIFY_IMAGES=off` skips it, for example behind
a registry mirror. Images built elsewhere (a fork, your own registry) aren't checked
unless `DEPLOYNOW_IMAGE_SIGNER` gives the certificate identity to expect, as a regular
expression such as `^https://github.com/you/deploynow/`.

The updater ships with this version, so the upgrade *to* it is done by hand once.

### With the installer


```bash
curl -fsSL https://raw.githubusercontent.com/encorp-io/deploynow/main/setup.sh | sudo DEPLOYNOW_TAG=1.1.0 bash
```

### By hand

Next to your `docker-compose.yml`. To check the image first (optional, needs
[cosign](https://docs.sigstore.dev/cosign/system_config/installation/)):

```bash
cosign verify ghcr.io/encorp-io/deploynow:1.1.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity https://github.com/encorp-io/deploynow/.github/workflows/docker-publish.yml@refs/tags/v1.1.0
```

```bash
sed -i 's/^DEPLOYNOW_TAG=.*/DEPLOYNOW_TAG=1.1.0/' .env   # or edit it
docker compose pull && docker compose up -d
```

On start DeployNow:

1. copies the database to `/data/db-backups/deployer-<time>.db` if a migration is
   pending (the last five copies are kept);
2. applies the migrations in order;
3. starts, and reports healthy at `/api/health` with the new version.

Upgrade agents after the server. Update one with
`docker pull ghcr.io/encorp-io/deploynow-agent:1.1.0` and recreate its container
with the same command and volume.

## Rolling back

Going back to an older image after its migrations ran isn't supported, because the
older version doesn't know the newer columns. To undo an upgrade:

```bash
docker compose stop deployer
docker run --rm -v deploynow_deployer_data:/data alpine sh -c \
  'ls /data/db-backups && cp /data/db-backups/deployer-<time>.db /data/deployer.db && rm -f /data/deployer.db-wal /data/deployer.db-shm'
sed -i 's/^DEPLOYNOW_TAG=.*/DEPLOYNOW_TAG=1.0.0/' .env
docker compose up -d
```

The volume name is `<folder>_deployer_data`; `docker volume ls` shows it. Changes made
after the upgrade are lost.

## From DeployNow before versioned migrations

Builds of `main` from before 1.0.0 created the database with `prisma db push`. The
first start of 1.0.0 or later recognises such a database, backs it up, adds what is
missing without dropping anything, and marks it as migrated. Nothing to do by hand.

## From Encorp Deployer 1.x

See [Upgrading from v1](v2.md#upgrading-from-v1). In short: mount the Docker socket
with its group, pull the new image and recreate the container. Roles, the activity
log and tracked services carry over.
