import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RoomConfigFile, RoomRoleOverride } from "../room-registry.ts";
import type { RoleConfig } from "./types.ts";

export interface ResolvedRoleConfig extends RoleConfig {
	/** Merged skill names for subprocess. */
	resolvedSkills?: string[];
	/** Resolved append-system-prompt text. */
	resolvedRulesText: string;
}

function parseRulesText(rules: string | undefined, cwd: string): string {
	if (!rules?.trim()) {
		return "";
	}
	const trimmed = rules.trim();
	const asPath = resolve(cwd, trimmed);
	if (existsSync(asPath)) {
		try {
			return readFileSync(asPath, "utf-8").trim();
		} catch {
			return trimmed;
		}
	}
	return trimmed;
}

function mergeSkills(...lists: (string[] | undefined)[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const list of lists) {
		if (!list) continue;
		for (const name of list) {
			const t = name.trim();
			if (t && !seen.has(t)) {
				seen.add(t);
				out.push(t);
			}
		}
	}
	return out;
}

function applyOverride(base: RoleConfig, override: RoomRoleOverride | undefined, cwd: string): ResolvedRoleConfig {
	const skills = mergeSkills(base.skills, override?.skills);
	const tools = override?.tools?.length ? override.tools : base.tools;
	const model = override?.model?.trim() || base.model;

	let resolvedRulesText = parseRulesText(override?.rules, cwd);
	if (!resolvedRulesText) {
		if (base.rulesPath && existsSync(base.rulesPath)) {
			try {
				resolvedRulesText = readFileSync(base.rulesPath, "utf-8").trim();
			} catch {
				resolvedRulesText = base.systemPrompt;
			}
		} else {
			resolvedRulesText = base.systemPrompt;
		}
	}

	return {
		...base,
		model,
		tools,
		skills: skills.length > 0 ? skills : undefined,
		resolvedSkills: skills.length > 0 ? skills : undefined,
		resolvedRulesText,
	};
}

/** Merge room config, role file, and per-role overrides. */
export function resolveRoleForRoom(role: RoleConfig, roomConfig: RoomConfigFile, cwd: string): ResolvedRoleConfig {
	const roomRulesPrefix = parseRulesText(roomConfig.rules, cwd);
	const override = roomConfig.roleOverrides?.[role.name];
	const merged = applyOverride(role, override, cwd);

	const roomSkills = roomConfig.skills;
	const skills = mergeSkills(roomSkills, merged.skills);

	let resolvedRulesText = merged.resolvedRulesText;
	if (roomRulesPrefix) {
		resolvedRulesText = roomRulesPrefix + (resolvedRulesText ? `\n\n${resolvedRulesText}` : "");
	}

	return {
		...merged,
		skills: skills.length > 0 ? skills : undefined,
		resolvedSkills: skills.length > 0 ? skills : undefined,
		resolvedRulesText,
	};
}

export function resolveRolesForRoom(
	roles: RoleConfig[],
	roomConfig: RoomConfigFile,
	cwd: string,
): ResolvedRoleConfig[] {
	return roles.map((r) => resolveRoleForRoom(r, roomConfig, cwd));
}
