# @earendil-works/pi-hub

LAN WebSocket hub for collaborative [pi](https://pi.dev) coding-agent sessions. Multiple browsers on the same network can join a **room**, watch the same agent stream, and send prompts through a **serialized queue**.

## Security

- Intended for **trusted LANs only**. There is no TLS in the default setup.
- Every client must present a shared **token** on join.
- The hub runs tools (bash, read, write, edit) against a shared working directory. Anyone with the token can affect that workspace.

## Quick start (pi-mono repo)

From the repository root (no global `pi-hub` install required):

```bash
npm run hub:init          # writes .pi/hub.json with a random token
npm run hub               # builds if needed, then starts
```

PowerShell:

```powershell
npm run hub:init
npm run hub
# or
.\scripts\pi-hub.ps1
```

Open `http://localhost:3141` (or `http://<your-lan-ip>:3141` from other devices). Use the same **token** and **room ID** as in the config (default room: `default`).

## Configuration

Settings are merged in order (later wins):

1. `~/.pi/hub.json` — user-wide defaults
2. `<cwd>/.pi/hub.json` — project overrides (recommended)
3. `--config <path>` or `PI_HUB_CONFIG`
4. CLI flags (`--token`, `--port`, …)
5. Environment variables (`PI_HUB_TOKEN`, `PI_HUB_PORT`, …)

Create a starter file:

```bash
pi-hub init                 # .pi/hub.json in current directory
pi-hub init --global        # ~/.pi/hub.json
npm run hub:init            # same as pi-hub init (from repo root)
```

Example `.pi/hub.json` (see [hub.json.example](./hub.json.example)):

```json
{
  "token": "your-long-random-secret",
  "port": 3141,
  "host": "0.0.0.0",
  "cwd": "E:\\path\\to\\your\\project",
  "defaultRoomId": "default"
}
```

### Environment variables

| Variable | Purpose |
|----------|---------|
| `PI_HUB_TOKEN` | Join token |
| `PI_HUB_PORT` | Listen port |
| `PI_HUB_HOST` | Bind address |
| `PI_HUB_CWD` | Agent working directory |
| `PI_HUB_SESSION` | Session JSONL path |
| `PI_HUB_DEFAULT_ROOM` | Default room id |
| `PI_HUB_CONFIG` | Extra config file path |

PowerShell example:

```powershell
$env:PI_HUB_TOKEN = "your-secret"
npm run hub -- --cwd E:\my\project
```

`PI_HUB_TOKEN` overrides the `token` field in `.pi/hub.json`. If the web UI shows **Invalid token** while you copied from the file, check whether the same PowerShell session still has `PI_HUB_TOKEN` set:

```powershell
Remove-Item Env:PI_HUB_TOKEN -ErrorAction SilentlyContinue
npm run hub
```

On startup, pi-hub logs whether the token came from config or from `PI_HUB_TOKEN`, and prints the last four characters so you can confirm what the server expects.

### CLI (after build or global install)

```bash
cd packages/hub && npm run build
node dist/cli.js --token your-secret --cwd /path/to/project
# or
npx pi-hub --help
```

| Command | Description |
|---------|-------------|
| `pi-hub` | Start server |
| `pi-hub init` | Write config template |
| `pi-hub help` | Show help |

## npm scripts (monorepo root)

| Script | Description |
|--------|-------------|
| `npm run hub` | Build if needed, run hub |
| `npm run hub:build` | Build web UI + hub |
| `npm run hub:init` | Create `.pi/hub.json` |

## Web UI: models and proxy URL

After connecting in the browser:

1. Use the **Model** dropdown to switch models (same list as `pi` / `get_available_models`).
2. Open **API endpoint** to set a provider **Base URL** (for example your OpenAI-compatible proxy). Click **Apply URL** — this updates the hub session for all clients in the room.

Persistent provider URLs can also be configured in `~/.pi/agent/models.json` on the hub machine (see [coding-agent models.md](../coding-agent/docs/models.md)). API keys still come from `/login` or environment variables on the server running `pi-hub`, not from the web UI.

## Protocol

WebSocket path: `/ws`

1. Client sends `join` with `roomId`, `token`, `displayName`.
2. Hub replies with `joined` and broadcasts `presence`.
3. Clients send `prompt`, `steer`, or `follow_up`. Hub enqueues and runs one at a time.
4. Hub broadcasts `agent_event` for session activity.
5. Blocking extension UI is routed to the client that owns the current queue turn.
6. `get_available_models`, `set_model`, and `set_provider_base_url` manage the shared session model and proxy base URL; successful changes broadcast `state_update`.
