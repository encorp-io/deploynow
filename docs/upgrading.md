# Upgrading DeployNow

## Versions and image tags

DeployNow follows [semantic versioning](https://semver.org/). Patch releases (2.0.1)
fix bugs, minor releases (2.1.0) add features, and a major release (3.0.0) may need a
manual step, which the [changelog](../CHANGELOG.md) lists under **Upgrading**.

| Tag | Moves when | Use it for |
|---|---|---|
| `2.0.0` | never | Production: you choose when to upgrade |
| `2.0` | each 2.0.x patch | Production with automatic bug fixes |
| `latest` | each stable release | Trying DeployNow, small setups |
| `edge` | each commit on `main` | Testing what's next; may break |
| `sha-abc1234` | never | One exact build |

The agent image (`ghcr.io/encorp-io/deploynow-agent`) has the same tags. New join
commands use the agent of the server's own version.

## Upgrade

With the installer:

```bash
curl -fsSL https://raw.githubusercontent.com/encorp-io/deploynow/main/install.sh | sudo DEPLOYNOW_TAG=2.1.0 bash
```

By hand, next to your `docker-compose.yml`:

```bash
sed -i 's/^DEPLOYNOW_TAG=.*/DEPLOYNOW_TAG=2.1.0/' .env   # or edit it
docker compose pull && docker compose up -d
```

On start DeployNow:

1. copies the database to `/data/db-backups/deployer-<time>.db` if a migration is
   pending (the last five copies are kept);
2. applies the migrations in order;
3. starts, and reports healthy at `/api/health` with the new version.

Upgrade agents after the server. Update one with
`docker pull ghcr.io/encorp-io/deploynow-agent:2.1.0` and recreate its container
with the same command and volume.

## Rolling back

Going back to an older image after its migrations ran isn't supported, because the
older version doesn't know the newer columns. To undo an upgrade:

```bash
docker compose stop deployer
docker run --rm -v deploynow_deployer_data:/data alpine sh -c \
  'ls /data/db-backups && cp /data/db-backups/deployer-<time>.db /data/deployer.db && rm -f /data/deployer.db-wal /data/deployer.db-shm'
sed -i 's/^DEPLOYNOW_TAG=.*/DEPLOYNOW_TAG=2.0.0/' .env
docker compose up -d
```

The volume name is `<folder>_deployer_data`; `docker volume ls` shows it. Changes made
after the upgrade are lost.

## From DeployNow before versioned migrations

Builds of `main` from before 2.0.0 created the database with `prisma db push`. The
first start of 2.0.0 or later recognises such a database, backs it up, adds what is
missing without dropping anything, and marks it as migrated. Nothing to do by hand.

## From Encorp Deployer 1.x

See [Upgrading from v1](v2.md#upgrading-from-v1). In short: mount the Docker socket
with its group, pull the new image and recreate the container. Roles, the activity
log and tracked services carry over.
