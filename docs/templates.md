# One-click templates

**Projects → an environment → From template** creates a ready app from a list of
22 templates. Each one is an ordinary inline-compose app afterwards, so its compose
file, variables and domains can be changed like any other app.

| Category | Templates |
|---|---|
| Databases | PostgreSQL, MySQL, MariaDB, Redis, MongoDB |
| Automation | n8n |
| CMS | WordPress, Ghost, Directus |
| Analytics | Plausible, Umami, Metabase |
| Monitoring | Grafana, Uptime Kuma |
| Developer | Gitea, Adminer, pgAdmin, Mailpit, RabbitMQ, Meilisearch |
| Productivity and storage | NocoDB, Vaultwarden, Nextcloud |

## What a template sets up

- **Secrets.** Database passwords, encryption keys and similar values are generated
  (32 letters and digits, or random hex) and stored as encrypted secrets. A few
  values, such as an admin email or a time zone, are asked for in the form.
- **How to reach it.** Either a domain, routed through the endpoint's edge proxy with
  Let's Encrypt (the endpoint needs the proxy, and the domain's DNS must point at it),
  or a host port. Databases are only reachable inside the app unless you publish a port.
  Apps that need their own address (n8n, Ghost, Plausible…) get it filled in.
- **Backups.** When a backup destination exists, the form offers a nightly policy
  (03:00, keeping 7 daily, 4 weekly and 6 monthly copies). It dumps the database
  (`pg_dump`, `mysqldump`, `mongodump` or a Redis snapshot) and backs up the app's
  data volumes. A new restic repository shows its recovery kit once under **Backups**.
- **Deploy.** The app is deployed right away unless you untick it.

Some apps finish setting up in the browser (WordPress, Ghost, Gitea, n8n, Uptime
Kuma); the note after creating the app says what to do. Umami starts with the login
`admin` / `umami`: change it at once.

## API

`GET /api/templates` lists the templates. `POST /api/templates` creates an app:

```json
{
  "templateId": "n8n",
  "environmentId": "…",
  "name": "Automations",
  "domain": "n8n.example.com",
  "values": { "TZ": "Europe/Sofia" },
  "backupDestinationId": "…",
  "deploy": true
}
```

Use `hostPort` instead of `domain` to publish the web interface (or a database port)
on the host.

## Adding a template

Templates live in `src/lib/templates.ts`. A test renders every template, checks that
each `${VAR}` it uses is defined, that its backup sources are valid, and runs
`docker compose config` on it when Docker is available.
