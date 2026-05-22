# 房间 / 角色 / 重生 / 睡觉 当前实现说明

本文档梳理 pi-mono 现有 hub + web 端中"房间"、"角色"、"重生(rebirth)"、"睡觉(sleep)"四条逻辑链路的真实行为，并标记当前与产品直觉(UI 暗示)不一致的地方，作为后续修复的依据。

代码定位：

- 服务端：`packages/hub/src/hub-admin.ts`、`packages/hub/src/room.ts`、`packages/hub/src/role-orchestrator.ts`、`packages/hub/src/roles/memory-store.ts`
- 客户端：`packages/web/src/main.ts`、`packages/web/src/hub-client.ts`
- 协议：`packages/hub/src/protocol.ts`

---

## 1. 房间(Room)

### 1.1 数据模型

- 房间在 `RoomManager` / `RoomRegistry` 中以 `roomId` 唯一标识，落盘信息为 `{ roomId, title, createdAt, updatedAt }`。
- 每个"活跃房间"`ActiveRoom` 内含：
  - `session`：一个 `AgentSession`（含 `agent` 与 `sessionManager`），承载该房间的对话。
  - `clients`：当前已 `join` 的 WebSocket 客户端集合。
  - `roleOrchestrator`：负责 `@角色` 调度（计划模式 / 直接模式）。
- 房间消息保存在 `room.session.messages`，包括：
  - 普通的 user / assistant 消息；
  - `customType` 为 `hub_role_output` 的"角色产出"消息——由 `role-orchestrator.ts` 在每个角色任务结束后通过 `recordRoleMessage("hub_role_output", ...)` 写入；该消息的 `details.role` 携带角色名，`content` 形如 `[<role>] (completed|failed)\nTask: <task>\n\n<output>`。

### 1.2 房间切换

- web 端 `selectRoom(roomId)` 会 `client.join(roomId)`，服务端把当前 `messages` + 会话状态发回；房间列表由 `list_rooms` 拉取。
- 删除房间走 `delete_room`，会先 `broadcastRoomDeleted()` 通知所有客户端，再从注册表移除。

---

## 2. 角色(Role)

### 2.1 角色定义

- 角色文件存放在 `rolesConfig.rolesDir` 下，每个角色一份 markdown。
- `list_roles` / `get_role` / `save_role` / `delete_role` 走 `hub-admin.ts` 中的 `handleListRoles` 等，最终落到 `roles/role-store.ts`。
- 房间通过 `set_room_roles` 绑定一组角色名；`pmRole`（来自 `rolesConfig.pmRole`）是受保护角色，不可删除。

### 2.2 角色调度

`role-orchestrator.ts` 接收用户消息后：

- **计划模式**：`@pm` 出一份 JSON 计划，按拓扑分层；每层内并发，逐个 worker 执行 `runRole(...)`。每个任务完成后通过 `recordRoleMessage("hub_role_output", ...)` 写入房间消息流，附带 `details: { role, taskId, task, exitCode }`。最后再以 `synthesisMessage` 触发一次主 session prompt 做综合。
- **直接模式**：直接遍历 `mentionedWorkers`，对每个角色独立 `runRole`，同样写 `hub_role_output`。直接模式下**没有 `Task: ...` 那一行**，content 仅 `[<role>] (status)\n\n<output>`。

### 2.3 角色记忆(memory)

- 存储路径：`<cwd>/.pi/hub/memory/<roleName>.jsonl`，每行一条 `HubRoleMemory = { seq, ts, room, goal, result, roleName }`。
- 操作 API：`memory-store.ts` 提供 `loadRoleMemory / appendRoleMemory / deleteRoleMemory / clearRoleMemory`。
- WebSocket 命令：`get_role_memory`、`delete_role_memory`、`clear_role_memory` 仅供 UI 查看 / 维护。

### 2.4 不符合预期

1. **角色记忆从不被回灌到角色运行上下文。** `loadRoleMemory` 在整个仓库里只在两处被调用：`handleGetRoleMemory`（UI 查看）和 `handleSleepRoom`（写完后再读一次拿 `seq`）。`role-orchestrator.ts` 在执行 `runRole` 时不会把历史 memory 拼到 prompt/`contextPrefix` 里，所以"睡觉巩固出来的记忆"对未来的角色行为完全没有功能性影响——它只是一个历史档案。
2. **`appendRoleMemory` 的 `seq` 在删除后会冲突。** `seq` 由 `existing.length` 推导：若已存在 5 条且 seq=2 被删除（剩 1,3,4,5），下一条会拿到 `seq = 4 + 1 = 5`，与原 seq=5 重复。`delete_role_memory` 按 `seq` 过滤，后续删除会同时命中两条。

