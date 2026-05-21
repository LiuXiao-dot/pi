import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRolesConfig } from "../src/config.ts";
import { RoleOrchestrator } from "../src/role-orchestrator.ts";
import { parseTaskPlan } from "../src/roles/parse-plan.ts";
import type { RunRoleResult } from "../src/roles/runner.ts";
import { planExecutionBatches } from "../src/roles/topo.ts";
import type { RoleConfig, RoleGapEvent, RolePlanEvent, RoleProgressEvent } from "../src/roles/types.ts";
import { RoomRegistry } from "../src/room-registry.ts";

describe("parseTaskPlan", () => {
	it("parses raw JSON", () => {
		const plan = parseTaskPlan('{"summary":"s","tasks":[{"role":"dev","task":"fix"}],"uncovered":[]}');
		expect(plan.summary).toBe("s");
		expect(plan.tasks[0]?.role).toBe("dev");
	});

	it("parses fenced JSON", () => {
		const plan = parseTaskPlan(
			'Here:\n```json\n{"summary":"x","tasks":[],"uncovered":[{"description":"d","reason":"r"}]}\n```',
		);
		expect(plan.uncovered[0]?.description).toBe("d");
	});
});

describe("planExecutionBatches", () => {
	it("orders tasks by dependsOn", () => {
		const batches = planExecutionBatches([
			{ role: "b", task: "second", dependsOn: ["a"] },
			{ role: "a", task: "first" },
			{ role: "c", task: "parallel" },
		]);
		expect(batches).toHaveLength(2);
		expect(batches[0]?.tasks.map((t) => t.role).sort()).toEqual(["a", "c"]);
		expect(batches[1]?.tasks[0]?.role).toBe("b");
	});
});

