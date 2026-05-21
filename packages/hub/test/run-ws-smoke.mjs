/**
 * Standalone WS smoke test. Built to dist/run-ws-smoke.js by npm run build.
 * Run: node dist/run-ws-smoke.js
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { resolveModelsConfig, resolveRolesConfig } from "../src/config.ts";
import { startHubServer } from "../src/server.ts";
import { createTestAgentSession } from "./harness.ts";

const TOKEN = "test-token-collab";

function fail(message) {
	console.error(`[ws-smoke] ${message}`);
	process.exit(1);
}

function ensureRoom(wsUrl, roomId) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		const reqId = "create-room";
		ws.on("open", () => {
			ws.send(JSON.stringify({ type: "create_room", token: TOKEN, roomId, id: reqId }));
		});
		ws.on("message", (data) => {
			const msg = JSON.parse(String(data));
			if (msg.type === "command_result" && msg.id === reqId) {
				ws.close();
				if (msg.success || String(msg.error ?? "").includes("already exists")) {
					resolve();
				} else {
					reject(new Error(String(msg.error ?? "create_room failed")));
				}
			}
		});
		ws.on("error", reject);
		setTimeout(() => reject(new Error("create_room timeout")), 30_000);
	});
}

function connect(wsUrl, displayName) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		ws.on("open", () => {
			ws.send(JSON.stringify({ type: "join", roomId: "test-room", token: TOKEN, displayName }));
		});
		ws.on("message", (data) => {
			const msg = JSON.parse(String(data));
			if (msg.type === "joined") resolve(ws);
			if (msg.type === "error") reject(new Error(String(msg.message)));
		});
		ws.on("error", reject);
		setTimeout(() => reject(new Error("connect timeout")), 30_000);
	});
}

function waitForMessage(ws, predicate, timeoutMs = 90_000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
		const handler = (data) => {
			const msg = JSON.parse(String(data));
			if (predicate(msg)) {
				clearTimeout(timer);
				ws.off("message", handler);
				resolve(msg);
			}
		};
		ws.on("message", handler);
	});
}

function resolvePublicDir() {
	const distDir = dirname(fileURLToPath(import.meta.url));
	const fromDist = join(distDir, "public");
	if (existsSync(join(fromDist, "index.html"))) {
		return fromDist;
	}
	const fromTest = join(distDir, "..", "..", "web", "dist");
	if (existsSync(join(fromTest, "index.html"))) {
		return fromTest;
	}
	fail("Web UI not built. Run: npm run hub:build");
}

const tempDir = join(tmpdir(), `pi-hub-smoke-${Date.now()}`);
mkdirSync(join(tempDir, "public"), { recursive: true });
writeFileSync(join(tempDir, "public", "index.html"), "<!DOCTYPE html><html></html>");

const faux = registerFauxProvider();
faux.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

let handle;
try {
	handle = await startHubServer({
		port: 0,
		host: "127.0.0.1",
		token: TOKEN,
		cwd: tempDir,
		publicDir: resolvePublicDir(),
		modelsConfig: resolveModelsConfig(),
		rolesConfig: resolveRolesConfig(),
		createSession: (cwd) => createTestAgentSession(cwd, faux),
	});

	await ensureRoom(handle.wsUrl, "test-room");

	const wsA = await connect(handle.wsUrl, "Alice");
	const wsB = await connect(handle.wsUrl, "Bob");

	const modelsReqId = "models-1";
	const modelsPromise = waitForMessage(
		wsA,
		(m) => m.type === "command_result" && m.command === "get_available_models" && m.id === modelsReqId,
	);
	wsA.send(JSON.stringify({ type: "get_available_models", id: modelsReqId }));
	const modelsResult = await modelsPromise;
	if (!modelsResult.success || !Array.isArray(modelsResult.data?.models) || modelsResult.data.models.length === 0) {
		fail("get_available_models failed");
	}
	const firstModel = modelsResult.data.models[0];
	const setReqId = "set-model-1";
	const setPromise = waitForMessage(
		wsA,
		(m) => m.type === "command_result" && m.command === "set_model" && m.id === setReqId,
	);
	wsA.send(
		JSON.stringify({
			type: "set_model",
			id: setReqId,
			provider: firstModel.provider,
			modelId: firstModel.id,
		}),
	);
	const setResult = await setPromise;
	if (!setResult.success) {
		fail(`set_model failed: ${setResult.error ?? "unknown"}`);
	}

	const resultA = waitForMessage(wsA, (m) => m.type === "command_result" && m.command === "prompt");
	const resultB = waitForMessage(wsB, (m) => m.type === "command_result" && m.command === "prompt");

	wsA.send(JSON.stringify({ type: "prompt", message: "first from alice" }));
	wsB.send(JSON.stringify({ type: "prompt", message: "second from bob" }));

	const ackA = await resultA;
	const ackB = await resultB;
	if (ackA.success === false || ackB.success === false) {
		fail("prompt rejected");
	}

	wsA.close();
	wsB.close();
	console.log("[ws-smoke] ok");
} catch (err) {
	fail(err instanceof Error ? err.message : String(err));
} finally {
	await handle?.close();
	rmSync(tempDir, { recursive: true, force: true });
}
