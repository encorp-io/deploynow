# Backups

DeployNow backs up with [restic](https://restic.net) to S3-compatible storage. Data is encrypted and deduplicated on the machine before it is uploaded, so the storage provider only ever sees encrypted blobs.

## Setting up

1. **Create a bucket.** Cloudflare R2 is the default (no egress fees). AWS S3, Backblaze B2 and other S3 services also work.
   - R2: create a bucket and an R2 API token with "Object Read & Write" on that bucket. The endpoint is `https://<account id>.r2.cloudflarestorage.com`; you can paste just the account id.
   - Give DeployNow a key that can only reach that bucket.
2. **Add a destination** under Backups: provider, endpoint, bucket, an optional folder, and the access key. The secret key is encrypted in DeployNow's database and never shown again. "Test connection" checks that the bucket is reachable with those keys, without writing anything.
3. **Add a policy:** the endpoint, what to back up, a cron schedule (server time zone) and retention (daily, weekly, monthly snapshots to keep).

| Source | What is saved |
|---|---|
| Volume | The volume's files |
| Folder | A host folder (system folders such as `/etc` are refused) |
| Database | A dump made with the database's own tool inside its container: `pg_dumpall`/`pg_dump`, `mysqldump`/`mariadb-dump`, `mongodump`, or `redis-cli --rdb`. You can give your own dump command. |
| App | All volumes and recognised databases of a DeployNow app |
| DeployNow | DeployNow's own database and certificates |

Volume modes: **live** copies while the app runs, **stop** stops the containers using the volume for the copy and starts them again after, **dump** backs up only database dumps. You can also run a command in a container before and after each backup.

Each endpoint (and DeployNow itself) gets its own restic repository with its own random password, at `<bucket>/<folder>/<endpoint id>`.

## The recovery kit

When a repository is created, DeployNow offers its **recovery kit** once. It holds the repository URL, the restic password and the access key id, plus the commands to restore without DeployNow. Print it or put it in your password manager. The secret key is not in the kit; keep it with the kit.

Without the restic password the backups can't be read. If DeployNow's own database is lost, the kit is the only way back.

## Restoring

From the Backups page, pick a snapshot and restore it:
- to where it came from (the containers using a volume are stopped during the restore and started again);
- to a new volume or a host folder;
- for a database dump, into a running database container.

Restoring asks for a fresh 2FA code and is written to the audit log.

## Restore drills

A backup you haven't restored is a guess. Once a month, and whenever you press "Run drill", DeployNow restores the latest snapshot of each source into a scratch volume, checks that the expected number of files came back and that database dumps aren't empty (and that a DeployNow backup holds a valid SQLite database), then deletes the scratch copy. A failed drill raises an alert. `restic check` runs weekly, and retention is applied after backups.

## Restoring DeployNow itself

DeployNow can't restore its own database while it runs on it, so this is done by hand with the recovery kit, on any machine with restic 0.17 or later:

```bash
export RESTIC_REPOSITORY='s3:https://<account>.r2.cloudflarestorage.com/<bucket>/<folder>/instance'
export RESTIC_PASSWORD='<from the kit>'
export AWS_ACCESS_KEY_ID='<from the kit>'
export AWS_SECRET_ACCESS_KEY='<your secret key>'

restic snapshots --tag dn-source=instance
restic restore <snapshot id> --target ./restore
```

The snapshot holds `deployer.db`, `certs/` and a `RESTORE.txt`. Then:

1. Stop DeployNow: `docker compose stop deployer`.
2. Copy `deployer.db` and `certs/` into the `/data` volume, replacing what is there, and **delete `deployer.db-wal` and `deployer.db-shm`** if they exist (they belong to the old database).
3. Start it with the **same `AUTH_SECRET`** as before. Stored secrets, SSH keys and the backup passwords are encrypted with it, so a different one leaves them unreadable.

The same commands restore any other snapshot without DeployNow. Snapshots are tagged `dn-source=volume:<name>`, `bind:<path>`, `db:<container>` or `instance`. Database snapshots hold a single dump file (`dump.sql`, `dump.archive` or `dump.rdb`) to load with the database's own tool.

## Settings

| Variable | Default | |
|---|---|---|
| `RESTIC_IMAGE` | `restic/restic:0.18.1` | Image for the helper containers that run restic on each endpoint |
| `RESTIC_BIN` | `restic` | restic binary for DeployNow's own backups (included in the image) |
| `BACKUP_PARALLEL` | `2` | Backups run at the same time |
| `BACKUP_ALLOW_HTTP` | off | Allow `http://` endpoints, for testing only |
