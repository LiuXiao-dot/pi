# Marvis-Inspired Redesign — Audit & Plan

Reference: 5 Marvis (Windows desktop AI assistant) screenshots provided by the
PM. This doc captures the gap between the current `packages/web` UI and the
Marvis design language, plus the concrete changes shipped in this iteration.

## Marvis design language (extracted)

Visual:

- Light surface (≈ `#FAFAFA` / pure white) with near-black (`#0F0F10`)
  text. Single accent color: a Marvis red-orange (`#E94B2B` ish, the scarf
  on the mascot).
- Generous whitespace. Card and panel radius ≈ 16px. Buttons and inputs
  use pill / capsule radius (`9999px`).
- Soft shadows only (`0 1px 2px rgba(0,0,0,.04), 0 8px 32px rgba(0,0,0,.06)`).
  No heavy borders.
- Sans serif, optical-sized, near-400 weight for body, 500 for headings.
  Chinese / Latin mixed at one rhythm.

Information architecture (5 screens):

1. **Hero / new-conversation home** — center brand block (mascot + name +
   slogan), large input, file picker, big circular send button. Below that
   a category tab strip (推荐 / 办公学习 / 电脑设置 / 生活日常 / 游戏娱乐)
   and a 3-by-2 grid of suggested-task cards with hover lift + arrow.
2. **Chat view** — user bubble right (gray pill), assistant bubble left
   with a mascot avatar; below each assistant message: copy / thumbs up /
   thumbs down. Persistent input dock at the bottom.
3. **Onboarding loader** — centered headline, isometric mascot illustration,
   bottom progress bar with percentage and ETA.
4. **Settings modal** — backdrop + centered card. Left menu (我的账号 /
   通用设置 / AI 模式 / 隐私&安全 / 关于&反馈), right detail. Sign-in CTA
   when logged out.
5. **"Marvis 办公室" (Office)** — isometric workstation grid; each role
   gets a workstation with a small character illustration. Empty
   workstations indicate room for future agents. Right side panel with
   Token usage, Token saved, and conversation totals (in-progress / done /
   total).

Navigation chrome (all screens):

- Left rail: brand at top, search input, three primary actions (新建对话 /
  自动任务 / 技能广场), grouped local-knowledge sources (应用 / 文档 /
  图库 / 此电脑) — each collapsible, then conversation history, then a
  sticky account row at the bottom.
- Top right: notification bell, window controls.

## Current `packages/web` UI (as of audit)

- `index.html` (32 lines) — single root `#app` plus a loading overlay.
- `style.css` (≈ 2.5k lines) — single dark theme, slate / teal accent.
  Already labelled "Marvis-inspired dark theme" in the file header but
  visually closer to a generic dark IDE look.
- `main.ts` (≈ 2.7k lines) — vanilla TS DOM construction:
  - `renderWorkspace` builds: top header (brand + Roles button + user +
    sign-out), left `room-rail` with rooms list and create input, right
    `chat-column`.
  - Modals: `showRoleLibraryModal`, `showRoomConfigModal`,
    `showSkillPickerModal`, `showExtensionModal`. All use `.modal-backdrop`
    + `.modal` classes.

### Gaps vs Marvis

| Area | Current | Marvis target |
| --- | --- | --- |
| Theme | Dark only | Light primary, dark optional |
| Accent | Teal / blue gradient | Single Marvis red-orange |
| Brand | Text "pi Hub" with gradient fill | Brand mark + mascot, single color |
| Sidebar | Just rooms list + create input | Search + primary actions group + knowledge group + history + bottom account row |
| Hero | None — chat opens straight | Centered brand, big input, suggested-task grid |
| Chat bubbles | Boxy, framed | User: right pill; assistant: avatar + soft card |
| Card hover | None | translateY(-2px) + shadow + arrow fade-in |
| Modals | Standard backdrop | scale(.96)→1 + fade |
| Office page | Missing | Isometric SVG of the room's roster |
| Empty stats | Missing | Token usage / saved / conversation counters panel |
| Onboarding | Static "Loading pi Hub" | Mascot + progress bar + ETA |

## Shipped in this iteration

This is a layered overlay, not a full rewrite. Existing dark theme stays
as a fallback (`body.theme-dark`) and existing DOM is largely untouched.

1. **`packages/web/src/theme-marvis.css`** — light Marvis palette,
   capsule-radius controls, soft shadows, animation tokens. Loaded
   alongside `style.css` and active when `<body>` has the
   `theme-marvis` class (default).
2. **`packages/web/src/office-view.ts`** — new module exposing
   `showOfficeModal(client, roomId)`. Renders an SVG isometric office
   with one workstation per role on the room's active roster, plus
   greyed-out placeholder workstations. Right panel surfaces what the
   hub already knows: room id, active roles, total roles available,
   conversation message count. (Actual token accounting is not plumbed
   through the hub yet; placeholders read "—" with a tooltip.)
3. **Header button** — `Office` button in `renderWorkspace` opens the
   modal. Placed next to `Roles`.
4. **Reduced-motion support** — animations gated behind
   `@media (prefers-reduced-motion: no-preference)`.

## Deferred (tracked, not in this iteration)

- True three-pane redesign of `renderWorkspace` (knowledge sources, search,
  account row at the bottom). Would require deep changes to ~2.7k LoC of
  `main.ts` and is best done as a dedicated PR.
- Hero / suggested-task home page — needs product input on which tasks
  the hub should suggest by default.
- Per-role token / usage accounting end-to-end (server side missing).
- High-fidelity mascot illustrations — currently programmatic SVG.
- Onboarding loader artwork.

## Reviewer checklist (for the follow-up reviewer pass)

- Light theme contrast meets WCAG AA on text vs background.
- Office modal closes via Esc and backdrop click; focus is restored.
- SVG isometric grid scales without overflow on 1280×720 and 1920×1080.
- No regressions in existing modals when `theme-marvis` is active.
- `prefers-reduced-motion: reduce` disables card lift / modal scale.
