# Skills for AI coding agents

## deploynow-ready

[`deploynow-ready/SKILL.md`](deploynow-ready/SKILL.md) teaches Claude (and other agents that read skills) to make any repository deployable with DeployNow: a production `Dockerfile`, a GitHub Actions workflow that builds a multi-arch image to GHCR (and can trigger a DeployNow deploy), a DeployNow-friendly `docker-compose.yml`, `.env.example`, a health endpoint and a `DEPLOY.md`.

**Claude Code**, for all your projects:

```bash
mkdir -p ~/.claude/skills/deploynow-ready && curl -fsSL https://raw.githubusercontent.com/encorp-io/deploynow/main/skills/deploynow-ready/SKILL.md -o ~/.claude/skills/deploynow-ready/SKILL.md
```

Use `.claude/skills/` inside a repository instead to share it with everyone working on that repository. Then ask: *"Make this repo DeployNow-ready."*

**Claude apps** (claude.ai, desktop): download [deploynow-ready.zip](../site/downloads/deploynow-ready.zip) and upload it under Settings → Capabilities → Skills.

**Other agents** (Cursor, Codex, Copilot, Windsurf…): paste the contents of `SKILL.md` into your rules or instructions file (`AGENTS.md`, `.cursor/rules`, …), or paste the short prompt from the website.

When you change `SKILL.md`, rebuild the zip:

```bash
cd skills && rm -f ../site/downloads/deploynow-ready.zip && zip -r ../site/downloads/deploynow-ready.zip deploynow-ready
```
