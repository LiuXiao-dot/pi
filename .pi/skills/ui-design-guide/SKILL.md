---
name: ui-design-guide
description: Marvis 风格的 UI 设计指南。提供配色、字体、布局、组件、交互动效、插画与吉祥物使用规范。当需要设计或实现极简白底 + 单一暖色点缀 + 友好吉祥物风格的桌面端 / Web 应用界面时使用。
---

# Marvis UI 设计指南

一套受「Marvis」桌面助手启发的设计语言：**极简白、强对比黑、单一暖色点缀、友好吉祥物**。当用户要求实现这种风格的界面、组件、原型或品牌物料时，按本指南执行。

## 1. 设计原则

1. **白纸感**：大面积纯白背景，靠留白而非分隔线建立层次。
2. **强对比**：纯黑用于核心动作、选中态、标题；灰阶承载次要信息。
3. **单一暖色**：橙红色仅用于品牌点缀（吉祥物围巾、Logo 局部），不参与功能配色。
4. **拟人友好**：用吉祥物 + 剧情化文案替代冷冰冰的 loading / empty state。
5. **大圆角 + 胶囊**：卡片大圆角、按钮胶囊化，避免锐利直角。
6. **少即是多**：图标线条化、单色、不堆叠装饰。

---

## 2. 设计 Tokens

### 2.1 颜色

```css
:root {
  /* 中性 */
  --bg:            #FFFFFF;
  --bg-elevated:   #FAFAFA;   /* 卡片底 */
  --bg-muted:      #F2F2F3;   /* 输入框 / 次要卡片 */
  --bg-hover:      #EDEDEE;

  --fg:            #0A0A0A;   /* 主文本 / 主按钮底 */
  --fg-secondary:  #5C5C62;   /* 次要文本 */
  --fg-tertiary:   #9A9AA0;   /* 占位符 / 辅助 */
  --border:        #E6E6E8;

  /* 品牌点缀色 —— 仅用于 logo / 吉祥物 / 极少装饰，不用于按钮 */
  --brand-accent:  #FF4D2E;   /* 围巾橙红 */
  --brand-accent-soft: #FFE4DC;

  /* 状态色（用于 Agent 角色徽标等少数场景） */
  --success:       #2ECC71;   /* 绿围巾 = Browser/Computer Agent */
  --warning:       #F5A623;
  --danger:        #E5484D;
}
```

**配色铁律：**
- 主操作按钮一律 `--fg` 黑底白字，**不要**用品牌橙做按钮。
- 品牌橙出现频率应 ≤ 整屏 2%。
- 不使用渐变；阴影替代分隔线。

### 2.2 字体

- 字体栈（中英混排）：
  ```css
  font-family:
    "Inter", "PingFang SC", "HarmonyOS Sans SC",
    "Microsoft YaHei", system-ui, sans-serif;
  ```
- 字重梯度：`400 / 500 / 700`（标题用 700，少量场景可用 800/900 让 Logo "Marvis" 更厚重）。
- 类型尺度：

| Token        | size / line-height | 用途                  |
|--------------|--------------------|-----------------------|
| `--t-display`| 28 / 36, 700       | 页面主标题（Marvis）  |
| `--t-h1`     | 20 / 28, 700       | 区块标题（与Marvis的对话）|
| `--t-h2`     | 16 / 24, 600       | 卡片标题              |
| `--t-body`   | 14 / 22, 400       | 正文                  |
| `--t-meta`   | 13 / 20, 400       | 副文 / 描述           |
| `--t-label`  | 12 / 16, 500       | 侧栏分组小标题（本地知识库 / 对话），常配 `--fg-tertiary` |

### 2.3 间距 / 圆角 / 阴影

```css
:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;

  --radius-sm:   8px;   /* 小控件 */
  --radius-md:   12px;  /* 输入框、侧栏项 */
  --radius-lg:   16px;  /* 卡片 */
  --radius-xl:   24px;  /* 大对话框 */
  --radius-pill: 999px; /* 胶囊按钮 / 搜索框 / chip */

  --shadow-card:  0 1px 2px rgba(0,0,0,.04), 0 4px 16px rgba(0,0,0,.04);
  --shadow-modal: 0 8px 40px rgba(0,0,0,.10);
}
```

### 2.4 动效

```css
:root {
  --ease-out:    cubic-bezier(.16,1,.3,1);
  --ease-in-out: cubic-bezier(.65,0,.35,1);
  --dur-fast:   120ms;
  --dur-base:   200ms;
  --dur-slow:   400ms;
}
```

