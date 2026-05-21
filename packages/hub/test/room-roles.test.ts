import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoomRegistry, RoomRegistryError } from "../src/room-registry.ts";
import {
	addRoomRoleName,
	assertRolesExist,
	normalizeRoleNames,
	prepareRoomConfigPatch,
	removeRoomRoleName,
} from "../src/room-roles.ts";

describe("normalizeRoleNames", () => {
	it("dedupes while preserving order", () => {
		expect(normalizeRoleNames(["pm", "dev", "pm"])).toEqual(["pm", "dev"]);
	});

	it("rejects empty name", () => {
		expect(() => normalizeRoleNames(["pm", "  "])).toThrow(RoomRegistryError);
	});
});

describe("addRoomRoleName", () => {
	it("rejects duplicate", () => {
		expect(() => addRoomRoleName(["pm"], "pm")).toThrow(RoomRegistryError);
	});
});

describe("removeRoomRoleName", () => {
	it("rejects removing missing role", () => {
		expect(() => removeRoomRoleName(["pm"], "dev")).toThrow(RoomRegistryError);
	});
});

describe("RoomRegistry roleNames", () => {
	let tempDir: string;
	let registry: RoomRegistry;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-hub-room-roles-${Date.now()}`);
		registry = new RoomRegistry(tempDir);
		const rolesDir = join(tempDir, ".pi", "roles");
		mkdirSync(rolesDir, { recursive: true });
		writeFileSync(
			join(rolesDir, "pm.md"),
			`---
name: pm
description: PM
---
`,
		);
		writeFileSync(
			join(rolesDir, "dev.md"),
			`---
name: dev
description: Dev
---
`,
		);
		registry.createRoom("r1");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("saves roleNames with validation", () => {
		const opts = { cwd: tempDir, rolesDir: ".pi/roles" };
		const saved = registry.saveRoomConfig("r1", { roleNames: ["pm", "dev", "pm"] }, opts);
		expect(saved.roleNames).toEqual(["pm", "dev"]);
	});

	it("addRoomRoleName via patch flow", () => {
		const opts = { cwd: tempDir, rolesDir: ".pi/roles" };
		const current = registry.loadRoomConfig("r1");
		const names = addRoomRoleName(current.roleNames, "pm");
		assertRolesExist(["pm"], opts);
		const saved = registry.saveRoomConfig("r1", { roleNames: names }, opts);
		expect(saved.roleNames).toEqual(["pm"]);
	});

	it("rejects unknown role", () => {
		const opts = { cwd: tempDir, rolesDir: ".pi/roles" };
		expect(() => registry.saveRoomConfig("r1", { roleNames: ["ghost"] }, opts)).toThrow(RoomRegistryError);
	});

	it("prunes roleOverrides for unassigned roles", () => {
		const opts = { cwd: tempDir, rolesDir: ".pi/roles" };
		const saved = prepareRoomConfigPatch(
			{ roleNames: ["pm"], roleOverrides: { pm: { rules: "x" }, dev: { rules: "y" } } },
			{},
			opts,
		);
		expect(saved.roleOverrides).toEqual({ pm: { rules: "x" } });
	});
});