describe("RoleOrchestrator", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-hub-orch-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		const rolesDir = join(tempDir, ".pi", "roles");
		mkdirSync(rolesDir, { recursive: true });
		writeFileSync(
			join(rolesDir, "pm.md"),
			`---
name: pm
description: Plans work
tools: read
---
Plan only.`,
		);
		writeFileSync(
			join(rolesDir, "dev.md"),
			`---
name: dev
description: Developer
who: Software developer
can: Implement features
when: Hands-on coding tasks
---
Build.`,
		);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("broadcasts plan, gaps, progress and calls synthesis prompt", async () => {
		const planJson =
			'{"summary":"do thing","tasks":[{"role":"dev","task":"implement"}],"uncovered":[{"description":"legal review","reason":"no lawyer role"}]}';

		const runRole = vi.fn(async (opts: { role: RoleConfig; task: string }): Promise<RunRoleResult> => {
			if (opts.role.name === "pm") {
				return { exitCode: 0, output: planJson, stderr: "" };
			}
			return { exitCode: 0, output: "done", stderr: "" };
		});

		const broadcasts: Array<RolePlanEvent | RoleGapEvent | RoleProgressEvent> = [];
		let promptText = "";

		const registry = new RoomRegistry(tempDir);
		registry.createRoom("test");

		const session = {
			messages: [] as unknown[],
			sessionManager: {
				appendMessage: vi.fn(),
				buildSessionContext: vi.fn(() => ({ messages: [], thinkingLevel: "off", model: undefined })),
			},
			agent: { state: { messages: [] } },
			prompt: vi.fn(async (text: string) => {
				promptText = text;
			}),
			sendCustomMessage: vi.fn(async () => {}),
		};

		const orchestrator = new RoleOrchestrator({
			session: session as never,
			cwd: tempDir,
			roomId: "test",
			registry,
			rolesConfig: resolveRolesConfig({ enabled: true, rolesDir: ".pi/roles", pmRole: "pm" }),
			getRoomConfig: () => ({ roleNames: ["pm", "dev"] }),
			getRoleModelOverrides: () => ({}),
			onBroadcast: (msg) => broadcasts.push(msg),
			runRole,
		});

		expect(orchestrator.isReady()).toBe(true);
		await orchestrator.run("build feature X");

		expect(broadcasts.some((b) => b.type === "role_plan")).toBe(true);
		expect(broadcasts.some((b) => b.type === "role_gap")).toBe(true);
		expect(broadcasts.filter((b) => b.type === "role_progress").length).toBeGreaterThanOrEqual(2);
		expect(runRole).toHaveBeenCalledTimes(2);
		expect(promptText).toContain("build feature X");
		expect(promptText).toContain("done");

		const pmCall = runRole.mock.calls.find((c) => c[0].role.name === "pm");
		expect(pmCall?.[0].task).toContain("Room worker roster");
		expect(pmCall?.[0].task).toContain("global role library");
		expect(pmCall?.[0].task).toContain("### dev");
		expect(pmCall?.[0].task).toContain("- Who: Software developer");
		expect(pmCall?.[0].task).not.toContain("### pm");
	});

	it("adds unknown role to uncovered", async () => {
		const planJson = '{"summary":"s","tasks":[{"role":"unknown","task":"x"}],"uncovered":[]}';

		const runRole = vi.fn(async (opts: { role: RoleConfig }): Promise<RunRoleResult> => {
			if (opts.role.name === "pm") {
				return { exitCode: 0, output: planJson, stderr: "" };
			}
			return { exitCode: 0, output: "nope", stderr: "" };
		});

		const gaps: RoleGapEvent[] = [];
		const registry = new RoomRegistry(tempDir);
		registry.createRoom("test");

		const session = {
			messages: [] as unknown[],
			sessionManager: {
				appendMessage: vi.fn(),
				buildSessionContext: vi.fn(() => ({ messages: [] })),
			},
			agent: { state: { messages: [] } },
			prompt: vi.fn(async () => {}),
			sendCustomMessage: vi.fn(async () => {}),
		};

		const orchestrator = new RoleOrchestrator({
			session: session as never,
			cwd: tempDir,
			roomId: "test",
			registry,
			rolesConfig: resolveRolesConfig({ enabled: true }),
			getRoomConfig: () => ({ roleNames: ["pm", "dev"] }),
			getRoleModelOverrides: () => ({}),
			onBroadcast: (msg) => {
				if (msg.type === "role_gap") gaps.push(msg);
			},
			runRole,
		});

		await orchestrator.run("test");
		const gap = gaps.find((g) => g.uncovered.some((u) => u.reason.includes("unknown")));
		expect(gap).toBeDefined();
		expect(runRole).toHaveBeenCalledTimes(1);
	});

	it("isReady is false when room has no assigned roles", () => {
		const registry = new RoomRegistry(tempDir);
		registry.createRoom("test");

		const session = {
			messages: [] as unknown[],
			sessionManager: {
				appendMessage: vi.fn(),
				buildSessionContext: vi.fn(() => ({ messages: [] })),
			},
			agent: { state: { messages: [] } },
			prompt: vi.fn(async () => {}),
			sendCustomMessage: vi.fn(async () => {}),
		};

		const orchestrator = new RoleOrchestrator({
			session: session as never,
			cwd: tempDir,
			roomId: "test",
			registry,
			rolesConfig: resolveRolesConfig({ enabled: true, rolesDir: ".pi/roles", pmRole: "pm" }),
			getRoomConfig: () => ({ roleNames: [] }),
			getRoleModelOverrides: () => ({}),
			onBroadcast: () => {},
			runRole: vi.fn(),
		});

		expect(orchestrator.isReady()).toBe(false);
	});

	it("only runs roles listed in room roleNames", async () => {
		const registry = new RoomRegistry(tempDir);
		registry.createRoom("test");

		const runRole = vi.fn(async (opts: { role: RoleConfig }): Promise<RunRoleResult> => {
			if (opts.role.name === "pm") {
				return { exitCode: 0, output: '{"summary":"s","tasks":[],"uncovered":[]}', stderr: "" };
			}
			return { exitCode: 0, output: "nope", stderr: "" };
		});

		const session = {
			messages: [] as unknown[],
			sessionManager: {
				appendMessage: vi.fn(),
				buildSessionContext: vi.fn(() => ({ messages: [] })),
			},
			agent: { state: { messages: [] } },
			prompt: vi.fn(async () => {}),
			sendCustomMessage: vi.fn(async () => {}),
		};

		const orchestrator = new RoleOrchestrator({
			session: session as never,
			cwd: tempDir,
			roomId: "test",
			registry,
			rolesConfig: resolveRolesConfig({ enabled: true, rolesDir: ".pi/roles", pmRole: "pm" }),
			getRoomConfig: () => ({ roleNames: ["pm"] }),
			getRoleModelOverrides: () => ({}),
			onBroadcast: () => {},
			runRole,
		});

		expect(orchestrator.isReady()).toBe(false);
		await orchestrator.run("test");
		expect(runRole).toHaveBeenCalledTimes(1);
		expect(runRole.mock.calls[0]?.[0].role.name).toBe("pm");
	});
});
