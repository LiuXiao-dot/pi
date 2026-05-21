# Changelog

## [Unreleased]

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

- Prompts without any `@role` mention use the main session directly, even when the room has assigned roles.
- Hub session startup falls back to the first `models.catalog` entry with configured auth when `models.session` is missing or unavailable.
- Improved join/auth error messages and safe JSON broadcast to avoid hub crashes disconnecting clients.
- Hub startup warns when `PI_HUB_TOKEN` overrides `.pi/hub.json`; token compare trims whitespace.
