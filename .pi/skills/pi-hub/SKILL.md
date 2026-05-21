# pi Hub Backend

You are an expert on the pi Hub LAN server (`packages/hub/`). When working on hub code, reference this skill for architecture, data flow, and conventions.

## Entry Point & Startup

```
cli.ts → config.ts (resolveHubConfig) → server.ts (startHubServer)
```

`startHubServer` wires together:
1. `RoomManager` — creates/loads rooms, manages sessions
2. `HttpServer` — serves static web files + `/health` endpoint
3. `WsHub` — WebSocket server handling client connections

## Core Classes

### `WsHub` (`ws-hub.ts`)
- Owns the `WebSocketServer` attached to the HTTP server (path: `/ws`).
- Authenticates clients via token (must match `hub.json` or `PI_HUB_TOKEN` env).
- Routes messages:
  - **Hub-scoped** (pre-join): Delegates to `HubAdmin` for room CRUD, roles, skills.
  - **Join**: Creates or looks up room via `RoomManager`, registers client, sends `joined` with full state.
  - **Room-scoped** (post-join): Delegates to the `Room` instance.

### `RoomManager` (`room-manager.ts`)
- Creates `Room` instances lazily on first join.
- Each room gets its own `AgentSession` via `createAgentSession` from `pi-coding-agent`.
- Manages `RoomRegistry` for persistence (rooms.json index + per-room config/session files).

### `Room` (`room.ts`)
- The core hub unit — one per room, shared by all connected WebSocket clients.
- Owns:
  - `AgentSession` — the underlying coding-agent session
  - `PromptQueue` — serializes prompts from multiple clients
  - `ExtensionUiRouter` — routes extension UI requests to the turn owner
  - `RoleOrchestrator` — if roles enabled, handles multi-agent orchestration
- Broadcasts all session events to all clients in the room.
- Tracks activity phase (idle, thinking, replying, tool, compacting) for the activity bar.

### `HubAdmin` (`hub-admin.ts`)
- Handles hub-scoped (pre-join) commands: list/create/delete rooms, room config, roles CRUD, skills listing, clear session.
- Token-authenticated — uses the same token as WebSocket auth.

### `PromptQueue` (`prompt-queue.ts`)
- Serializes `prompt`, `steer`, and `follow_up` commands.
- When the session is busy, new items queue up; when idle, the next drains.
- If `@roleName` mentions are present and roles are enabled, routes to `RoleOrchestrator`.
- Otherwise, calls `session.prompt()` directly.
- Broadcasts `queue_update` messages to all clients.

### `RoomRegistry` (`room-registry.ts`)
- File-based persistence under `.pi/hub/`:
  - `rooms.json` — index of all rooms (roomId, title, createdAt, sessionFile)
  - `rooms/<id>/config.json` — per-room config (roleNames, skills, rules, roleOverrides, rolesEnabled)
  - `rooms/<id>/session.jsonl` — the coding-agent session file
- Room IDs support Unicode letters, digits, hyphens, underscores; max 64 chars.

## Role Orchestration (`role-orchestrator.ts`)

When a user mentions `@roleName` in a room with roles enabled:

### PM Mode (`@pm` mentioned)
1. PM role subprocess runs with room worker roster → produces JSON task plan
2. Plan parsed via `parse-plan.ts`
3. Tasks batched by dependency graph (`topo.ts`), run in parallel (configurable `maxParallel`)
4. Each worker role runs as a subprocess (`runner.ts`) with its system prompt, model, tools, skills
5. Results synthesized into a final assistant message via `session.prompt()`

### Direct Mode (only worker roles mentioned, no `@pm`)
1. Each mentioned worker role runs independently as a subprocess
2. Results combined into a single assistant response

### Subprocess Execution (`roles/runner.ts`)
- Spawns `pi --mode json -p --no-session` with role-specific args (model, tools, skills, append-system-prompt)
- Parses JSONL output to extract final assistant message
- Supports abort via `AbortSignal`

## Protocol (`protocol.ts`)

