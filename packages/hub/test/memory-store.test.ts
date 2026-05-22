import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	appendRoleMemory,
	clearRoleMemory,
	deleteRoleMemory,
	loadRecentRoleMemory,
	loadRoleMemory,
} from "../src/roles/memory-store.ts";

function makeCwd(): string {
	return mkdtempSync(join(os.tmpdir(), "pi-hub-memory-"));
}

describe("memory-store", () => {
	test("appendRoleMemory uses max(seq)+1 and never reuses a deleted seq", () => {
		const cwd = makeCwd();
		try {
			appendRoleMemory(cwd, "alice", [
				{ ts: "t1", room: "r", goal: "g1", result: "ok", roleName: "alice" },
				{ ts: "t2", room: "r", goal: "g2", result: "ok", roleName: "alice" },
				{ ts: "t3", room: "r", goal: "g3", result: "ok", roleName: "alice" },
			]);
			expect(loadRoleMemory(cwd, "alice").map((m) => m.seq)).toEqual([1, 2, 3]);

			deleteRoleMemory(cwd, "alice", 2);
			expect(loadRoleMemory(cwd, "alice").map((m) => m.seq)).toEqual([1, 3]);

			// New entry must take seq=4 (max(seq)+1), not 3 (length-based) which would collide.
			appendRoleMemory(cwd, "alice", [{ ts: "t4", room: "r", goal: "g4", result: "ok", roleName: "alice" }]);
			const seqs = loadRoleMemory(cwd, "alice").map((m) => m.seq);
			expect(seqs).toEqual([1, 3, 4]);
			expect(new Set(seqs).size).toBe(seqs.length);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("loadRecentRoleMemory respects the limit and returns oldest-first", () => {
		const cwd = makeCwd();
		try {
			appendRoleMemory(
				cwd,
				"bob",
				Array.from({ length: 5 }, (_, i) => ({
					ts: `t${i}`,
					room: "r",
					goal: `g${i}`,
					result: "ok",
					roleName: "bob",
				})),
			);
			const recent = loadRecentRoleMemory(cwd, "bob", 3);
			expect(recent.map((m) => m.goal)).toEqual(["g2", "g3", "g4"]);
			expect(loadRecentRoleMemory(cwd, "bob", 99)).toHaveLength(5);
			expect(loadRecentRoleMemory(cwd, "bob", 0)).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("clearRoleMemory removes the file", () => {
		const cwd = makeCwd();
		try {
			appendRoleMemory(cwd, "carol", [{ ts: "t", room: "r", goal: "g", result: "ok", roleName: "carol" }]);
			expect(loadRoleMemory(cwd, "carol")).toHaveLength(1);
			clearRoleMemory(cwd, "carol");
			expect(loadRoleMemory(cwd, "carol")).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
