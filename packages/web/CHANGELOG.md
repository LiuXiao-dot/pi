# Changelog

## [Unreleased]

### Added

- Web SPA for pi-hub: connect form, shared message stream, prompt queue indicator, and extension UI dialogs.
- Model selector and API endpoint (base URL) panel for switching models and configuring proxy URLs.
- Session and per-role model dropdowns driven by `hub.json` `models.catalog`; changes to role models persist via `set_role_model`.
- UI for multi-role orchestration: plan summary, role progress line, and uncovered-work warning bar (`role_plan`, `role_progress`, `role_gap`).