All client↔hub communication is JSON over WebSocket. Key message types:

**Client→Hub:**
- `join`, `leave`, `prompt`, `steer`, `follow_up`, `abort`
- `set_model`, `set_provider_base_url`, `set_role_model`
- `get_state`, `get_available_models`, `get_models_config`
- `extension_ui_response`

**Hub→Client:**
- `joined` (full state snapshot), `left`, `room_deleted`
- `agent_event` (wraps coding-agent session events)
- `activity_update` (phase + host display name)
- `queue_update` (pending + current)
- `presence` (online members)
- `command_result` (ack for hub-scoped commands)
- `error`
- `role_plan`, `role_progress`, `role_gap` (orchestration events)
- `extension_ui_request` (outbound to clients)

Hub-scoped messages (list_rooms, create_room, etc.) are handled by `HubAdmin` without joining a room.

## Configuration (`config.ts`)

Config resolution order (later overrides earlier):
1. `~/.pi/hub.json`
2. `<cwd>/.pi/hub.json`
3. `--config <path>` CLI flag or `PI_HUB_CONFIG` env
4. CLI flags (`--token`, `--port`, etc.)
5. Environment variables (`PI_HUB_TOKEN`, `PI_HUB_PORT`, etc.)

Key config fields:
- `token` — authentication token
- `port` — HTTP/WS port (default 3141)
- `models.catalog` — model whitelist for UI dropdown
- `models.session` — default session model
- `models.roleModels` — per-role model overrides
- `roles.enabled` — enable multi-agent orchestration
- `roles.pmRole` — PM role name (default "pm")
- `roles.maxParallel` — max parallel worker subprocesses (default 4)

## File Layout

```
packages/hub/src/
├── cli.ts              — CLI entry (pi-hub)
├── config.ts           — Config resolution & merging
├── server.ts           — startHubServer orchestrator
├── ws-hub.ts           — WebSocket server
├── http-server.ts      — Static file server + /health
├── hub-admin.ts        — Pre-join admin commands
├── room-manager.ts     — Room lifecycle & session creation
├── room.ts             — Room: session, queue, orchestration, broadcast
├── room-registry.ts    — File-based room persistence
├── room-roles.ts       — Role name validation & merging
├── prompt-queue.ts     — Serialized prompt queue
├── protocol.ts         — All WebSocket message type definitions
├── extension-ui.ts     — Extension UI request routing
├── model-info.ts       — Model info helpers
├── models-config.ts    — Model reference parsing & role model overrides
├── mentions.ts         — @mention parsing
├── safe-json.ts        — Safe JSON serialization
├── state-snapshot.ts   — Session state serialization
├── roles/
│   ├── types.ts        — RoleConfig, TaskPlan, RoleTaskResult types
│   ├── discovery.ts    — Load roles from .pi/roles/ directories
│   ├── resolve-config.ts — Merge room config with role definitions
│   ├── role-store.ts   — CRUD operations for role files
│   ├── skill-store.ts  — Skill file listing & content
│   ├── parse-plan.ts   — Parse PM's JSON task plan output
│   ├── topo.ts         — Dependency-based task batching
│   ├── runner.ts       — Spawn role subprocess via pi CLI
│   ├── room-context.ts — Build room context prefix
│   ├── pi-invocation.ts — Resolve pi CLI path
│   └── resolve-skills.ts — Resolve skill paths for subprocess
└── index.ts            — Public API exports
```

## Data Flow: Prompt Lifecycle

```
Client sends {type:"prompt", message:"hello @pm do X"}
  → WsHub.onMessage → room.handleMessage
    → PromptQueue.enqueue (queues if busy, runs immediately if idle)
      → PromptQueue.drain
        → if @mention + roles enabled:
            → RoleOrchestrator.run
              → PM subprocess → parse plan → batch tasks
              → Worker subprocesses → collect results
              → session.prompt(synthesis) → final assistant response
        → else:
            → session.prompt(message) → direct assistant response
    → Session events broadcast to all clients via agent_event + activity_update
```
