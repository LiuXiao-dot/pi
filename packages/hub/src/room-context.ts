/**
 * Builds room context text for injection into the main agent session's
 * system prompt. This makes the AI aware of its environment: what room it's in,
 * which roles and skills are available, and any room-level rules.
 */

import { discoverRoles } from "./roles/discovery.ts";
import { listSkillFiles } from "./roles/skill-store.ts";
import type { RoleConfig } from "./roles/types.ts";
import type { RoomConfigFile } from "./room-registry.ts";

export interface RoomContextParams {
	roomId: string;
	title?: string;
	workspace: string;
	modelRef?: string;
	/** Working directory used for role/skill discovery. */
	cwd: string;
	rolesConfig: { rolesDir: string };
	roomConfig: RoomConfigFile;
}

export function buildRoomContext(params: RoomContextParams): string {
	const { roomId, title, workspace, modelRef, cwd, rolesConfig, roomConfig } = params;

	const roleNames = roomConfig.roleNames ?? [];
	const discovery = discoverRoles({ cwd, rolesDir: rolesConfig.rolesDir });
	const assignedRoles = discovery.roles.filter((r) => roleNames.includes(r.name));

	const skills = listSkillFiles({ cwd: workspace });

	const lines: string[] = [];
	lines.push("");
	lines.push("## Room Context");
	lines.push("");

	const displayName = title ? `${roomId} (${title})` : roomId;
	lines.push(`You are in room "${displayName}".`);
	lines.push("");

	lines.push(`**Workspace**: ${workspace}`);
	if (modelRef) {
		lines.push(`**Model**: ${modelRef}`);
	}
	lines.push("");

	if (assignedRoles.length > 0) {
		lines.push("### Assigned Roles");
		lines.push("Use @roleName to delegate work to these specialists:");
		for (const role of assignedRoles) {
			lines.push(`- **${role.name}**: ${role.description}`);
			if (role.can) {
				lines.push(`  - Can: ${role.can}`);
			}
			if (role.who) {
				lines.push(`  - Who: ${role.who}`);
			}
			const when = role.when ?? roleCanToWhen(role);
			if (when && when !== role.can) {
				lines.push(`  - When: ${when}`);
			}
		}
		lines.push("");
	}

	if (skills.length > 0) {
		lines.push("### Active Skills");
		for (const skill of skills) {
			const desc = skill.description ? `: ${skill.description}` : "";
			lines.push(`- **${skill.name}**${desc}`);
		}
		lines.push("");
	}

	const rules = roomConfig.rules?.trim();
	if (rules) {
		lines.push("### Room Rules");
		lines.push(rules);
		lines.push("");
	}

	return lines.join("\n");
}

function roleCanToWhen(role: RoleConfig): string {
	if (!role.can) return "";
	return `When the delegated task matches ${role.name}'s capabilities.`;
}

/**
 * Extract role summaries from room config for the HubJoined protocol.
 */
export interface RoomContextSummary {
	roles: RoleSummary[];
	skills: SkillSummary[];
}

export interface RoleSummary {
	name: string;
	description: string;
	who?: string;
	can?: string;
	when?: string;
}

export interface SkillSummary {
	name: string;
	source: "user" | "project";
	description?: string;
}

export function buildRoomContextSummaries(params: RoomContextParams): RoomContextSummary {
	const { roomConfig, cwd, rolesConfig, workspace } = params;

	const roleNames = roomConfig.roleNames ?? [];
	const discovery = discoverRoles({ cwd, rolesDir: rolesConfig.rolesDir });
	const assignedRoles = discovery.roles.filter((r) => roleNames.includes(r.name));

	const skills = listSkillFiles({ cwd: workspace });

	return {
		roles: assignedRoles.map((r) => ({
			name: r.name,
			description: r.description,
			who: r.who,
			can: r.can,
			when: r.when,
		})),
		skills: skills.map((s) => ({
			name: s.name,
			source: s.source,
			description: s.description,
		})),
	};
}
