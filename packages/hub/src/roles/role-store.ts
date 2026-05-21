import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { HubRoleContentPayload, HubRoleSummaryPayload } from "../protocol.ts";
import { discoverRoles, resolveProjectRolesDir } from "./discovery.ts";
import type { RoleConfig } from "./types.ts";

export class RoleStoreError extends Error {
	readonly code: string;

	constructor(message: string, code: string) {
		super(message);
		this.name = "RoleStoreError";
		this.code = code;
	}
}

function roleToSummary(role: RoleConfig): HubRoleSummaryPayload {
	const preview = role.systemPrompt.length > 200 ? `${role.systemPrompt.slice(0, 200)}...` : role.systemPrompt;
	return {
		name: role.name,
		description: role.description,
		who: role.who,
		can: role.can,
		when: role.when,
		source: role.source,
		filePath: role.filePath,
		model: role.model,
		tools: role.tools,
		skills: role.skills,
		rulesPath: role.rulesPath,
		systemPromptPreview: preview,
	};
}

export function listRoleSummaries(cwd: string, rolesDir: string): HubRoleSummaryPayload[] {
	const discovery = discoverRoles({ cwd, rolesDir });
	return discovery.roles.map(roleToSummary);
}

export function getRoleContent(cwd: string, rolesDir: string, name: string): HubRoleContentPayload {
	const discovery = discoverRoles({ cwd, rolesDir });
	const role = discovery.roles.find((r) => r.name === name);
	if (!role) {
		throw new RoleStoreError(`Role not found: ${name}`, "role_not_found");
	}
	const content = readFileSync(role.filePath, "utf8");
	return {
		name: role.name,
		source: role.source,
		filePath: role.filePath,
		content,
	};
}

function validateRoleContent(content: string): { name: string; description: string } {
	const { frontmatter } = parseFrontmatter<Record<string, string>>(content);
	const name = frontmatter.name?.trim();
	const description = frontmatter.description?.trim();
	if (!name || !description) {
		throw new RoleStoreError("Role markdown must include frontmatter name and description", "invalid_role");
	}
	return { name, description };
}

function isPathUnderRolesDir(filePath: string, allowedDirs: string[]): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	return allowedDirs.some((dir) => {
		const base = dir.replace(/\\/g, "/");
		return normalized === base || normalized.startsWith(`${base}/`);
	});
}

export function saveRoleContent(cwd: string, rolesDir: string, name: string, content: string): HubRoleContentPayload {
	const parsed = validateRoleContent(content);
	if (parsed.name !== name.trim()) {
		throw new RoleStoreError(
			`Frontmatter name "${parsed.name}" does not match requested name "${name}"`,
			"invalid_role",
		);
	}

	const agentDir = getAgentDir();
	const userRolesDir = join(agentDir, "roles");
	const projectRolesDir = resolveProjectRolesDir(cwd, rolesDir);

	const discovery = discoverRoles({ cwd, rolesDir });
	const existing = discovery.roles.find((r) => r.name === name);

	let filePath: string;
	let source: "user" | "project";

	if (existing) {
		filePath = existing.filePath;
		source = existing.source;
		if (!isPathUnderRolesDir(filePath, [userRolesDir, projectRolesDir])) {
			throw new RoleStoreError("Role file is outside allowed directories", "invalid_role");
		}
	} else {
		mkdirSync(projectRolesDir, { recursive: true });
		filePath = join(projectRolesDir, `${name}.md`);
		source = "project";
	}

	writeFileSync(filePath, content, "utf8");
	return { name, source, filePath, content };
}

export function deleteRoleFile(cwd: string, rolesDir: string, name: string, options?: { pmRole?: string }): void {
	if (options?.pmRole && name === options.pmRole) {
		throw new RoleStoreError(`Cannot delete PM role "${name}"`, "invalid_role");
	}

	const discovery = discoverRoles({ cwd, rolesDir });
	const role = discovery.roles.find((r) => r.name === name);
	if (!role) {
		throw new RoleStoreError(`Role not found: ${name}`, "role_not_found");
	}

	const agentDir = getAgentDir();
	const userRolesDir = join(agentDir, "roles");
	const projectRolesDir = resolveProjectRolesDir(cwd, rolesDir);
	if (!isPathUnderRolesDir(role.filePath, [userRolesDir, projectRolesDir])) {
		throw new RoleStoreError("Role file is outside allowed directories", "invalid_role");
	}

	if (!existsSync(role.filePath)) {
		throw new RoleStoreError(`Role file missing: ${role.filePath}`, "role_not_found");
	}
	rmSync(role.filePath, { force: true });
}
