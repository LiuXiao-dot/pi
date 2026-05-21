# pi Architecture

You are an expert on the pi monorepo architecture. When working on pi, reference this skill to understand how packages relate, the build system, and cross-package dependencies.

## Monorepo Structure

```
pi/
├── packages/
│   ├── ai/           @earendil-works/pi-ai          — LLM abstraction layer
│   ├── agent/        @earendil-works/pi-agent-core  — Agent state & transport
│   ├── tui/          @earendil-works/pi-tui          — Terminal UI framework
│   ├── coding-agent/ @earendil-works/pi-coding-agent — CLI coding agent
│   ├── hub/          @earendil-works/pi-hub          — LAN WebSocket hub server
│   └── web/          @earendil-works/pi-web (private)— Browser hub UI
├── .pi/
│   ├── roles/        — Role definitions (markdown with YAML frontmatter)
│   ├── skills/       — Project-local skill definitions
│   └── hub/          — Hub runtime data (rooms.json, rooms/<id>/config.json, session.jsonl)
└── scripts/          — Build, release, check scripts
```

## Package Dependency Chain (top-down)

```
pi-web ──► pi-hub ──► pi-coding-agent ──► pi-agent-core ──► pi-ai
                                    └──────► pi-tui
```

- `pi-ai`: Provider-agnostic LLM streaming (OpenAI, Anthropic, Bedrock, etc.), model registry, token counting.
- `pi-agent-core`: Agent turn loop, tool execution, state management, attachment handling, transport abstraction.
- `pi-tui`: Differential terminal rendering, keybinding system, component framework.
- `pi-coding-agent`: CLI entry point, concrete tools (read, bash, edit, write), RPC protocol, session manager, extension system.
- `pi-hub`: Multi-client WebSocket hub that orchestrates coding-agent sessions per room, with role-based multi-agent orchestration.
- `pi-web`: Browser SPA that connects to hub via WebSocket, renders chat UI, manages rooms/roles/skills.

## Key Concepts

### Sessions
- A session is the conversation state: messages, model selection, tool approvals.
- `coding-agent` uses `SessionManager` (JSONL file) for persistence.
- Hub creates one session per room, shared by all clients in that room.

### Models
- `pi-ai` discovers available models from provider APIs.
- Hub has a `models.catalog` in `hub.json` to filter which models appear in the Web UI.
- `pi-ai/src/models.generated.ts` is auto-generated — never edit directly, modify `scripts/generate-models.ts`.

### Roles (Multi-Agent Orchestration)
- Roles are `.md` files in `.pi/roles/` or `~/.pi/agent/roles/` with YAML frontmatter (`name`, `description`, `who`, `can`, `when`, `model`, `tools`, `skills`).
- When roles are enabled on a room, `@roleName` mentions trigger multi-agent orchestration.
- The PM role (`pm` by default) plans tasks and dispatches to worker roles as subprocesses.
- Without `@pm`, mentioned roles run independently (direct mode).

### Skills
- Skills are `.md` files in `.pi/skills/` or `~/.pi/agent/skills/`.
- They inject additional system prompt context when active.
- Can be assigned to rooms or roles via `skills` field.

## Build & Check

- **Build order**: tui → ai → agent → coding-agent → web → hub
- `npm run check`: biome lint + TypeScript type-check + pinned deps + shrinkwrap + browser smoke test
- `npm run web:build`: bundles web SPA into `packages/web/dist/` (esbuild)
- `npm run hub:build`: web build + hub build
- Never run `npm run build` or `npm test` unless instructed.

## TypeScript Rules

- Node strip-only mode — no enums, no namespaces, no parameter properties, no `import =`.
- All imports must be standard top-level — no inline `import()`.
- Use erasable syntax only.
- No `any` types unless absolutely necessary.

## Configuration Files

| File | Purpose |
|------|---------|
| `~/.pi/hub.json` | Global hub config (token, port, models, roles) |
| `<cwd>/.pi/hub.json` | Project hub config (overrides global) |
| `~/.pi/agent/auth.json` | API keys for model providers |
| `~/.pi/agent/models.json` | Model registry cache |

## Changelogs

Each package has its own `CHANGELOG.md`. Under `## [Unreleased]`, add entries to existing subsections (`### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Breaking Changes`). Never modify released version sections.
