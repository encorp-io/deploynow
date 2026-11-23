# Security policy

DeployNow controls Docker on every machine you connect to it, so a flaw in it can
mean root on those machines. We take reports seriously and answer quickly.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through
[GitHub's private vulnerability reporting](https://github.com/encorp-io/deploynow/security/advisories/new).

Include what you found, how to reproduce it, the version (`/api/health` or the
sidebar shows it) and what an attacker could do with it. You can expect:

- an acknowledgement within 3 working days,
- an assessment and a plan within 10 working days,
- a fix released as a patch version, with a GitHub security advisory crediting you
  (unless you'd rather not be named).

We ask that you give us a reasonable time to fix the issue before you publish it,
normally 90 days, and that you don't access other people's data or disrupt their
instances while testing. Good-faith research under these terms won't face legal
action from us.

## Supported versions

| Version | Security fixes |
|---|---|
| Latest minor release (2.x) | Yes |
| Older minor releases | Upgrade to the latest; fixes aren't backported |
| 1.x (Encorp Deployer) | No |

## What's in scope

- The DeployNow server and image (`ghcr.io/encorp-io/deploynow`)
- The agent (`ghcr.io/encorp-io/deploynow-agent`) and its mutual TLS
- The CLI in `cli/`, the API, the MCP endpoint and its OAuth server
- `install.sh`

Out of scope: the apps you deploy with DeployNow, third-party images, and issues
that need an admin or owner account to do something admins are meant to be able
to do (see below).

## The trust model, briefly

- **Docker access is root.** Admins, and operators with console access, can act as
  root on every endpoint they can reach. That is by design, as in Portainer and
  Dokploy. A way for a viewer or operator to go beyond their role is a vulnerability.
- **Who can push to a deployed repository can run code on the endpoint.** A
  compose file in Git can mount host paths or run privileged containers.
- **`AUTH_SECRET` protects everything stored.** It signs sessions and encrypts
  secrets, SSH keys, registry passwords, backup keys and the agent CA.
- Secrets are never sent back to the browser in full, and are masked in deploy logs.
- AI connections (MCP) are capped at the person's role, never get owner, and have
  no delete, secret-reveal, console or restore tools.

Hardening advice is in [docs/security.md](docs/security.md).
