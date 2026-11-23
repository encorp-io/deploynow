# Five-minute tour

A first run that shows what DeployNow does. It doubles as the script for a demo or a
screen recording: every step works on a fresh VM with a domain pointing at it.

You need: a Linux VM with a public IP, and a DNS name for it (for example
`*.demo.example.com` → the VM). Without a domain, skip step 4; the app is still
reachable on its port.

## 1. Install (1 minute)

```bash
curl -fsSL https://raw.githubusercontent.com/encorp-io/deploynow/main/install.sh | sudo ADMIN_EMAIL=you@example.com bash
```

Open the address it prints, sign in with the password it prints, and add a passkey or
2FA when asked. The machine you installed on is already the `local` endpoint.

## 2. Look around (30 seconds)

**Endpoints → local** lists the containers, images, volumes and networks on the
machine, with live CPU and memory. Open any container for logs and a console.

## 3. Deploy an app from an image (1 minute)

1. **Projects → New project** "demo". It comes with a `production` environment.
2. **New app** → *Image* → `traefik/whoami:latest`, port `80`.
3. **Deploy.** The deployment log streams; the app is up in a few seconds.

## 4. Give it a domain with SSL (1 minute)

1. **Endpoints → local → Edge proxy** → **Install Traefik**, with your email for Let's
   Encrypt. Ports 80 and 443 must be free.
2. On the app: **Domains → Add** `whoami.demo.example.com`, then deploy again.
3. Open `https://whoami.demo.example.com`: a valid certificate, issued automatically.

## 5. Deploy from Git (1 minute)

New app → *Dockerfile from Git* → any public repository with a `Dockerfile`, branch
`main`. Copy the webhook URL from the app into the repository's GitHub settings, and
every push deploys. Roll back to any earlier deployment from its row.

## 6. Secrets and backups (1 minute)

- **Environment:** add `API_KEY`, mark it *secret*. It is encrypted, never shown
  again, and appears as `***` in logs.
- **Backups → Destinations:** add a Cloudflare R2 or S3 bucket. **Policies:** back up
  the `demo` project every night, and run it now. Open the run for the snapshot,
  then **Restore drill** to prove it restores.

## 7. From your AI assistant (optional)

In Claude or ChatGPT, add a custom connector with `https://<your domain>/mcp`, approve
it in DeployNow, and ask "which of my apps are unhealthy?" or "redeploy whoami".
See [ai-connectors.md](ai-connectors.md).

## Cleaning up

Delete the `demo` project (its containers go with it; volumes are kept), and remove
the VM.
