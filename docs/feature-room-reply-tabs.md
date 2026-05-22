# 房间回复子页签 / Room Reply Sub-Tabs

> 目标包：`packages/web`（必要时配合 `packages/hub` 协议补充）。
> 角色：`web-ui`。

## 背景

当前会话中：

- 用户在某个房间（room）内发送消息，房间内可能由 **session 主模型** 与一个或多个 **角色（role）** 同时回复（见 `RoleOrchestrator`，事件：`agent_event` / `role_progress` / `role_plan`）。
- 现状：所有回复内容（assistant 气泡 + role 输出）都直接 append 到右侧主对话窗口 (`#messages`)，不同来源混在一起；左侧 Rooms 列表只在当前选中房间下展示一组临时 sub-rows（`renderRoleSubRows`）。
- 已有但不完整的骨架：`replyStore` / `roomReplies` / `activeReplyId` / `renderRoleSubRows` / `updateRoomReplyRows`（位于 `packages/web/src/main.ts`）。请基于这套骨架改造，不要另起炉灶。

## 需求（最终行为）

### 左侧 Rooms 行为

1. 每个房间行下方，按需展开一组**子页签（sub-tabs）**：
   - 主回复（session 主模型）：标签使用 **房间名**（`room.title || roomId`）。
   - 每个被触发的 role 回复：标签使用 **角色名**（`roleName`）。
2. 子页签在该回复**开始流式输出时**出现，并持续保留（不要在 `done` 后 8s 隐藏）。
   - 如果同一个 role 后续又被触发，复用旧子页签或在其后追加新条目均可，但同一 turn 内必须保持稳定的 id，不要因为 phase 切换而重建 DOM。
3. 子页签状态点（`role-sub-dot`）反映当前 phase：`running` / `done` / `failed`。
4. 点击子页签：
   - 把 `activeReplyId` 设为该 reply 的 id。
   - 右侧主对话窗口切换为该 reply 的**完整内容**（见下文“右侧主对话窗口”）。
   - 仅 UI 切换，**不**重新发请求、**不**修改 session 上下文、**不**触发 join。
   - 如果子页签所属房间不是当前 join 的房间，先 `selectRoom(roomId)` 再渲染（沿用现有行为）。
5. 没有任何子页签处于选中状态时，右侧显示“状态主体视图”（默认视图，见下）。
6. 子页签的可取消（swipe → cancel）行为保留，但仅对仍在 `running` 的回复显示。

### 右侧主对话窗口（核心改动）

存在两种渲染模式，由 `activeReplyId` 决定：

- **状态主体视图（默认，`activeReplyId === null`）**：
  - 显示用户自己发出的消息气泡（保留现有 user message 渲染）。
  - 对每个回复（session 主回复 + 每个 role 回复），渲染**一行状态条**，**不**渲染完整正文/工具调用气泡。
  - 状态条文案规范（示例，按 turn 时间顺序）：
    - 开始：`to <我的 displayName> · <房间名 或 角色名> · 进行中…`
    - 进行中（可选 detail）：`to <我> · <角色名> · 思考中` / `... · 调用工具 <toolName>` / `... · 整理输出`
    - 完成：`to <我> · <角色名> · 已完成 — <摘要>`
    - 失败：`to <我> · <角色名> · 失败 — <错误概要>`
  - 摘要来源：
    - role：使用 `role_progress.preview`（截断到 ~80 字）。
    - session：使用最后一条 assistant 文本的前 ~80 字。
  - 状态条可点击，等价于点击对应子页签（切到详情视图）。
  - 在同一 turn 内，状态条必须**原地更新**，不能为每个 phase 追加新行。

- **详情视图（`activeReplyId` 指向某个 reply）**：
  - 渲染该 reply 的完整内容：assistant 气泡（含可折叠正文）、tool 调用、role 输出 等。
  - 顶部加一个返回栏（如 `← 返回房间状态`），点击清空 `activeReplyId`，回到状态主体视图。
  - 跨房间切回当前房间时，应回到状态主体视图（不要保留旧 `activeReplyId`）。

### 数据模型

扩展 `replyStore` 条目结构（`packages/web/src/main.ts`）：

```ts
type ReplyKind = "session" | "role";

interface ReplyEntry {
  id: string;             // 稳定 id，session=`session:<roomId>:<turnId>`, role=`role:<taskId>`
  roomId: string;
  kind: ReplyKind;
  label: string;          // session→房间名；role→角色名
  roleName?: string;      // 仅 role
  phase: "running" | "done" | "failed";
  detail?: string;        // 例如 toolName / "thinking" / "compacting"
  summary: string;        // 完成或失败后的摘要文本
  // 详情视图所需的完整内容：
  messages: unknown[];    // session：来自 agent_end 的 messages；role：合成出的 messages 数组（见下）
  events: unknown[];      // 可选：保留原始事件流，便于详情视图重放
  startedAt: number;
  endedAt?: number;
}
```

- `roomReplies: Map<roomId, string[]>` 维持插入顺序。
- `activeReplyId: string | null`。