时长规则：hover/press 用 `--dur-fast`；面板/模态出现用 `--dur-base`；剧情化插画用 `--dur-slow` 以上。

---

## 3. 布局骨架

桌面端三段式：

```
┌──────────────┬──────────────────────────────────────────┐
│              │                                    🔔 — □ × │
│   Sidebar    │                                              │
│   240px      │           Main canvas (居中、白底)            │
│              │                                              │
│              │                                              │
│  [account]   │                                              │
└──────────────┴──────────────────────────────────────────┘
```

- **侧边栏**：宽 240px，背景同主区域（无分隔线），靠间距/对齐分区。
- **主区域**：内容**整体水平居中**，最大宽度 ~720–960px。不要左对齐贴边。
- **窗口控件**：右上角 通知 🔔 / 最小化 / 最大化 / 关闭，无背景，hover 才显示底色。
- **底部状态条**（如加载页）：极细 1–2px 黑色进度，右侧百分比小字。

### 3.1 侧边栏结构（自上而下）

1. Logo 文字（"Marvis"，display 字号，700/900）
2. 搜索框：胶囊形，浅灰底 `--bg-muted`，前置 🔍 icon
3. 主导航（新建对话 / 自动任务 / 技能广场）—— 选中项**纯黑填充 + 白字白图标**，圆角 12px
4. 分组小标题（如 `本地知识库`）：`--t-label` + `--fg-tertiary` + 间距上 24px
5. 子项（应用 / 文档 / 图库 / 此电脑）：左 icon + 文字 + 右展开箭头
6. 另一个分组 `对话`：列出最近会话
7. 底部：账号头像 + 用户名 + 设备/手机入口图标

---

## 4. 核心组件

### 4.1 按钮

```css
.btn {
  height: 40px;
  padding: 0 20px;
  border-radius: var(--radius-pill);
  font: 500 14px/1 var(--font);
  display: inline-flex; align-items: center; gap: 8px;
  transition: background var(--dur-fast) var(--ease-out),
              transform  var(--dur-fast) var(--ease-out);
}
.btn-primary   { background: var(--fg); color: #fff; }
.btn-primary:hover  { background: #222; }
.btn-primary:active { transform: scale(.98); }

.btn-ghost     { background: transparent; color: var(--fg); }
.btn-ghost:hover { background: var(--bg-hover); }
```

- **主按钮**：黑色胶囊，文字 13–14px，左右内边距大（≥20px），给人"被强调"的感觉（参考登录按钮）。
- **图标按钮**（如发送）：40×40 圆形，黑底白色箭头 ↑。
- **快捷卡片右下角的 ↑**：指示"点这个发送到对话"，hover 时圆形描边出现。

### 4.2 输入框 / 任务输入区

- 单行搜索：胶囊形，背景 `--bg-muted`，无边框，placeholder 13px 灰。
- 主任务输入区（首屏中央）：**大圆角矩形（lg）**、浅灰底、内置：
  - 顶部行：placeholder "请输入任务，交给我来帮你完成"
  - 底部行：`+ 选择文件` 胶囊按钮（ghost）+ 右下角黑色圆形发送按钮
- 焦点态：`box-shadow: 0 0 0 3px rgba(0,0,0,.06)`，不要用蓝色 outline。

### 4.3 卡片（推荐任务）

- 3 列等宽，间距 16px。
- 圆角 `--radius-lg`，背景 `--bg-elevated`，无边框，hover 升高：
  ```css
  .card { transition: transform var(--dur-base) var(--ease-out),
                      box-shadow var(--dur-base) var(--ease-out); }
  .card:hover { transform: translateY(-2px); box-shadow: var(--shadow-card); }
  ```
- 内容：标题（前可附小 icon，如 📄 红色）+ 2 行描述（灰）+ 右下角 ↑。
- 顶部可放横向 tabs（推荐 / 办公学习 / 电脑设置 / 生活日常 / 游戏娱乐）：纯文字 + 选中态加粗变黑，未选中灰。

### 4.4 对话气泡

- **用户气泡**：浅灰圆角矩形（`--bg-muted`，radius lg），右对齐，最大宽 70%。
- **助手消息**：左对齐，**头像方块**（48px，圆角 12，吉祥物头像）+ 名称粗体 + 下方独立气泡。
- 气泡下方一行小图标：复制 / 👍 / 👎，灰色描线，hover 变黑。
- 底部小字提示："以上内容由AI生成"，居中，`--fg-tertiary`。

