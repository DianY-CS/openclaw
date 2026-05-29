# OpenClaw Container Setup Summary

Date: 2026-05-15  
Host: Windows  
Repo: `C:\Users\chest\projects\openclaw`  
Shared workspace: `D:\OpenClawWorkspace`

## Goal

Run OpenClaw in Docker with:

- Telegram access to Claw.
- Local Ollama model as the default model: `qwen3.5:9b`.
- OpenAI Codex OAuth configured and checked at startup.
- A Windows shared folder mounted into the container and writable from both Windows and Claw.
- All important state surviving Windows restart, Docker restart, and container recreation.

## Final Architecture

OpenClaw now separates internal runtime state from the editable project workspace.

```text
/home/node/.openclaw
  -> Docker volume: openclaw_openclaw-state
  -> Stores OpenClaw config, Telegram pairing, OAuth profile metadata, plugin installs, logs, queues.

/home/node/.openclaw/agents/main/agent/codex-home
  -> Docker volume: openclaw_openclaw-codex-home
  -> Stores Codex app-server cache, Codex session state, internal Codex files.

/home/node/.openclaw/workspace
  -> Windows bind mount: D:\OpenClawWorkspace
  -> Shared programming workspace, editable from both Windows and Claw.

/home/node/.config/openclaw
  -> Windows bind mount: C:\Users\chest\.openclaw-auth-profile-secrets
  -> Stores auth profile secret key material.
```

This avoids Docker Desktop Windows bind-mount permission issues for OpenClaw internal files while keeping the coding workspace accessible from Windows.

## Persistent Storage

These are the important persistent locations:

```text
OpenClaw internal state/config:
  Docker volume: openclaw_openclaw-state

Codex cache/app-server state:
  Docker volume: openclaw_openclaw-codex-home

Shared code workspace:
  D:\OpenClawWorkspace

OAuth secret key directory:
  C:\Users\chest\.openclaw-auth-profile-secrets

Compose/env configuration:
  C:\Users\chest\projects\openclaw\docker-compose.yml
  C:\Users\chest\projects\openclaw\.env
```

The gateway uses:

```yaml
restart: unless-stopped
```

So it should restart automatically after Docker Desktop or Windows restarts, as long as Docker Desktop itself starts.

## Model Routing

The default model is now the local Ollama model:

```text
Default:  ollama/qwen3.5:9b
Fallback: openai/gpt-5.5
```

Current `models status` verification showed:

```text
Default       : ollama/qwen3.5:9b
Fallbacks (1) : openai/gpt-5.5
OAuth profile : openai-codex ok
```

Ollama is reached from inside the container through:

```text
http://host.docker.internal:11434
```

The configured Ollama model is:

```text
qwen3.5:9b
```

## OpenAI Codex Startup Check

The gateway now runs a startup check before launching OpenClaw.

The check verifies:

- The OpenClaw Codex plugin exists.
- The OpenAI Codex app-server binary exists.
- The OpenAI Codex OAuth profile exists.
- The OAuth profile is not expired, when an expiry is available.
- The Codex app-server can start briefly.

If the check passes, logs show:

```text
[startup/codex-check] OpenAI/Codex available; qwen remains default.
```

If the check fails, OpenClaw still starts and continues using qwen as the default model. It also sends a Telegram alert to the configured chat:

```text
OPENCLAW_STARTUP_ALERT_TELEGRAM_CHAT=8672163720
```

The alert does not stop the container.

## Telegram

Telegram is enabled through the `telegram` plugin.

The paired Telegram sender is:

```text
telegram:8672163720
```

The bot token is configured through `.env` as:

```text
TELEGRAM_BOT_TOKEN=...
```

The full token is intentionally not repeated here.

## Docker Compose Changes

The gateway and CLI both mount the same persistent volumes:

```yaml
volumes:
  - openclaw-state:/home/node/.openclaw
  - openclaw-codex-home:/home/node/.openclaw/agents/main/agent/codex-home
  - ${OPENCLAW_WORKSPACE_DIR:-${HOME:-/tmp}/.openclaw/workspace}:/home/node/.openclaw/workspace
  - ${OPENCLAW_AUTH_PROFILE_SECRET_DIR:-${HOME:-/tmp}/.openclaw-auth-profile-secrets}:/home/node/.config/openclaw
```

The state volume is marked external because it was created and seeded manually:

```yaml
volumes:
  openclaw-state:
    external: true
    name: openclaw_openclaw-state
  openclaw-codex-home:
```

## `.env` Settings

Important `.env` settings:

```text
OPENCLAW_CONFIG_DIR=C:/Users/chest/.openclaw-docker
OPENCLAW_WORKSPACE_DIR=D:/OpenClawWorkspace
OPENCLAW_AUTH_PROFILE_SECRET_DIR=C:/Users/chest/.openclaw-auth-profile-secrets
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_BRIDGE_PORT=18790
OPENCLAW_DISABLE_BONJOUR=1
OPENCLAW_TZ=America/New_York
OPENCLAW_STARTUP_ALERT_TELEGRAM_CHAT=8672163720
OLLAMA_API_KEY=ollama-local
TELEGRAM_BOT_TOKEN=...
```

Note: `OPENCLAW_CONFIG_DIR` now mainly preserves the old Windows state directory as a backup/source path. The live OpenClaw internal state is in the Docker volume `openclaw_openclaw-state`.

## What Was Fixed

### 1. Slow Windows bind-mount internal state

Problem:

OpenClaw and Codex were doing internal cache/config work under `/home/node/.openclaw`, which was originally backed by a Windows bind mount. This caused slow file operations and Linux permission issues.