### 事件 → 状态条 / Reply 的映射

来源：`HubServerMessage` 中的 `agent_event`、`role_progress`、`role_plan`、`activity_update`（详见 `packages/hub/src/protocol.ts`）。

1. **session 主回复**
   - 在用户提交 turn 时（`sendMessage` 调用后）创建 `kind: "session"` 的 reply，`phase: "running"`，`label = 当前房间标题`。
   - `agent_event` 的 `message_start` / `message_update` / `message_end`（assistant 角色）：
     - 详情视图模式下，沿用现有渲染逻辑写入该 reply 的容器。
     - 状态视图下**不**写入主区域，只更新状态条 detail（思考/工具/回复中），并把流式文本累积到 `reply.messages`。
   - `tool_execution_start` / 工具结果：仍归属当前 session reply，不在状态视图渲染。
   - `agent_end`：`phase = "done"`；`summary` 取最后一条 assistant 文本前 80 字；`messages = event.messages`。

2. **role 回复**
   - `role_progress.phase === "started"`：创建/更新 `kind: "role"` reply，`label = roleName`，`phase = "running"`。
   - `role_progress.phase === "done" | "failed"`：更新同一个 reply（按 `taskId` 匹配），写入 `summary = preview`、`messages = [{role:"custom", customType:"hub_role_output", content: fullOutput}]`、`endedAt`。
   - `role_plan` 仍可在状态主体视图顶部以一个折叠条展示（保留现有 `rolePlanPanel`），但不再侵占主对话。

3. **activity_update**
   - 用于丰富 session reply 的 `detail`（thinking/tool/compacting/replying）。
   - 仍可保留顶部 `activityBar`，但状态条本身要单独反映该信息。

### 多房间

- 仅渲染当前 join 的房间的状态条；其他房间的子页签依赖 `roomReplies` 中已存在的条目（来自之前 join 时累积），允许保留并可点击切换。
- `room_deleted` 时清理 `replyStore` / `roomReplies` 中对应房间的所有 reply 与 `activeReplyId`。
- 切换房间时：`activeReplyId = null`，进入新房间默认状态视图。

### 不要做的事

- 不要新增任何后端协议字段（`packages/hub`）来实现该功能；当前 `agent_event` + `role_progress` 已足够。如果发现确实需要，先在 issue 中讨论后再动 `protocol.ts`。
- 不要破坏现有 mention（`@role`）、PM 模式、sleep、queue 等流程。
- 不要让“切换子页签”重新发起 `client.prompt` / `client.abort`。
- 不要保留 8s 自动隐藏 sub-rows 的逻辑——该逻辑与新的“持久子页签”冲突。

## 受影响文件（预期）

- `packages/web/src/main.ts`
  - 重写：`renderRoomRows`、`renderRoleSubRows`、`updateRoomReplyRows`、`handleAgentEvent`、`updateRoleProgress`、`renderHistory` 调用点。
  - 新增：状态主体视图渲染器（如 `renderRoomStatusBoard()`），详情视图渲染器（复用现有 message 渲染）。
- `packages/web/src/style.css`
  - 新增：`.room-status-row`（状态条）、`.room-status-row.running/done/failed`、`.reply-detail-back-bar`。
  - 调整：`.room-reply-row` / `.room-role-sub-row` 视觉一致化（同一组子页签）。
- `packages/web/src/protocol.ts`：可能新增的内部类型导出（仅 web 端类型，不动协议）。

## 验收标准

1. 在一个含有 PM + 至少 1 个 worker role 的房间里发送 `@pm @worker 提交一下 git`：
   - 房间行下立刻出现 2~3 个子页签（房间名 / pm / worker）。
   - 主对话窗口默认只显示用户消息 + 3 行状态条，状态条按 phase 实时更新。
   - 点击 `worker` 子页签 → 主对话窗口切换为该 role 的完整输出，顶部出现返回栏。
   - 点击返回栏 → 回到状态主体视图，所有状态条仍在，且最新状态正确。
   - 完成后状态条显示摘要；子页签状态点变绿；子页签持续保留。
2. 切换到另一个房间再切回，状态主体视图正确恢复，已完成的子页签仍可点击查看历史详情。
3. 切换子页签**不会**触发任何 `prompt` / `abort` / `setStatus` 网络调用（用 DevTools 验证）。
4. 删除房间时，相关 reply 全部从内存中清除。
5. `npm run check` 通过。

## 实施建议

1. 先做数据层：把 `replyStore` 升级到上面的 `ReplyEntry` 形态，并把 `agent_event` / `role_progress` 路由到“写入 reply”而不是“直接 append 到 #messages”。
2. 再做渲染层：抽出 `renderRoomStatusBoard()` 和 `renderReplyDetail(replyId)` 两个纯渲染函数，由 `activeReplyId` 切换。
3. 最后调子页签 UI（左侧 Rooms 行下的稳定列表 + 状态点 + 标签）。
4. 全程保持 erasable TS（无 enum / 无参数属性），无 `any`，遵循根 `AGENTS.md`。
