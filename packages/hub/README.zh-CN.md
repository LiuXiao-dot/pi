# @earendil-works/pi-hub

面向 [pi](https://pi.dev) 编码代理会话的 **局域网 WebSocket 协作中枢**。同一网络内的多个浏览器可加入同一 **房间（room）**，共享同一条代理流式输出，并通过 **串行提示队列** 轮流向代理发指令。

配套 Web 客户端：[@earendil-works/pi-web](../web)。

---

## 核心功能

| 能力 | 说明 |
|------|------|
| **多客户端协作** | 多个浏览器通过 WebSocket（`/ws`）加入同一房间，实时看到相同的 `agent_event` 流。 |
| **串行提示队列** | `prompt` / `steer` / `follow_up` 入队后依次执行，避免并发改写同一会话。 |
| **在线状态** | `presence` 广播房间内成员；`activity_update` 显示当前操作者与代理阶段（空闲、回复、思考、工具、压缩等）。 |
| **共享工作区** | Hub 在配置的 `cwd` 上运行 pi 工具（bash、read、write、edit 等），所有持 token 的客户端影响同一目录。 |
| **扩展 UI 路由** | 阻塞式扩展交互（选择、确认、输入等）转发给 **当前队列轮次** 的客户端处理。 |
| **模型与代理端点** | 房间内共享模型选择；可设置 OpenAI 兼容 **Base URL**；支持 `hub.json` 模型目录与按角色默认模型。 |
| **多角色编排（可选）** | PM 子进程拆任务 → 多角色 worker 子进程并行执行 → 主会话汇总回复；计划与产出写入会话（`hub_role_plan` / `hub_role_output`），并注入房间近期上下文。 |
| **房间注册表** | `create_room` / `delete_room` / `list_rooms`；每房间独立 JSONL 会话，重启 Hub 后可恢复。 |
| **角色库** | 全局 `.pi/roles/`（Web「Role library」），与房间无关。 |
| **房间角色** | 每房间 `config.json` 的 `roleNames` 从角色库勾选添加，不可重复；编排仅使用已选角色（须含 PM 与至少一个 worker）。 |
| **房间配置** | 每房间可选 skills、rules、`rolesEnabled`；`roleOverrides` 仅对已选角色生效。 |
| **静态 Web UI** | HTTP 服务（默认 `3141`）：登录 → 房间列表（类似会话列表）→ 进入房间聊天；房间内可返回列表切换房间。 |

### 架构要点

- **RoomManager / Room**：按 `roomId` 隔离会话；每房间一个 pi 编码代理会话与一条 `PromptQueue`。
- **WsHub**：鉴权、消息分发、队列所有权、广播与扩展 UI 目标客户端。
- **RoleOrchestrator**（`roles.enabled`）：调用独立 `pi` 子进程执行 PM 规划与各角色任务，最后在主会话合成答复。

---

## 安全说明

- 仅适用于 **可信局域网**；默认不提供 TLS。
- 加入房间必须提供共享 **token**。
- 持有 token 的客户端可驱动 Hub 对工作目录执行工具；请妥善保管 token 与仓库内的 `.pi/roles/` 配置。

---

## 快速开始（pi-mono 仓库）

在仓库根目录执行（无需全局安装 `pi-hub`）：

```bash
npm run hub:init          # 在当前目录生成 .pi/hub.json（含随机 token）
npm run hub               # 按需构建后启动
```

PowerShell：

```powershell
npm run hub:init
npm run hub
# 或
.\scripts\pi-hub.ps1
```

浏览器打开 `http://localhost:3141`（局域网其他设备可用 `http://<本机局域网 IP>:3141`）。使用配置中的 **token** 与 **房间 ID**（默认：`default`）。

---

## 配置

配置按优先级合并（后者覆盖前者）：

1. `~/.pi/hub.json` — 用户级默认
2. `<cwd>/.pi/hub.json` — 项目级（推荐）
3. `--config <path>` 或 `PI_HUB_CONFIG`
4. CLI 参数（`--token`、`--port` 等）
5. 环境变量（`PI_HUB_TOKEN`、`PI_HUB_PORT` 等）

生成模板：

```bash
pi-hub init                 # 当前目录 .pi/hub.json
pi-hub init --global        # ~/.pi/hub.json
npm run hub:init            # 同上（在仓库根目录）
```

示例见 [hub.json.example](./hub.json.example)：

```json
{
  "token": "your-long-random-secret",
  "port": 3141,
  "host": "0.0.0.0",
  "cwd": "E:\\path\\to\\your\\project",
  "defaultRoomId": "default"
}
```

### 环境变量

| 变量 | 用途 |
|------|------|
| `PI_HUB_TOKEN` | 加入 token |
| `PI_HUB_PORT` | 监听端口 |
| `PI_HUB_HOST` | 绑定地址 |
| `PI_HUB_CWD` | 代理工作目录 |
| `PI_HUB_SESSION` | 会话 JSONL 路径 |
| `PI_HUB_DEFAULT_ROOM` | 默认房间 id |
| `PI_HUB_CONFIG` | 额外配置文件路径 |

`PI_HUB_TOKEN` 会覆盖 `.pi/hub.json` 中的 `token`。若 Web UI 显示 **Invalid token** 但文件中的 token 正确，请检查当前 shell 是否仍设置了 `PI_HUB_TOKEN`：

```powershell
Remove-Item Env:PI_HUB_TOKEN -ErrorAction SilentlyContinue
npm run hub
```

启动时 pi-hub 会记录 token 来源（配置文件或环境变量），并打印末四位便于核对。

### CLI

```bash
cd packages/hub && npm run build
node dist/cli.js --token your-secret --cwd /path/to/project
# 或
npx pi-hub --help
```

| 命令 | 说明 |
|------|------|
| `pi-hub` | 启动服务 |
| `pi-hub init` | 写入配置模板 |
| `pi-hub help` | 显示帮助 |

### 根目录 npm 脚本

| 脚本 | 说明 |
|------|------|
| `npm run hub` | 按需构建并启动 |
| `npm run web:build` | 仅构建 Web UI |
| `npm run hub:build` | 构建 Web UI + hub |
| `npm run hub:init` | 创建 `.pi/hub.json` |

---

## Web UI：模型与 API 端点

连接房间后：

1. **Model** 下拉框切换共享会话模型（与 `get_available_models` 列表一致）。
2. **API endpoint** 可设置某提供商的 **Base URL**（如 OpenAI 兼容代理），点击 **Apply URL** 后房间内所有客户端生效。

持久化提供商 URL 也可在运行 Hub 的机器上配置 `~/.pi/agent/models.json`（见 [coding-agent models.md](../coding-agent/docs/models.md)）。API Key 仍来自 Hub 主机上的 `/login` 或环境变量，**不会**通过 Web UI 下发。

---

## 模型目录（Web UI 下拉框）

在 `.pi/hub.json` 中配置：

```json
{
  "models": {
    "catalog": [
      "anthropic/claude-opus-4-7",
      "openai/gpt-5.4"
    ],
    "session": "anthropic/claude-opus-4-7",
    "roleModels": {
      "pm": "anthropic/claude-sonnet-4-5",
      "developer": "anthropic/claude-opus-4-7"
    }
  }
}
```

| 字段 | 用途 |
|------|------|
| `catalog` | Web UI 所有下拉框中的模型列表（`provider/modelId`）。省略或 `[]` 表示展示注册表中已配置鉴权的全部模型。 |
| `session` | 共享房间会话的默认模型（含汇总回复）；Hub 启动时应用。 |
| `roleModels` | 各角色子进程的默认模型；可在 Web UI **Role models** 中修改并写回 `hub.json`。 |

相关 WebSocket 命令：`get_models_config`、`set_role_model`，以及已有的 `get_available_models`、`set_model`（受 catalog 过滤）。

---

## 多角色编排

在 `.pi/hub.json` 中启用：

```json
{
  "roles": {
    "enabled": true,
    "rolesDir": ".pi/roles",
    "pmRole": "pm",
    "maxParallel": 4
  }
}
```

将 [`roles.example/`](./roles.example/) 中的示例复制到 `<cwd>/.pi/roles/`（至少需 `pm.md` 与若干 worker 角色，如 `developer.md`）。

每个角色为一个带 YAML frontmatter 的 Markdown 文件：

| 字段 | 用途 |
|------|------|
| `name` | 角色 id |
| `description` | 简短摘要（必填） |
| `who` | 是谁（可选；PM 按房间 roster 分配时展示） |
| `can` | 能做什么（可选） |
| `when` | 何时应把任务分给该角色（可选） |
| `model` | 子进程 `pi --model` 参数 |
| `tools` | 逗号分隔的工具白名单 |
| `skills` | 逗号分隔的技能名（解析自 `.pi/skills/` 或 `~/.pi/agent/skills/`） |
| `rules` | 可选规则文件路径；否则 Markdown 正文作为 system 补充 |

用户级角色：`~/.pi/agent/roles/`；项目级 `.pi/roles/` 同名覆盖。

启用后，每条入队 `prompt` 的处理流程：

1. **PM 子进程** — 仅根据**本房间已选 worker** 的 roster（Who / Can do / When）分配任务；不知道全局角色库。输出单行 JSON 计划（`tasks`、`uncovered`）。
2. **Worker 子进程** — 按任务执行（遵守 `dependsOn`，并行度不超过 `maxParallel`）。
3. **主 Hub 会话汇总** — 向房间返回一条助理消息。

无角色覆盖的工作通过 `role_gap` 广播给所有客户端（不阻塞执行）。

**注意：** `.pi/roles/` 与项目 agent 一样由仓库控制，仅在可信仓库启用。**成本：** 一条用户消息可能触发多个 `pi` 子进程再加一轮汇总。

---

## 房间持久化

- 索引：`<cwd>/.pi/hub/rooms.json`
- 每房间：`<cwd>/.pi/hub/rooms/<roomId>/session.jsonl`、`config.json`，可选 `skills/` 目录
- 须先 `create_room` 再 `join`（启动时若注册表为空会自动创建 `defaultRoomId`）
- `delete_room` 默认删除房间目录（会话不可恢复）

## WebSocket 协议概要

路径：`/ws`

### Hub 级（仅需 token，无需 join）

| 类型 | 说明 |
|------|------|
| `list_rooms` | 列出房间 |
| `create_room` | 创建房间 |
| `delete_room` | 删除房间（默认删数据） |
| `get_room_config` / `set_room_config` | 读写房间 skills/rules/roleNames/roleOverrides |
| `add_room_role` / `remove_room_role` / `set_room_roles` | 向房间添加/移除/整表设置角色（不可重复） |
| `list_roles` / `get_role` / `save_role` / `delete_role` | 角色 Markdown CRUD |

### 客户端 → Hub（join 之后）

| 类型 | 说明 |
|------|------|
| `join` | `roomId`、`token`、`displayName`（房间须已创建） |
| `prompt` / `steer` / `follow_up` | 提交消息（可带图片）；入队执行 |
| `abort` | 中止当前或指定任务 |
| `get_state` | 获取会话状态 |
| `get_available_models` / `set_model` | 查询/设置共享模型 |
| `get_models_config` / `set_role_model` | 模型目录与按角色模型 |
| `set_provider_base_url` | 设置提供商 Base URL |
| `extension_ui_response` | 响应扩展 UI 请求 |

### Hub → 客户端

| 类型 | 说明 |
|------|------|
| `joined` | 加入成功，含初始状态与消息 |
| `presence` | 成员列表 |
| `queue_update` | 队列 pending / current |
| `agent_event` | 代理事件流（含 `hostDisplayName`） |
| `activity_update` | 活动阶段与操作者 |
| `state_update` | 模型或配置变更后的会话状态 |
| `extension_ui_request` | 需指定客户端处理的扩展 UI |
| `role_plan` / `role_progress` / `role_gap` | 多角色编排状态（启用 roles 时） |
| `command_result` / `error` | 命令结果或错误 |

### 典型流程

1. 客户端发送 `join`。
2. Hub 回复 `joined` 并广播 `presence`。
3. 客户端发送 `prompt`、`steer` 或 `follow_up`；Hub 串行执行。
4. Hub 广播 `agent_event` 与 `activity_update`。
5. 阻塞式扩展 UI 路由到当前队列轮次客户端。
6. 模型相关命令成功后广播 `state_update`。
7. 启用 roles 时额外广播 `role_plan`、`role_progress`、`role_gap`。

---

## 开发与测试

```bash
cd packages/hub
npm run build
npm test
```

程序化启动见导出 API：`startHubServer`、`Room`、`PromptQueue`、`WsHub` 等（`src/index.ts`）。

---

## 相关包

| 包 | 说明 |
|----|------|
| [@earendil-works/pi-coding-agent](../coding-agent) | 编码代理 CLI 与会话运行时 |
| [@earendil-works/pi-web](../web) | 浏览器客户端（Hub 构建时一并打包静态资源） |

英文文档：[README.md](./README.md)

## 许可证

MIT