### 4.5 模态 / 设置面板

- 居中浮层，圆角 `--radius-xl`，`--shadow-modal`，背景纯白。
- 背后遮罩：**白色 70% 透明**（不是黑色！），保持轻盈感。
- 双栏结构：左 ~220px 菜单列表（选中项胶囊填浅灰 + 黑字 + 前置图标），右内容区。
- 右上 `×` 关闭，无背景按钮。

### 4.6 侧栏导航项

```css
.nav-item {
  display: flex; align-items: center; gap: 12px;
  height: 40px; padding: 0 14px;
  border-radius: var(--radius-md);
  color: var(--fg);
  transition: background var(--dur-fast) var(--ease-out);
}
.nav-item:hover    { background: var(--bg-hover); }
.nav-item.active   { background: var(--fg); color: #fff; }
.nav-item.active svg { color: #fff; }
```

### 4.7 进度 / 加载

- 顶级 loading 不用 spinner 占满屏，而是：
  - **中央插画** + 一句剧情化文案（"正在准备入职"、"模型准备中，预计还需要2分钟"）
  - **底部 2px 黑色进度条**，右下角百分比 `28%` 小字
  - 插画周边可加浮动文字粒子（"token+1"）做向上飘浮 + 淡出动效

---

## 5. 图标

- 线条 1.5–2px，圆角端点，统一 24×24 viewbox。
- 单色 `currentColor`，跟随父级文字色（选中变白即可）。
- 推荐集：Lucide / Tabler / Phosphor (regular weight)。
- 不要混用填充与线条风格；同一界面只用一套。
- 极少数情况允许小尺寸彩色 icon 作为卡片标题前缀（如红色 PDF），但要克制。

---

## 6. 吉祥物 Marvis

- 形象：黑色卡通马/独角兽，**红橙围巾** 是唯一识别色。
- 用途场景：
  - 启动 / loading（喝咖啡等待）
  - 助手消息头像
  - 空状态（登录查看历史对话…）
  - 品牌主视觉（首屏标题旁）
- **不要**：把吉祥物用作功能性按钮；不要给它穿其他颜色围巾（除非表示不同 Agent，例：绿围巾 = Browser/Computer Agent）。
- 多 Agent 拓展：通过**围巾颜色 + Agent 名称浮标**区分角色，身体形态保持一致。

### 6.1 3D 场景插画

- 风格：极简全白办公空间，物体单色白 + 极淡阴影，**唯一彩色**是吉祥物围巾和电脑屏幕。
- 视角：轻微俯视 / 等距 (isometric ≈ 30°)。
- 用途：办公室总览页（展示 Agent 协作）、引导页、空状态。
- 落地实现选择：
  - Three.js / React Three Fiber 渲染 glTF
  - 或直接预渲染 PNG/WebP（更省性能，首推）
  - 或 Rive / Lottie 做轻量动效

---

## 7. 微交互 & 动效

| 场景            | 动效                                                        |
|-----------------|-------------------------------------------------------------|
| 按钮 hover      | 背景色 fade 120ms                                           |
| 按钮 press      | `scale(.98)` 120ms                                          |
| 卡片 hover      | `translateY(-2px)` + shadow 200ms ease-out                  |
| 模态出现        | opacity 0→1 + scale .96→1，200ms ease-out                   |
| 侧栏选中切换    | 背景色滑动（可用 `layoutId` / FLIP 技术）                   |
| 发送消息        | 输入框文本 fade-up 成气泡，发送按钮短暂 pulse               |
| Loading 文案    | 文案每 4–6s 切换一句，淡入淡出                              |
| Token+1 粒子    | 从吉祥物处随机 y 轴上飘 60–100px，opacity 1→0，800ms ease-out|
| 进度条          | width transition 400ms linear                               |

避免：弹跳过强的 spring、彩色霓虹光晕、高频闪烁。

---

## 8. 文案风格

- 友好克制，少叹号，无 emoji 滥用。
- 剧情化 loading："正在准备入职"、"马维斯 为你24小时随时在线"。
- 空状态用引导而非报错："登录后开启完整体验" + 一颗黑色胶囊"登录"按钮。
- 标题可口语化，描述保持信息密度（参考首屏推荐卡片副文：直陈做什么 + 输出形式）。

---

## 9. 无障碍

