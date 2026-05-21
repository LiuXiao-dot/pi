# Changelog

## [Unreleased]

### Added

- LAN WebSocket hub (`pi-hub`) for multi-client collaborative pi coding-agent sessions with serialized prompt queue and extension UI routing.
- Layered config: `~/.pi/hub.json`, `<cwd>/.pi/hub.json`, `PI_HUB_*` env vars, and `pi-hub init`.
- Monorepo scripts `npm run hub`, `hub:build`, `hub:init`, and `scripts/pi-hub.ps1` for Windows.
- WebSocket commands `get_available_models`, `set_model`, and `set_provider_base_url` for shared model selection and proxy base URL overrides.

### Fixed

- Improved join/auth error messages and safe JSON broadcast to avoid hub crashes disconnecting clients.
- Hub startup warns when `PI_HUB_TOKEN` overrides `.pi/hub.json`; token compare trims whitespace.
