# Changelog

## [Unreleased]

### Added

- `activity_update` WebSocket event and `hostDisplayName` on `agent_event` so clients can show which operator owns the turn and whether the agent is replying, thinking, using tools, or compacting.
- LAN WebSocket hub (`pi-hub`) for multi-client collaborative pi coding-agent sessions with serialized prompt queue and extension UI routing.
- Layered config: `~/.pi/hub.json`, `<cwd>/.pi/hub.json`, `PI_HUB_*` env vars, and `pi-hub init`.
- Monorepo scripts `npm run hub`, `hub:build`, `hub:init`, and `scripts/pi-hub.ps1` for Windows.
- WebSocket commands `get_available_models`, `set_model`, and `set_provider_base_url` for shared model selection and proxy base URL overrides.
- Model catalog in `hub.json` (`models.catalog`, `models.session`, `models.roleModels`) with Web UI dropdowns for session and per-role models; `get_models_config` and `set_role_model` commands.
- Multi-role orchestration (`roles.enabled` in hub.json): PM subprocess task planning, per-role subprocess execution with model/tools/skills/rules from `.pi/roles/`, `role_plan` / `role_progress` / `role_gap` WebSocket events, and main-session synthesis.

### Fixed

- Improved join/auth error messages and safe JSON broadcast to avoid hub crashes disconnecting clients.
- Hub startup warns when `PI_HUB_TOKEN` overrides `.pi/hub.json`; token compare trims whitespace.
