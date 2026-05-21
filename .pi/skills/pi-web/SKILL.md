# pi Web Frontend

You are an expert on the pi Hub web UI (`packages/web/`). When working on web code, reference this skill for architecture, rendering patterns, and CSS conventions.

## Architecture

```
index.html → main.ts → HubClient → WebSocket → pi Hub Server
                  ↓
            DOM rendering
```

The web UI is a vanilla TypeScript SPA (no framework). All rendering is imperative DOM manipulation via `document.createElement` and helper functions.

## File Layout

```
packages/web/
├── index.html          — Entry HTML (mounts #app, loads main.ts)
├── dist/               — Build output (HTML + bundled JS + CSS)
├── src/
│   ├── main.ts         — All UI rendering & interaction logic (2300+ lines)
│   ├── hub-client.ts   — WebSocket client wrapper
│   ├── protocol.ts     — Client-side type definitions mirroring hub protocol
│   ├── composer-mentions.ts — @mention autocomplete for the input composer
│   └── style.css       — All styles (x.ai inspired light theme)
└── scripts/build.mjs   — esbuild bundler
```

## `HubClient` (`hub-client.ts`)

WebSocket wrapper providing:
- **Connection**: `openSocket()`, `connect()`, `disconnect()`, `reconnect()`
- **Room**: `join()`, `leave()`, `switchRoom()`
- **Commands**: `prompt()`, `listRooms()`, `createRoom()`, `deleteRoom()`, `getRoomConfig()`, `setRoomConfig()`
- **Models**: `setModel()`, `getAvailableModels()`, `getModelsConfig()`, `setRoleModel()`, `setProviderBaseUrl()`
- **Roles**: `listRoles()`, `getRole()`, `saveRole()`, `deleteRole()`, `addRoomRole()`, `removeRoomRole()`
- **Skills**: `listSkills()`, `getSkillContent()`
- **Session**: `clearRoomSession()`
- **Extensions**: `extensionUiResponse()`
- **Events**: `onMessage(handler)` — all hub messages flow through handlers

Uses a request/response pattern for commands: sends with unique `id`, resolves promise when `command_result` with matching `id` arrives. Timeout: 30s.

## `main.ts` — Rendering Architecture

The entire UI lives in one file. Key patterns:

### View Transitions
Two views rendered into `#app`:
1. **Login** (`renderLogin`): Sign-in form (hub URL, token, display name)
2. **Workspace** (`renderWorkspace`): Full chat UI with room rail

Transitions use CSS animations (`view-exit`/`view-enter` classes with opacity crossfade).

### Workspace Layout
```
.workspace-shell
├── .workspace-header     — Brand, Roles button, user name, Sign out
└── .workspace-layout
    ├── .room-rail         — Sidebar (rooms list + toolbar)
    │   ├── .room-rail-header  — "Rooms" title
    │   ├── .room-toolbar      — [input] [Create] [重生] [睡觉]
    │   └── .room-list         — Room entries with swipe-to-delete
    └── .chat-column
        └── .chat-layout
            └── .chat-panel
                ├── .header       — Room toggle, room name, status
                ├── .model-bar    — Session model select, role models, endpoint
                ├── .error-banner
                ├── .messages     — Chat message list
                ├── .role-gap-bar — Role gap warnings
                ├── .role-plan-panel — PM plan display
                ├── .role-progress-bar — Role progress
                ├── .activity-bar — Activity status
                ├── .token-bar    — Token usage stats
                ├── .queue-bar    — Queue status
                └── .composer     — Input area with file attachments
```

### Message Rendering
Messages flow through:
- **History load** (`renderHistory`): Renders all messages on join
- **Streaming** (`handleAgentEvent`): Real-time updates via `agent_event`
  - `message_start` → defer element creation
  - `message_update` → create or update collapsible assistant message
  - `message_end` → finalize, extract conclusion
  - `tool_execution_start/update/end` → collapsible tool messages

Assistant messages use **collapsible** rendering:
- `.msg-collapse-header` — Always visible: toggle (▶/▼), avatar (π), conclusion label
- `.msg-collapse-body.hidden` — Full message text, hidden by default
- During streaming: label shows "Replying…"; on complete: label shows last paragraph as conclusion

### @Mentions (`composer-mentions.ts`)
- `@` triggers autocomplete menu with role and user suggestions
- Keyboard navigation (ArrowUp/Down, Enter/Tab to select, Escape to dismiss)
- `getTargets()` supplies room-assigned roles + online presence members

### File Attachments
- File input for images, PDFs, text files
- Clipboard paste for images (screenshots)
- Rendered as chips in the composer with remove buttons
- Images sent as base64 data URLs; text files as inline content

### Role Sub-Rows
- Active role executions shown as nested rows under the room in the rail
- Status dots: yellow pulsing (started), green (done), red (failed)
- Clickable at any phase — opens modal with available output

## `protocol.ts` — Client Types

Re-exports and mirrors types from `pi-hub` protocol. Key local types:
- `HubModelInfo` — model display info (provider, id, name, baseUrl, api, hasAuth)
- `HubRoomSummary` — room list entry (roomId, title, createdAt, updatedAt, clientCount)
- `HubRoomConfigPayload` — room config shape (roleNames, skills, rules, roleOverrides, rolesEnabled)

## CSS (`style.css`)

### Theme System
x.ai-inspired light theme using CSS custom properties on `:root`:
- **Surfaces**: `--canvas`, `--surface`, `--surface-raised`, `--surface-subtle`
- **Borders**: `--border` (6% opacity), `--border-strong` (10%)
- **Text**: `--text` (#111113), `--text-body` (#4b4b55), `--muted` (#8e8e98)
- **Accent**: `--accent` (#1a5fff electric blue)
- **Semantic**: `--error` (#e02e3c), `--success` (#16a34a), `--warning-bg`, `--warning-text`
- **Typography**: Inter font, JetBrains Mono for code
- **Motion**: `--ease-out`, `--ease-in-out`, `--duration-fast` (150ms), `--duration-normal` (280ms)

### Key CSS Classes
| Class | Purpose |
|-------|---------|
| `.primary-btn` | Accent-colored pill button (hover: lift + glow) |
| `.secondary-btn` | Outlined pill button (hover: fill + shadow) |
| `.danger-btn` | Red text, red background on hover |
| `.msg.user` | User message bubble (right-aligned, blue tint) |
| `.msg.assistant` | Assistant message bubble (left-aligned, white) |
| `.msg.tool` | Tool execution (mono font, collapsible) |
| `.msg-collapse-*` | Collapsible assistant message components |
| `.modal-backdrop` + `.modal` | Centered modal with backdrop blur |
| `.room-rail` | 280px left sidebar, slides in on mobile |
| `.composer` | Frosted glass input area (backdrop-filter: blur) |

### Responsive
- Mobile breakpoint: 768px
- Room rail becomes off-screen drawer with toggle button
- Backdrop overlay when rail is open on mobile

### Button States
- `.primary-btn:disabled` — `opacity: 0.45`, no hover effects
- `.secondary-btn:disabled` — `opacity: 0.4`, no hover effects

## Build

```bash
npm run web:build   # esbuild bundles main.ts → dist/main.js
```

The build copies `index.html` and `style.css` to `dist/`, then bundles TypeScript. Output served by hub's HTTP server from `packages/web/dist/` (or `packages/hub/dist/public/` after full `hub:build`).
