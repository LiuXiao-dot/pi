import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HubServerHandle } from "@earendil-works/pi-hub";
import { startHubServer } from "@earendil-works/pi-hub";
import type { BrowserWindow } from "electron";
import electron from "electron";

const { app, clipboard, dialog, ipcMain } = electron;

import { createTray } from "./tray.ts";
import { setupUpdater } from "./updater.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

interface HubDesktopConfig {
	token: string;
	port: number;
	host: string;
	cwd: string;
	defaultRoomId: string;
}

const DEFAULT_PORT = 3141;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_ROOM_ID = "default";

function configPath(): string {
	return join(homedir(), ".pi", "hub.json");
}

function defaultWorkspace(): string {
	const ws = join(homedir(), "pi-workspace");
	if (!existsSync(ws)) {
		mkdirSync(ws, { recursive: true });
	}
	return ws;
}

function loadConfig(): HubDesktopConfig | null {
	const path = configPath();
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<HubDesktopConfig>;
		return {
			token: parsed.token?.trim() ?? "",
			port: parsed.port ?? DEFAULT_PORT,
			host: parsed.host ?? DEFAULT_HOST,
			cwd: resolve(parsed.cwd ?? defaultWorkspace()),
			defaultRoomId: parsed.defaultRoomId ?? DEFAULT_ROOM_ID,
		};
	} catch {
		return null;
	}
}

function generateToken(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}

function createFirstRunConfig(): HubDesktopConfig {
	const token = generateToken();
	const config: HubDesktopConfig = {
		token,
		port: DEFAULT_PORT,
		host: DEFAULT_HOST,
		cwd: defaultWorkspace(),
		defaultRoomId: DEFAULT_ROOM_ID,
	};
	const path = configPath();
	const dir = join(path, "..");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	return config;
}

function getLanAddress(): string {
	const nets = networkInterfaces();
	for (const [, addrs] of Object.entries(nets)) {
		if (!addrs) continue;
		for (const addr of addrs) {
			if (addr.family === "IPv4" && !addr.internal) {
				return addr.address;
			}
		}
	}
	return "127.0.0.1";
}