---

## 3. 重生(Rebirth)

### 3.1 触发链路

- web `lifeBtn` → 弹出 `lifePopup` → 点击"重生"。
- 客户端：`confirm("Clear all messages in this room?")` → `client.clearRoomSession(roomId)` → 本地 `purgeRoomReplies(roomId)`、清 `activeReplyId / currentTurnId`、`refreshMessagesPanel()`。
- 协议：`{ type: "clear_room_session", roomId }`。
- 服务端 `handleClearRoomSession`：
  1. 取 `room.session.agent.reset()`；
  2. `room.session.sessionManager.newSession()`；
  3. `room.sendClientUpdate()`：向所有 client 发 `joined`，`messages: []`。

### 3.2 不符合预期

1. **不是真正的"重生"，只是清空会话。** 角色记忆、角色配置、房间配置、`room.title`、绑定的角色列表都不动。如果用户的心智模型是"角色像 RPG 一样 die & respawn 到默认状态"，当前实现达不到。
2. **多客户端不同步本地副作用。** `purgeRoomReplies` / `activeReplyId` 重置只发生在点击"重生"的那个浏览器；其他已经 `join` 同一房间的 web 客户端只收到 `messages: []`，但本地 `roomReplies` map 中针对旧 turnId 的 reply row 仍保留，UI 出现"有回复行但没有原始消息"的悬挂态。
3. **没有 in-flight 检查。** 如果此刻 `agent` 正在 reply（`roomBusy === true`）或角色还在跑（`rolesBusy === true`），重生会直接 `agent.reset()`，正在写入的 `assistant` 消息和未结束的角色任务会被无声丢弃；`role-orchestrator.ts` 中的并发任务不会被显式取消，`hub_role_output` 仍会在新会话上 `recordRoleMessage` 写出，导致空房间里突然冒出旧任务的角色产出。
4. **"重生"在 UI 上挂在"生命"菜单里、并被标 `danger`，但实际危险面比按钮文字小。** 没有对角色记忆做任何处理，与"睡觉"形成的对比不直观——用户可能误以为重生 = 把记忆也抹掉。

---

## 4. 睡觉(Sleep)

### 4.1 触发链路

- web `lifePopup` 中的 `sleepItem`：`onclick` → `client.sleepRoom(roomId)`。
- 协议：`{ type: "sleep_room", roomId }`。
- 服务端 `handleSleepRoom`：
  1. 取 `room.session.messages`。
  2. **Phase 1 `extracting`**：`broadcastMessage({ type: "sleep_progress", phase: "extracting" })`。遍历 `messages`，挑出 `role === "custom" && customType === "hub_role_output" && details.role` 的条目，按角色拆分。
     - `goal = output.match(/Task:\s*(.+?)(?:\n|$)/)?.[1]?.trim() ?? output.slice(0, 80)`
     - `result = output.match(/(?:completed|failed)[\s\S]*/i)?.[0]?.trim() ?? output.slice(-200)`
     - `extracted.push({ ts: now, room: roomId, goal, result, roleName })`
  3. **Phase 2 `storing`**：广播 `phase: "storing"`。按 `roleName` 分组；每组内按 `goal` 去重（仅本次本组内）；逐组 `appendRoleMemory(...)`，再 `loadRoleMemory(...)` 后 `slice(-unique.length)` 收集"刚写入的部分"到 `allStored`。
  4. **Phase 3 `clearing`**：广播 `phase: "clearing"`，调用 `agent.reset()` + `sessionManager.newSession()` + `sendClientUpdate()`。
  5. 给发起方回 `sleep_room` 命令成功；广播 `{ type: "sleep_done", roomId, memories: allStored }`。

### 4.2 客户端反馈

- 发起方在请求开始时本地置 `isSleeping = true`，按钮文案 `Sleeping…`；收到 `sleep_progress` 把按钮文案切到 `Extracting…/Storing…/Clearing…`。
- `sleep_done`：弹 `Stored N memories for roles: ...` 或 `No memories extracted from this session.`（注意通过 `showError` 通道展示，文本是中性，但视觉上是错误条）。

### 4.3 不符合预期

1. **goal/result 抽取规则脆弱**：
   - 直接模式下 `hub_role_output` 内容里**没有 `Task:` 行**，所以所有直接模式产出的 `goal` 都退化成 `output.slice(0, 80)`——通常就是 `[<role>] (completed)\n\n<assistant 头几个字>`。
   - `result` 用 `/(?:completed|failed)[\s\S]*/i` 贪婪匹配。由于第一行就是 `[<role>] (completed)`，`result` 几乎总是从 `completed)` 开始一路抓到 output 末尾——本意应该是"结果摘要"，实际近似全文。
