import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoomRegistry, RoomRegistryError, validateRoomId } from "../src/room-registry.ts";

describe("validateRoomId", () => {
	it("rejects path separators", () => {
		expect(() => validateRoomId("../x")).toThrow(RoomRegistryError);
	});

	it("accepts valid slugs", () => {
		expect(validateRoomId("team-alpha_1")).toBe("team-alpha_1");
	});

	it("accepts Chinese room ids", () => {
		expect(validateRoomId("默认房间")).toBe("默认房间");
	});
});

describe("RoomRegistry", () => {
	let tempDir: string;
	let registry: RoomRegistry;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-hub-registry-${Date.now()}`);
		registry = new RoomRegistry(tempDir);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("creates and lists rooms", () => {
		const entry = registry.createRoom("default", { title: "Default" });
		expect(entry.roomId).toBe("default");
		expect(registry.listRooms()).toHaveLength(1);
	});

	it("creates room with Chinese id on disk", () => {
		registry.createRoom("测试");
		expect(existsSync(join(tempDir, ".pi", "hub", "rooms", "测试"))).toBe(true);
	});

	it("rejects duplicate room ids", () => {
		registry.createRoom("dup");
		expect(() => registry.createRoom("dup")).toThrow(RoomRegistryError);
	});

	it("deletes room directory by default", () => {
		registry.createRoom("gone");
		const path = registry.getSessionPath("gone");
		const dir = join(tempDir, ".pi", "hub", "rooms", "gone");
		expect(existsSync(dir)).toBe(true);
		registry.deleteRoom("gone");
		expect(registry.getRoom("gone")).toBeUndefined();
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(path)).toBe(false);
	});

	it("loads and saves room config", () => {
		registry.createRoom("cfg");
		const saved = registry.saveRoomConfig("cfg", {
			skills: ["review"],
			rules: "Be concise",
			rolesEnabled: true,
		});
		expect(saved.skills).toEqual(["review"]);
		const loaded = registry.loadRoomConfig("cfg");
		expect(loaded.rules).toBe("Be concise");
		expect(loaded.rolesEnabled).toBe(true);
	});

	it("ensureDefaultRoom creates when index empty", () => {
		const entry = registry.ensureDefaultRoom("default");
		expect(entry.roomId).toBe("default");
	});

	it("getSessionPath requires existing room", () => {
		expect(() => registry.getSessionPath("missing")).toThrow(RoomRegistryError);
	});
});