function firstRunWindowHtml(token: string, lanIp: string, port: number): string {
	return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi Hub Setup</title>
<style>
  :root {
    --bg: #FFFFFF; --fg: #0A0A0A; --bg-muted: #F2F2F3;
    --bg-hover: #EDEDEE; --fg-secondary: #5C5C62; --fg-tertiary: #9A9AA0;
    --radius-lg: 16px; --radius-pill: 999px;
    --font: "Inter","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family: var(--font); background: var(--bg); color: var(--fg);
    display: flex; align-items: center; justify-content: center; min-height: 100vh;
    user-select: none; -webkit-app-region: drag;
  }
  .card { width: 420px; padding: 40px 36px; text-align: center; }
  .logo { font-size: 48px; font-weight: 800; margin-bottom: 8px; color: var(--fg); }
  .subtitle { font-size: 14px; color: var(--fg-tertiary); margin-bottom: 32px; }
  .field { margin-bottom: 20px; text-align: left; }
  .field-label { font-size: 12px; font-weight: 500; color: var(--fg-secondary); margin-bottom: 6px; }
  .field-value {
    display: flex; align-items: center; gap: 8px;
    background: var(--bg-muted); border-radius: 12px; padding: 10px 14px;
    font-size: 13px; font-family: "SF Mono","Cascadia Code","Consolas",monospace;
    word-break: break-all; -webkit-app-region: no-drag;
  }
  .copy-btn {
    flex-shrink: 0; background: var(--fg); color: #fff;
    border: none; border-radius: var(--radius-pill); padding: 6px 14px;
    font-size: 12px; cursor: pointer; font-family: var(--font); -webkit-app-region: no-drag;
  }
  .copy-btn:hover { background: #222; }
  .copy-btn:active { transform: scale(.97); }
  .lan-info { font-size: 13px; color: var(--fg-secondary); margin-bottom: 32px; line-height: 1.6; }
  .start-btn {
    width: 100%; height: 44px; background: var(--fg); color: #fff;
    border: none; border-radius: var(--radius-pill); font-size: 15px;
    font-weight: 600; cursor: pointer; font-family: var(--font);
    -webkit-app-region: no-drag;
    transition: background 120ms ease, transform 120ms ease;
  }
  .start-btn:hover { background: #222; }
  .start-btn:active { transform: scale(.98); }
</style>
</head>
<body>
<div class="card">
  <div class="logo">\u03c0</div>
  <p class="subtitle">pi Hub</p>
  <div class="field">
    <div class="field-label">\u8fde\u63a5\u4ee4\u724c Token</div>
    <div class="field-value">
      <span id="token-text">${token}</span>
      <button class="copy-btn" id="copy-token">\u590d\u5236</button>
    </div>
  </div>
  <div class="field">
    <div class="field-label">\u5c40\u57df\u7f51\u5730\u5740</div>
    <div class="field-value">
      <span id="lan-text">http://${lanIp}:${port}</span>
      <button class="copy-btn" id="copy-lan">\u590d\u5236</button>
    </div>
  </div>
  <p class="lan-info">
    \u5176\u4ed6\u8bbe\u5907\u901a\u8fc7\u4e0a\u8ff0\u5730\u5740\u5728\u6d4f\u89c8\u5668\u4e2d\u8bbf\u95ee\uff0c\u8f93\u5165\u4ee4\u724c\u5373\u53ef\u52a0\u5165\u3002
  </p>
  <button class="start-btn" id="start-btn">\u542f\u52a8 pi Hub</button>
</div>
<script>
  document.getElementById("copy-token").onclick = function() {
    window.electronAPI.copyToClipboard(document.getElementById("token-text").textContent);
  };
  document.getElementById("copy-lan").onclick = function() {
    window.electronAPI.copyToClipboard(document.getElementById("lan-text").textContent);
  };
  document.getElementById("start-btn").onclick = function() {
    window.electronAPI.firstRunDone();
  };
</script>
</body>
</html>`;
}

let mainWindow: BrowserWindow | null = null;
let hubHandle: HubServerHandle | null = null;
let tray: ReturnType<typeof createTray> | null = null;
let isQuitting = false;

function resolvePublicDir(): string {
	const devPublic = join(__dirname, "..", "..", "web", "dist");
	if (existsSync(join(devPublic, "index.html"))) {
		return devPublic;
	}
	const distPublic = join(__dirname, "public");
	if (existsSync(join(distPublic, "index.html"))) {
		return distPublic;
	}
	return distPublic;
}

async function startHub(config: HubDesktopConfig): Promise<HubServerHandle> {
	const publicDir = resolvePublicDir();
	const handle = await startHubServer({
		port: config.port,
		host: config.host,
		token: config.token,
		cwd: config.cwd,
		publicDir,
		defaultRoomId: config.defaultRoomId,
	});
	console.log(`[pi-desktop] Hub started on ${handle.url}`);
	return handle;
}

function createMainWindow(url: string): BrowserWindow {
	const win = new electron.BrowserWindow({
		width: 1280,
		height: 800,
		minWidth: 800,
		minHeight: 600,
		title: "pi Hub",
		show: false,
		webPreferences: {
			preload: join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	void win.loadURL(url);

	win.once("ready-to-show", () => {
		win.show();
	});

	win.on("close", (e) => {
		if (tray && !isQuitting) {
			e.preventDefault();
			win.hide();
		}
	});

	return win;
}

async function startFirstRun(): Promise<void> {
	const config = createFirstRunConfig();
	const lanIp = getLanAddress();

	const win = new electron.BrowserWindow({
		width: 500,
		height: 560,
		resizable: false,
		frame: false,
		title: "pi Hub Setup",
		show: false,
		webPreferences: {
			preload: join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	void win.loadURL(
		`data:text/html;charset=utf-8,${encodeURIComponent(firstRunWindowHtml(config.token, lanIp, config.port))}`,
	);

	win.once("ready-to-show", () => win.show());

	return new Promise<void>((resolve) => {
		ipcMain.once("first-run-done", () => {
			win.close();
			resolve();
		});
	});
}

async function startApp(): Promise<void> {
	ipcMain.on("copy-to-clipboard", (_event, text: string) => {
		clipboard.writeText(text);
	});

	let config = loadConfig();

	if (!config) {
		await startFirstRun();
		config = loadConfig();
		if (!config) {
			await dialog.showErrorBox("Error", "Failed to create configuration. Please try again.");
			app.quit();
			return;
		}
	}

	hubHandle = await startHub(config);
	const lanUrl = `http://${getLanAddress()}:${config.port}`;

	mainWindow = createMainWindow(`http://127.0.0.1:${config.port}`);

	tray = createTray({
		onShow: () => {
			mainWindow?.show();
			mainWindow?.focus();
		},
		onQuit: () => {
			isQuitting = true;
			app.quit();
		},
		lanUrl,
	});

	setupUpdater();
}

app.whenReady().then(() => {
	void startApp();
});

app.on("window-all-closed", () => {
	// Don't quit on window close; tray keeps app alive
});

app.on("before-quit", () => {
	isQuitting = true;
});

app.on("will-quit", () => {
	tray?.destroy();
	tray = null;
});

app.on("quit", () => {
	void hubHandle?.close();
	hubHandle = null;
});