2. **去重只在本次 sleep + 本角色 + 完全相同 goal 的范围内生效**：跨次 sleep、跨房间、或 goal 截断后只差 1 个字符都会重复入库，并且因为 1.4.2 提到的 `seq` 缺陷，被删除过的角色 jsonl 还会出现 seq 冲突。
3. **没有"是否真的要睡觉"的二次确认**：相比"重生"有 `confirm(...)`，"睡觉"在最后一步会 `agent.reset()` + `newSession()`——同样是会清空会话——但点了就直接执行。
4. **没有 in-flight 保护**：同 §3.2.3。`canSleep()` 只看本客户端自己观察到的 `roomBusy / rolesBusy / isSleeping`，但 `sleep_room` 在服务端没有任何幂等/忙碌检查，多个 client 几乎同时点都会被执行，第二次进入时 `messages` 已经被前一次清空，于是 `extracted` 为空、广播 `sleep_done` 且 `memories: []` —— 用户看到 `No memories extracted`，并不知道是被另一个 client 先睡了。
5. **三阶段广播是"伪进度"**：`extracting → storing → clearing` 之间没有任何异步等待，全部同步走完再把三条消息按顺序排队发送；UI 可能根本来不及显示前两个阶段。
6. **`sendClientUpdate` 推送 `messages: []`，但和重生一样**：其他客户端的本地 `roomReplies`、`activeReplyId`、`currentTurnId` 不会被清。
7. **"睡觉"在产品语义上暗示"巩固记忆 → 醒来后角色更聪明"，但如 §2.4.1 所述，记忆从不回灌到角色 prompt**：所以"睡觉"目前只完成"提取 + 落盘 + 清空会话"三件事，唯一的"被使用"路径是用户自己在 UI 里翻 memory 列表。
8. **`sleep_done` 的 UI 反馈走 `showError`**：成功汇报和错误共用同一个红色 banner，体验上误导。
9. **`isSleeping` 的解锁路径**：发起方依赖 `await client.sleepRoom(...)` 的 `finally` 解锁；如果在等待期间 WebSocket 断开 / 收到 `room_deleted`，按钮可能永久停在 `Sleeping…`。其他 client 的 `sleepItem` 在整个过程中并未被锁，可以重复点击触发 §4.3.4 的竞态。

---

## 5. 总结：与产品直觉不一致的关键点

| 区域 | 当前实现 | 直觉/UI 暗示 |
| --- | --- | --- |
| 角色记忆 | 仅在 `/memory` 视图展示，从不喂回角色运行 | "睡觉"应让角色长期记忆生效 |
| 重生 | 清空当前 session.messages | "把房间/角色重置回初始状态" |
| 睡觉 | 抽取 `hub_role_output` → 落 jsonl → 清会话 | "总结 + 沉淀长期记忆 + 醒来更强" |
| 抽取规则 | 直接模式下 goal/result 几乎是原文截断 | 至少应是任务/结论的摘要 |
| 并发安全 | rebirth/sleep 都不检查 in-flight，sleep 服务端无互斥 | 忙碌时按钮应禁用或排队 |
| 多客户端同步 | 仅服务端推 `messages: []`，本地 reply 索引不清 | 所有 client 的 UI 应一致 |
| 进度反馈 | `sleep_progress` 三阶段同步连发 | 真实分步进度 |
| 成功提示通道 | `sleep_done` 复用错误 banner | 应区分 success / error |
| seq 分配 | `seq = existing.length`，删除后会冲突 | 单调递增、永不复用 |

后续修复建议优先级（建议顺序，但本文档不展开方案）：

1. 让 `runRole` 在执行前 `loadRoleMemory(roleName)` 并注入 `contextPrefix`，让"睡觉"真正产生功能性收益。
2. 修 `appendRoleMemory` 的 `seq` 算法，改为"取现存最大 seq + 1"。
3. 服务端 `handleSleepRoom` / `handleClearRoomSession` 在 `roomBusy || rolesBusy` 时拒绝或排队，并在执行前广播 `activity` 进入 `sleeping` 锁定所有 client UI（`HubActivityPhase` 已有 `"sleeping"` 但目前没人发）。
4. 抽取规则改为基于 `details`（`task`、`exitCode`）而不是正则猜内容；直接模式补 `Task:` 前缀或在 `details.task` 里冗余存。
5. 区分 `sleep_done` 的成功/失败展示通道；为"重生"和"睡觉"统一加二次确认。
6. `sendClientUpdate` 之后客户端对应清掉本地 `roomReplies / activeReplyId / currentTurnId`。
