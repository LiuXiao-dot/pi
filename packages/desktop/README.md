# pi Desktop — Electron 桌面应用

## 新增文件：`packages/desktop/`

| 文件 | 用途 |
|------|------|
| `package.json` | Electron 42 + electron-builder + electron-updater |
| `tsconfig.json` | TypeScript 配置 |
| `scripts/build.mjs` | esbuild 构建主进程 + preload + 复制 Web UI |
| `electron-builder.yml` | NSIS 安装包 + GitHub Release 发布 |
| `src/main.ts` | Electron 主进程：首次配置向导 → 启动 hub → BrowserWindow |
| `src/preload.ts` | contextBridge 暴露 clipboard + IPC |
| `src/tray.ts` | 系统托盘：显示/退出/LAN 地址 |
| `src/updater.ts` | electron-updater：检查→提示下载→重启安装 |
| `src/types.d.ts` | `@earendil-works/pi-hub` 类型声明 |
| `.gitignore` | dist/ release/ |

## 架构

```
双击 pi-hub.exe
  ├── 首次运行 → 生成 token + 展示配置窗口 → 用户点"启动"
  └── 后续运行 → 直接启动
        ├── import startHubServer() 启动 hub (0.0.0.0:3141)
        ├── BrowserWindow 加载 http://127.0.0.1:3141
        ├── 系统托盘图标 + 菜单
        └── 其他设备浏览器访问 http://<LAN IP>:3141
```

## 根 package.json 新增脚本

| 命令 | 说明 |
|------|------|
| `npm run desktop:build` | 构建 web + hub + desktop |
| `npm run desktop:dist` | 构建 + 打包 NSIS 安装器 |
| `npm run desktop:start` | 构建 + 启动开发模式 |

## 使用方式

```powershell
# 开发模式运行
npm run desktop:start

# 打包 .exe 安装器
npm run desktop:dist
# 产物在 packages/desktop/release/pi-hub Setup x.x.x.exe
```

## 待完成事项（发布前）

1. **图标** — 需要制作 `icon.ico`（安装包图标）和 `tray-icon.png`（托盘图标），放到 `src/assets/`
2. **GitHub Token** — 发布时需要 `GH_TOKEN` 环境变量，electron-builder 自动上传到 GitHub Releases
3. **Code signing** — 跳过签名时 SmartScreen 会有警告，后续购买证书后在 `electron-builder.yml` 配置
4. **API key** — 用户需要在 Web UI 里 `/login`，或配置 `~/.pi/agent/auth.json`
