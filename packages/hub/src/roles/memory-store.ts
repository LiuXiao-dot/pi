import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HubRoleMemory } from "../protocol.ts";

const MEMORY_DIR = ".pi/hub/memory";

function getMemoryDir(cwd: string): string {
	return join(cwd, MEMORY_DIR);
}

function getMemoryPath(cwd: string, roleName: string): string {
	return join(getMemoryDir(cwd), `${roleName}.jsonl`);
}

export function loadRoleMemory(cwd: string, roleName: string): HubRoleMemory[] {
	const filePath = getMemoryPath(cwd, roleName);
	if (!existsSync(filePath)) return [];
	const lines = readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
	const memories: HubRoleMemory[] = [];
	for (const line of lines) {
		try {
			memories.push(JSON.parse(line) as HubRoleMemory);
		} catch {
			/* skip corrupt */
		}
	}
	return memories;
}

export function appendRoleMemory(cwd: string, roleName: string, memories: Omit<HubRoleMemory, "seq">[]): void {
	const existing = loadRoleMemory(cwd, roleName);
	let seq = existing.length > 0 ? existing.length : 0;
	const dir = getMemoryDir(cwd);
	mkdirSync(dir, { recursive: true });

	const lines: string[] = [];
	for (const m of memories) {
		seq++;
		const entry = { ...m, seq, roleName };
		lines.push(JSON.stringify(entry));
	}
	// Append to existing
	writeFileSync(
		getMemoryPath(cwd, roleName),
		`${[...existing.map((e) => JSON.stringify(e)), ...lines].join("\n")}\n`,
		"utf-8",
	);
}

export function deleteRoleMemory(cwd: string, roleName: string, seq: number): void {
	const existing = loadRoleMemory(cwd, roleName);
	const filtered = existing.filter((m) => m.seq !== seq);
	if (filtered.length === 0) {
		const filePath = getMemoryPath(cwd, roleName);
		if (existsSync(filePath)) unlinkSync(filePath);
		return;
	}
	writeFileSync(getMemoryPath(cwd, roleName), `${filtered.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf-8");
}

export function clearRoleMemory(cwd: string, roleName: string): void {
	const filePath = getMemoryPath(cwd, roleName);
	if (existsSync(filePath)) unlinkSync(filePath);
}
