#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatConfigHelp, resolveHubConfig, writeExampleConfig } from "./config.ts";
import { defaultPublicDir } from "./http-server.ts";
import { startHubServer } from "./server.ts";

interface ParsedCli {
	command: "run" | "init" | "help";
	overrides: {
		configPath?: string;
		token?: string;
		port?: number;
		host?: string;
		cwd?: string;
		session?: string;
		defaultRoomId?: string;
		publicDir?: string;
	};
	initGlobal: boolean;
	initForce: boolean;
}

function parseArgs(argv: string[]): ParsedCli {
	const result: ParsedCli = {
		command: "run",
		overrides: {},
		initGlobal: false,
		initForce: false,
	};

	let i = 2;
	if (argv[i] === "init") {
		result.command = "init";
		i++;
	}
	if (argv[i] === "help" || argv[i] === "-h" || argv[i] === "--help") {
		result.command = "help";
		return result;
	}

	for (; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			result.command = "help";
			return result;
		}
		if (result.command === "init") {
			if (arg === "--global" || arg === "-g") {
				result.initGlobal = true;
			} else if (arg === "--force" || arg === "-f") {
				result.initForce = true;
			}
			continue;
		}
		if (arg === "--config" && argv[i + 1]) {
			result.overrides.configPath = argv[++i];
		} else if (arg === "--port" && argv[i + 1]) {
			result.overrides.port = Number(argv[++i]);
		} else if (arg === "--host" && argv[i + 1]) {
			result.overrides.host = argv[++i];
		} else if (arg === "--cwd" && argv[i + 1]) {
			result.overrides.cwd = argv[++i];
		} else if (arg === "--token" && argv[i + 1]) {
			result.overrides.token = argv[++i];
		} else if (arg === "--session" && argv[i + 1]) {
			result.overrides.session = argv[++i];
		} else if (arg === "--room" && argv[i + 1]) {
			result.overrides.defaultRoomId = argv[++i];
		} else if (arg === "--public" && argv[i + 1]) {
			result.overrides.publicDir = resolve(argv[++i]);
		}
	}

	return result;
}

function printHelp(): void {
	console.log(`pi-hub — LAN WebSocket hub for collaborative pi sessions

Usage:
  pi-hub [options]              Start the hub server
  pi-hub init [options]         Write a starter config file
  pi-hub help                   Show this help

Start options:
  --config <path>   Extra config JSON (merged after global + project)
  --port <n>        HTTP/WebSocket port (default: 3141)
  --host <addr>     Bind address (default: 0.0.0.0)
  --cwd <path>      Agent working directory
  --session <path>  Open existing session JSONL file
  --token <secret>  Shared join token
  --room <id>       Default room id (default: default)
  --public <dir>    Static web assets directory

Init options:
  --global, -g      Write ~/.pi/hub.json instead of .pi/hub.json
  --force, -f       Overwrite existing file

${formatConfigHelp()}
From the pi-mono repo (no global install):
  npm run hub
  npm run hub -- --token dev --cwd .

Security:
  Only run on trusted LANs. Anyone with the token can use the shared workspace.
`);
}

async function runInit(parsed: ParsedCli): Promise<void> {
	const path = writeExampleConfig({
		global: parsed.initGlobal,
		cwd: process.cwd(),
		overwrite: parsed.initForce,
	});
	console.log(`[pi-hub] Wrote ${path}`);
	console.log("[pi-hub] Edit cwd/token as needed, then start with:");
	if (parsed.initGlobal) {
		console.log("  pi-hub");
		console.log("  npm run hub   (from pi-mono root)");
	} else {
		console.log(`  pi-hub --config ${path}`);
		console.log("  npm run hub");
	}
}

async function runServer(parsed: ParsedCli): Promise<void> {
	const resolved = resolveHubConfig(parsed.overrides, process.cwd());
	const publicDir = resolved.publicDir ?? defaultPublicDir();

	if (!resolved.token) {
		console.error("[pi-hub] Missing token.");
		console.error("  Set token in config, PI_HUB_TOKEN, --token, or run: pi-hub init");
		process.exit(1);
	}

	if (!existsSync(join(publicDir, "index.html"))) {
		console.error(`[pi-hub] Web UI not found at ${publicDir}`);
		console.error("  From pi-mono root: npm run hub:build");
		console.error("  Or: npm run build:web && npm run build --workspace=@earendil-works/pi-hub");
		process.exit(1);
	}

	if (resolved.configPaths.length > 0) {
		console.log(`[pi-hub] Config: ${resolved.configPaths.join(", ")}`);
	}

	if (resolved.tokenSource === "env") {
		console.warn(
			"[pi-hub] Token from PI_HUB_TOKEN (overrides .pi/hub.json). Web UI must use this env value, not the file token.",
		);
	} else if (resolved.token) {
		const suffix = resolved.token.length > 4 ? resolved.token.slice(-4) : resolved.token;
		console.log(`[pi-hub] Token from config (length ${resolved.token.length}, ends with …${suffix})`);
	}

	const handle = await startHubServer({
		port: resolved.port,
		host: resolved.host,
		token: resolved.token,
		cwd: resolved.cwd,
		sessionPath: resolved.session,
		publicDir,
		defaultRoomId: resolved.defaultRoomId,
	});

	const lanHost = resolved.host === "0.0.0.0" ? "127.0.0.1" : resolved.host;
	console.log(`[pi-hub] Web UI:  http://${lanHost}:${handle.port}/`);
	console.log(`[pi-hub] WebSocket: ws://${lanHost}:${handle.port}/ws`);
	console.log(`[pi-hub] cwd: ${resolved.cwd}`);
	console.log(`[pi-hub] room: ${resolved.defaultRoomId}`);
	console.log("[pi-hub] LAN: use this machine's IP instead of 127.0.0.1 for other devices.");
	console.log("[pi-hub] Only expose on trusted LANs.");

	const shutdown = async () => {
		await handle.close();
		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv);

	switch (parsed.command) {
		case "help":
			printHelp();
			return;
		case "init":
			await runInit(parsed);
			return;
		case "run":
			await runServer(parsed);
			return;
	}
}

main().catch((err) => {
	console.error("[pi-hub] Fatal:", err instanceof Error ? err.message : err);
	process.exit(1);
});
