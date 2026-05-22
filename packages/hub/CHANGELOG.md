# Changelog

## [Unreleased]

### Breaking Changes

- Role memory directory moved from `.pi/hub/memory/` to `.pi/memory/` so the (project-shared, intended-to-commit) memory store no longer lives under the runtime/transient `.pi/hub/` tree. Existing memory files must be moved manually: `mv .pi/hub/memory .pi/memory`. The room registry (`.pi/hub/rooms.json`), per-room directories (`.pi/hub/rooms/<roomId>/`), and conversation JSONLs continue to live under `.pi/hub/` and should be gitignored by consumers.

### Fixed

- Prompt queue failures are broadcast to connected clients as `error` events instead of failing silently in the server log only.
- Image attachments with empty or invalid MIME types are normalized from base64 bytes before calling the model (JPEG/PNG/GIF/WebP only).
- `appendRoleMemory` now allocates `seq` as `max(existing seq) + 1` instead of `existing.length`, so deleting a memory no longer makes the next append collide with another row's seq.
- `handleSleepRoom` / `handleClearRoomSession` refuse with a clear error when the room is busy (replying / compacting / already sleeping) instead of silently dropping in-flight work.
- `sleep_progress` phases now `await setImmediate` between broadcasts so clients actually see `extracting -> storing -> clearing` instead of three queued frames at once.
- Sleep memory extraction prefers structured `details.task` and `details.exitCode` populated by the role orchestrator, and strips the `[role] (status)` / `Task:` framing from `result`. The previous regex-on-content path is kept only as a fallback for older messages.
- Rebirth (`clear_room_session`) and sleep (`sleep_room`) used to call `sessionManager.newSession()` which silently rotated the session file path on disk *without* updating the room registry. After a hub restart, the registry kept pointing at the pre-rebirth file and any new conversations written after the rebirth (in the orphan jsonl) were unreachable. Both code paths now go through the new `Room.clearAndRotateSession(reason)` which reset, rotates, *and* propagates the new path back to `RoomRegistry.updateSessionFile`.
- `RoomManager.createSessionForRoom` now self-heals when the registry's `sessionFile` is missing or empty: it scans the room directory for the most recently-modified valid jsonl via `findMostRecentSession()` and resumes from that file, then updates the registry. This recovers conversation history that was previously orphaned by the bug above.

### Added

- Per-task role cancellation: new `abort_task` client message lets a client cancel a single in-flight role subprocess by `taskId` without aborting the rest of the room. `RoleOrchestrator` now tracks an `AbortController` per task and exposes `abortTask(taskId)`. The room-wide `abort` still cancels everything (parent signal is linked to each task).
- Persisted role memories are now read back into the role's run context: `runRoleSubprocess` injects up to N most-recent memories (default 10) into `contextPrefix`, so sleeping a room actually makes future role runs aware of past goals/results. New helper `loadRecentRoleMemory(cwd, name, limit)`.
- New protocol message `room_session_cleared` broadcast after rebirth and sleep so every client (not just the initiator) drops local reply / turn indices for the cleared session.
- `sleep_done` now carries `success: boolean` and an optional `error` string, replacing the prior "empty memories looks like a no-op" ambiguity.
- Room sleep mutex: while a sleep is in progress the room broadcasts activity phase `sleeping`, the server-side `beginSleep()` mutex blocks concurrent sleeps from multiple clients, and `endSleep()` is called in a `finally` so a thrown extractor cannot leave the room locked.

### Changed

- Web UI sign-in no longer requires a room id; after login, a room list (create / delete / enter) is shown before joining chat.
- PM task prompts include a per-room worker roster (Who / Can do / When) from role frontmatter (`who`, `can`, `when`); PM is instructed it only sees roles assigned to the room, not the global library.
- Multi-role orchestration no longer uses every discovered role; only names in the room `roleNames` list run (empty list disables orchestration until roles are added).
- Monorepo root script `build:web` renamed to `web:build` (matches `hub:build`: `<package>:build`).

### Breaking Changes

- Joining a room requires `create_room` first (unknown `roomId` is rejected). Hub startup still auto-creates `defaultRoomId` when the registry is empty.
- Enabling `rolesEnabled` on a room requires adding PM and at least one worker role to `roleNames` explicitly.

### Added

- WebSocket `leave` command and `left` event so clients can return to the room list or switch rooms on the same connection.
- Room `roleNames` list: assign roles from the global library per room (no duplicates); `add_room_role`, `remove_room_role`, `set_room_roles` commands.
- Web UI "Room roles" panel separate from "Role library"; orchestration uses only assigned roles (PM must be added to the room).

- Room registry (`.pi/hub/rooms.json` + `.pi/hub/rooms/<id>/`) with per-room session JSONL persistence across hub restarts.
- Hub-scoped WebSocket commands: `list_rooms`, `create_room`, `delete_room`, `get_room_config`, `set_room_config`.
- Role management commands: `list_roles`, `get_role`, `save_role`, `delete_role` (project and user role directories).
- Per-room `config.json` for skills, rules, `roleOverrides`, and optional `rolesEnabled`.
- Role orchestration writes `hub_role_plan` / `hub_role_output` custom messages to the room session; injects recent room context into role subprocesses; `abort` cancels orchestration via `AbortSignal`.
- Web UI: room list/create/delete/switch, room config editor, role markdown editor, role message styling in chat.

- `activity_update` WebSocket event and `hostDisplayName` on `agent_event` so clients can show which operator owns the turn and whether the agent is replying, thinking, using tools, or compacting.
- LAN WebSocket hub (`pi-hub`) for multi-client collaborative pi coding-agent sessions with serialized prompt queue and extension UI routing.
- Layered config: `~/.pi/hub.json`, `<cwd>/.pi/hub.json`, `PI_HUB_*` env vars, and `pi-hub init`.
- Monorepo scripts `npm run hub`, `hub:build`, `hub:init`, and `scripts/pi-hub.ps1` for Windows.
- WebSocket commands `get_available_models`, `set_model`, and `set_provider_base_url` for shared model selection and proxy base URL overrides.
- Model catalog in `hub.json` (`models.catalog`, `models.session`, `models.roleModels`) with Web UI dropdowns for session and per-role models; `get_models_config` and `set_role_model` commands.
- Multi-role orchestration (`roles.enabled` in hub.json): PM subprocess task planning, per-role subprocess execution with model/tools/skills/rules from `.pi/roles/`, `role_plan` / `role_progress` / `role_gap` WebSocket events, and main-session synthesis.

### Added

- `@role` and `@user` mentions in chat prompts: only `@mentioned` room roles run orchestration (`@pm` plans tasks; `@web-ui` and other workers run directly when mentioned without PM).

### Fixed

- Role subprocess spawn on Windows: `npm run hub` now sets `PI_CLI_SCRIPT` instead of a combined `PI_COMMAND` shell line (fixes `spawn ... ENOENT` and `queue item failed`).
- Role subprocess logs the configured model per role (from `hub.json` / role frontmatter) at start.
- Prompts without any `@role` mention use the main session directly, even when the room has assigned roles.
- Hub session startup falls back to the first `models.catalog` entry with configured auth when `models.session` is missing or unavailable.
- Improved join/auth error messages and safe JSON broadcast to avoid hub crashes disconnecting clients.
- Hub startup warns when `PI_HUB_TOKEN` overrides `.pi/hub.json`; token compare trims whitespace.
