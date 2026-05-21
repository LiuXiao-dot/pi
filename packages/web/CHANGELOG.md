# Changelog

## [Unreleased]

### Changed

- Web UI workspace layout: sign-in only on the login page; after login, room list and chat share one screen (switch rooms without leaving chat).
- Web UI restyled with light white-green palette, pill controls, subtle gradients, and motion.

### Fixed

- Hub restart no longer leaves a stale `joined` state on a closed WebSocket; room config and re-join work after reconnect.
- Auto-login and refresh wait for WebSocket `open` before listing rooms.
- Hub web client now renders user and assistant messages live from `agent_event` updates instead of only after a page refresh.

### Added

- Assistant replies show the queue turn host name; activity bar reflects replying, thinking, tool use, and compaction from hub `activity_update` events.
- Web SPA for pi-hub: connect form, shared message stream, prompt queue indicator, and extension UI dialogs.
- Model selector and API endpoint (base URL) panel for switching models and configuring proxy URLs.
- Session and per-role model dropdowns driven by `hub.json` `models.catalog`; changes to role models persist via `set_role_model`.
- UI for multi-role orchestration: plan summary, role progress line, and uncovered-work warning bar (`role_plan`, `role_progress`, `role_gap`).
