import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { RoleConfig } from "./types.ts";

export interface DiscoverRolesOptions {
	cwd: string;
	rolesDir: string;
	agentDir?: string;
}

export interface DiscoverRolesResult {
	roles: RoleConfig[];
	projectRolesDir: string | null;
	userRolesDir: string;
}

function loadRolesFromDir(dir: string, source: "user" | "project", cwd: string): RoleConfig[] {
	const roles: RoleConfig[] = [];
	if (!existsSync(dir)) {
		return roles;
	}

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return roles;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = join(dir, entry.name);
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		const skills = frontmatter.skills
			?.split(",")
			.map((s) => s.trim())
			.filter(Boolean);

		let rulesPath: string | undefined;
		if (frontmatter.rules?.trim()) {
			rulesPath = resolve(cwd, frontmatter.rules.trim());
		}

		roles.push({
			name: frontmatter.name,
			description: frontmatter.description,
			model: frontmatter.model?.trim() || undefined,
			tools: tools && tools.length > 0 ? tools : undefined,
			skills: skills && skills.length > 0 ? skills : undefined,
			rulesPath,
			systemPrompt: body.trim(),
			source,
			filePath,
		});
	}

	return roles;
}

function isDirectory(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Resolve project roles directory (absolute). */
export function resolveProjectRolesDir(cwd: string, rolesDir: string): string {
	return resolve(cwd, rolesDir);
}

/** Discover roles from user and project dirs; project overrides user by name. */
export function discoverRoles(options: DiscoverRolesOptions): DiscoverRolesResult {
	const agentDir = options.agentDir ?? getAgentDir();
	const userRolesDir = join(agentDir, "roles");
	const projectRolesDir = resolveProjectRolesDir(options.cwd, options.rolesDir);

	const userRoles = loadRolesFromDir(userRolesDir, "user", options.cwd);
	const projectRoles = loadRolesFromDir(projectRolesDir, "project", options.cwd);

	const roleMap = new Map<string, RoleConfig>();
	for (const role of userRoles) {
		roleMap.set(role.name, role);
	}
	for (const role of projectRoles) {
		roleMap.set(role.name, role);
	}

	return {
		roles: Array.from(roleMap.values()),
		projectRolesDir: isDirectory(projectRolesDir) ? projectRolesDir : null,
		userRolesDir,
	};
}

export function getRoleByName(roles: RoleConfig[], name: string): RoleConfig | undefined {
	return roles.find((r) => r.name === name);
}

export function formatRoleCatalog(roles: RoleConfig[], excludeName?: string): string {
	const listed = roles.filter((r) => r.name !== excludeName);
	if (listed.length === 0) {
		return "(no roles configured)";
	}
	return listed.map((r) => `- ${r.name}: ${r.description}`).join("\n");
}