Fix:

Move `/home/node/.openclaw` to the persistent Docker volume:

```text
openclaw_openclaw-state
```

### 2. Slow Codex cache and plugin clone work

Problem:

Codex created internal plugin/cache files under `codex-home`, originally also on a Windows bind mount.

Fix:

Move Codex home to:

```text
openclaw_openclaw-codex-home
```

### 3. Codex volume permission error

Problem:

The new Codex volume was initially created as `root:root`, but OpenClaw runs as `node:node`.

Symptom:

```text
Permission denied (os error 13)
codex app-server exited
```

Fix:

```powershell
docker compose exec -u root openclaw-gateway chown -R node:node /home/node/.openclaw/agents/main/agent/codex-home
```

### 4. `chmod /home/node/.openclaw` EPERM

Problem:

Linux `chmod` against a Windows bind-mounted `.openclaw` directory failed.

Symptom:

```text
EPERM: operation not permitted, chmod '/home/node/.openclaw'
```

Fix:

Move `/home/node/.openclaw` to the Linux Docker volume `openclaw_openclaw-state`.

### 5. Missing Codex plugin dependency after migration

Problem:

The initial state copy did not fully copy the npm dependency tree, so Codex failed with:

```text
Cannot find module 'zod'
```

Fix:

Copy the full npm tree into the new state volume and restart.

## Verification Commands

Run these from:

```powershell
cd C:\Users\chest\projects\openclaw
```

### Check gateway health

```powershell
docker compose ps openclaw-gateway
```

Expected:

```text
healthy
```

### Check model routing

```powershell
docker compose run --rm openclaw-cli models status
```

Expected:

```text
Default       : ollama/qwen3.5:9b
Fallbacks (1) : openai/gpt-5.5
OAuth profile : ok
```

### Check startup Codex probe

```powershell
docker compose logs --since=5m openclaw-gateway |
  Select-String -Pattern 'startup/codex-check|Permission denied|EPERM|codex app-server exited|codex failed|model fallback|ready' -CaseSensitive:$false
```

Healthy output should include:

```text
[startup/codex-check] OpenAI/Codex available; qwen remains default.
ready
```

Healthy output should not include:

```text
Permission denied
EPERM
codex app-server exited
codex failed
unexpected model fallback
```

### Check mounts

```powershell
docker inspect openclaw-openclaw-gateway-1 --format '{{json .Mounts}}'
```

Expected important mounts:

```text
openclaw_openclaw-state       -> /home/node/.openclaw
openclaw_openclaw-codex-home  -> /home/node/.openclaw/agents/main/agent/codex-home
D:\OpenClawWorkspace          -> /home/node/.openclaw/workspace
```

### Check permissions

```powershell
docker compose exec openclaw-gateway sh -lc 'ls -ld /home/node/.openclaw /home/node/.openclaw/agents/main/agent/codex-home /home/node/.openclaw/workspace; test -w /home/node/.openclaw && echo state-writable; test -w /home/node/.openclaw/agents/main/agent/codex-home && echo codex-home-writable; test -w /home/node/.openclaw/workspace && echo workspace-writable'
```

Expected:

```text
state-writable
codex-home-writable
workspace-writable
```

### Check Ollama from container

```powershell
docker compose exec openclaw-gateway node -e "const t=Date.now(); fetch('http://host.docker.internal:11434/api/tags').then(async r=>{const s=await r.text(); console.log('ollama_tags status='+r.status+' ms='+(Date.now()-t)+' has_qwen='+s.includes('qwen3.5:9b'));}).catch(e=>{console.error(e.message); process.exit(1);});"
```

Expected:

```text
ollama_tags status=200 ... has_qwen=true
```

## Restart Behavior

The setup should survive:

- `docker compose restart openclaw-gateway`
- `docker compose up -d --force-recreate openclaw-gateway`
- Docker Desktop restart
- Windows restart, assuming Docker Desktop starts afterward

After restart, expected behavior:

1. Gateway starts.
2. Startup check probes OpenAI/Codex.
3. If Codex is available, log says so.
4. If Codex is unavailable, Telegram alert is sent.
5. OpenClaw continues using `ollama/qwen3.5:9b` as default.
6. Shared workspace remains `D:\OpenClawWorkspace`.

## Caveats

- If Docker Desktop volumes are deleted, OpenClaw internal state and Codex cache are lost.
- If `D:\OpenClawWorkspace` is missing or D: is unavailable, the shared workspace mount may fail.
- If the OpenAI OAuth profile expires, startup should alert and OpenClaw should continue using qwen.
- If Docker Desktop itself does not start after Windows reboot, the container will not restart until Docker starts.
- The old folder `C:\Users\chest\.openclaw-docker` is no longer the live state store. It is useful as a backup/source copy from before the volume migration.

## Useful Recovery Commands

### Restart gateway

```powershell
cd C:\Users\chest\projects\openclaw
docker compose restart openclaw-gateway
```

### Recreate gateway

```powershell
cd C:\Users\chest\projects\openclaw
docker compose up -d --force-recreate openclaw-gateway
```

### Fix ownership if a volume is recreated incorrectly

```powershell
docker compose exec -u root openclaw-gateway chown -R node:node /home/node/.openclaw
docker compose exec -u root openclaw-gateway chown -R node:node /home/node/.openclaw/agents/main/agent/codex-home
```

### Re-check model status

```powershell
docker compose run --rm openclaw-cli models status
```

### Follow recent gateway logs

```powershell
docker compose logs --tail=200 openclaw-gateway
```

