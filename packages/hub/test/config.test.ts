import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfigFile, normalizeHubToken, projectConfigPath, resolveHubConfig } from "../src/config.ts";

describe("resolveHubConfig", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-hub-config-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("merges project config and CLI overrides", () => {
		const piDir = join(tempDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(projectConfigPath(tempDir), JSON.stringify({ token: "from-file", port: 4000, cwd: tempDir }));

		const resolved = resolveHubConfig({ token: "from-cli", port: 5000 }, tempDir);
		expect(resolved.token).toBe("from-cli");
		expect(resolved.port).toBe(5000);
		expect(resolved.cwd).toBe(tempDir);
		expect(resolved.configPaths.some((p) => p.endsWith("hub.json"))).toBe(true);
	});

	it("loads explicit config path", () => {
		const custom = join(tempDir, "custom-hub.json");
		writeFileSync(custom, JSON.stringify({ token: "custom", host: "127.0.0.1" }));

		const resolved = resolveHubConfig({ configPath: custom }, tempDir);
		expect(resolved.token).toBe("custom");
		expect(resolved.host).toBe("127.0.0.1");
	});

	it("reads env overrides", () => {
		const prev = process.env.PI_HUB_TOKEN;
		process.env.PI_HUB_TOKEN = "env-token";
		try {
			const resolved = resolveHubConfig({}, tempDir);
			expect(resolved.token).toBe("env-token");
			expect(resolved.tokenSource).toBe("env");
		} finally {
			if (prev === undefined) delete process.env.PI_HUB_TOKEN;
			else process.env.PI_HUB_TOKEN = prev;
		}
	});

	it("trims token from config file", () => {
		const piDir = join(tempDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(projectConfigPath(tempDir), JSON.stringify({ token: "  spaced  " }));

		const resolved = resolveHubConfig({}, tempDir);
		expect(resolved.token).toBe("spaced");
		expect(resolved.tokenSource).toBe("config");
	});
});

describe("normalizeHubToken", () => {
	it("trims and drops empty", () => {
		expect(normalizeHubToken("  abc  ")).toBe("abc");
		expect(normalizeHubToken("   ")).toBeUndefined();
	});
});

describe("loadConfigFile", () => {
	it("throws on invalid JSON", () => {
		const path = join(tmpdir(), `bad-hub-${Date.now()}.json`);
		writeFileSync(path, "{ not json");
		expect(() => loadConfigFile(path)).toThrow(/Failed to parse/);
		rmSync(path, { force: true });
	});
});
