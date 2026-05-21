import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMonorepoRoot, getPiInvocation } from "../src/roles/pi-invocation.ts";

describe("getPiInvocation", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("uses PI_CLI_SCRIPT with node and script as separate spawn args", () => {
		const root = join(tmpdir(), `pi-hub-inv-cli-${Date.now()}`);
		const cli = join(root, "cli.js");
		mkdirSync(root, { recursive: true });
		writeFileSync(cli, "// cli\n");
		process.env.PI_CLI_SCRIPT = cli;
		process.env.PI_COMMAND = `${process.execPath} "${cli}"`;
		const inv = getPiInvocation(["--mode", "json"]);
		expect(inv.command).toBe(process.execPath);
		expect(inv.args[0]).toBe(cli);
		expect(inv.args).toContain("--mode");
		rmSync(root, { recursive: true, force: true });
	});

	it("ignores PI_COMMAND when it contains spaces and uses monorepo cli.js", () => {
		const root = join(tmpdir(), `pi-hub-inv-${Date.now()}`);
		const cli = join(root, "packages", "coding-agent", "dist", "cli.js");
		mkdirSync(path.dirname(cli), { recursive: true });
		writeFileSync(cli, "// cli\n");

		const prevCwd = process.cwd();
		process.chdir(root);
		try {
			process.env.PI_COMMAND = `${process.execPath} "${cli}"`;
			delete process.env.PI_CLI_SCRIPT;

			const inv = getPiInvocation(["-p"]);
			expect(inv.command).toBe(process.execPath);
			expect(inv.args[0]).toBe(cli);
		} finally {
			process.chdir(prevCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("findMonorepoRoot", () => {
	it("finds repo root from packages/hub", () => {
		const hubDir = join(findMonorepoRoot() ?? "", "packages", "hub");
		const root = findMonorepoRoot(hubDir);
		expect(root).toBeDefined();
		expect(existsSync(join(root!, "packages", "coding-agent", "dist", "cli.js"))).toBe(true);
	});
});