- 文本对比度 ≥ 4.5:1（主文本 #0A0A0A on #FFF 远超标准）。
- 焦点环：`outline: 2px solid var(--fg); outline-offset: 2px;`，不要去掉 outline。
- 所有图标按钮配 `aria-label`。
- 动效尊重 `prefers-reduced-motion`：将位移类动画退化为 opacity。

---

## 10. Do / Don't 速查

**Do**
- 大留白、居中布局、胶囊按钮、黑底主按钮
- 吉祥物 + 剧情化文案做空 / 加载态
- 卡片靠 hover 微抬 + 阴影提示可点击
- 分组靠灰色小标签而非分隔线

**Don't**
- 不用蓝色品牌色 / 不用渐变背景 / 不用彩色按钮
- 不在主操作区使用品牌橙
- 不堆叠多种圆角半径（最多 3 种：sm/md/lg + pill）
- 不用 1px 灰色分隔线把界面切成方格

---

## 11. 应用清单（Checklist）

复制下面这份清单，在交付前逐项核对：

```
[ ] 主背景为纯白 / 极浅灰，无渐变
[ ] 主按钮黑底白字胶囊形
[ ] 品牌橙仅出现在 logo / 吉祥物 / ≤2% 区域
[ ] 侧栏选中项黑色填充
[ ] 卡片圆角 ≥ 12px，hover 有上抬
[ ] 输入框无边框，focus 用浅阴影而非蓝色 outline
[ ] 模态遮罩为白色半透明
[ ] Loading 配剧情文案 + 吉祥物
[ ] 至少 1 处剧情化空 / 加载状态
[ ] 文案中文标点，无中英文之间多余空格混乱
[ ] 焦点环可见，支持 prefers-reduced-motion
```

---

## 12. 快速起手代码

最小 HTML demo：

```html
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<title>Marvis Demo</title>
<style>
  /* 粘贴第 2 节的 :root tokens */
  body { margin: 0; font-family: "Inter","PingFang SC",system-ui,sans-serif;
         background: var(--bg); color: var(--fg); }
  .app { display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; }
  .side { padding: 24px 16px; }
  .brand { font-weight: 800; font-size: 28px; margin: 0 0 24px; }
  .search { width: 100%; height: 36px; border: 0; border-radius: 999px;
            background: var(--bg-muted); padding: 0 16px; }
  .nav { list-style: none; padding: 0; margin: 16px 0; }
  .nav li { display: flex; align-items: center; gap: 12px;
            height: 40px; padding: 0 14px; border-radius: 12px; cursor: pointer; }
  .nav li.active { background: var(--fg); color: #fff; }
  .main { display: flex; flex-direction: column; align-items: center;
          padding: 80px 24px; }
  .hero { font-size: 28px; font-weight: 800; margin: 0 0 32px; }
  .composer { width: min(720px, 100%); background: var(--bg-muted);
              border-radius: 16px; padding: 16px; }
  .composer input { width: 100%; border: 0; background: transparent;
                    font: 400 14px/1.6 inherit; outline: none; }
  .send { width: 40px; height: 40px; border-radius: 50%; border: 0;
          background: var(--fg); color: #fff; float: right; cursor: pointer; }
</style>
</head>
<body>
  <div class="app">
    <aside class="side">
      <h1 class="brand">Marvis</h1>
      <input class="search" placeholder="搜索" />
      <ul class="nav">
        <li class="active">💬 新建对话</li>
        <li>⏱  自动任务</li>
        <li>🔧 技能广场</li>
      </ul>
    </aside>
    <main class="main">
      <h2 class="hero">Marvis</h2>
      <div class="composer">
        <input placeholder="请输入任务，交给我来帮你完成" />
        <button class="send" aria-label="发送">↑</button>
      </div>
    </main>
  </div>
</body>
</html>
```

---

## 13. 当用户请求时你应该做什么

1. **若用户描述模糊**（"做个像 Marvis 的页面"）：先确认平台（桌面端 / Web / 移动端）、技术栈（HTML/CSS、React、Vue、Tailwind…）、需要哪些页面（首屏 / 设置 / 对话 / 加载）。
2. **生成代码时**：始终先输出 token（CSS variables 或 Tailwind config），再输出组件。
3. **吉祥物素材缺失时**：用占位 emoji（🐴 + 红围巾说明），并在交付清单里标注"待替换 mascot 资源"。
4. **完成后**：用第 11 节 checklist 自检并报告通过情况。
