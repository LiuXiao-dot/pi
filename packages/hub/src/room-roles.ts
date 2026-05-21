import { discoverRoles } from "./roles/discovery.ts";
import type { RoomConfigFile, RoomRoleOverride } from "./room-registry.ts";
import { RoomRegistryError } from "./room-registry.ts";

export interface ValidateRoomRolesOptions {
	cwd: string;
	rolesDir: string;
	agentDir?: string;
}

/** Trim, dedupe (first occurrence wins), reject empty names. */
export function normalizeRoleNames(names: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of names) {
		const name = raw.trim();
		if (!name) {
			throw new RoomRegistryError("role name must not be empty", "invalid_role");
		}
		if (seen.has(name)) {
			continue;
		}
		seen.add(name);
		out.push(name);
	}
	return out;
}

export function assertRolesExist(names: string[], options: ValidateRoomRolesOptions): void {
	if (names.length === 0) {
		return;
	}
	const discovery = discoverRoles({
		cwd: options.cwd,
		rolesDir: options.rolesDir,
		agentDir: options.agentDir,
	});
	const known = new Set(discovery.roles.map((r) => r.name));
	for (const name of names) {
		if (!known.has(name)) {
			throw new RoomRegistryError(`Role not found in library: ${name}`, "role_not_found");
		}
	}
}

/** Keep only overrides for roles in roleNames; log stripped keys. */
export function pruneRoleOverrides(
	roleNames: string[],
	overrides: Record<string, RoomRoleOverride> | undefined,
): Record<string, RoomRoleOverride> | undefined {
	if (!overrides) {
		return undefined;
	}
	const allowed = new Set(roleNames);
	const pruned: Record<string, RoomRoleOverride> = {};
	for (const [key, value] of Object.entries(overrides)) {
		if (allowed.has(key)) {
			pruned[key] = value;
		} else {
			console.warn(`[pi-hub] Dropping roleOverride for unassigned role: ${key}`);
		}
	}
	return Object.keys(pruned).length > 0 ? pruned : undefined;
}

export function prepareRoomConfigPatch(
	patch: RoomConfigFile,
	current: RoomConfigFile,
	options: ValidateRoomRolesOptions,
): RoomConfigFile {
	const merged: RoomConfigFile = { ...current, ...patch };

	if (patch.roleNames !== undefined) {
		merged.roleNames = normalizeRoleNames(patch.roleNames);
		assertRolesExist(merged.roleNames, options);
	}

	const roleNames = merged.roleNames ?? [];
	merged.roleOverrides = pruneRoleOverrides(
		roleNames,
		patch.roleOverrides !== undefined ? patch.roleOverrides : current.roleOverrides,
	);

	return merged;
}

export function addRoomRoleName(current: string[] | undefined, roleName: string): string[] {
	const name = roleName.trim();
	if (!name) {
		throw new RoomRegistryError("roleName is required", "invalid_role");
	}
	const list = current ?? [];
	if (list.includes(name)) {
		throw new RoomRegistryError(`Role already assigned to room: ${name}`, "role_already_assigned");
	}
	return [...list, name];
}

export function removeRoomRoleName(current: string[] | undefined, roleName: string): string[] {
	const name = roleName.trim();
	const list = current ?? [];
	const next = list.filter((n) => n !== name);
	if (next.length === list.length) {
		throw new RoomRegistryError(`Role not assigned to room: ${name}`, "role_not_assigned");
	}
	return next;
}
