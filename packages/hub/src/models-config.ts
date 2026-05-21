import { existsSync, writeFileSync } from "node:fs";
import { type HubConfigFile, loadConfigFile, projectConfigPath } from "./config.ts";
import type { HubModelInfo } from "./model-info.ts";
import type { RoleConfig } from "./roles/types.ts";

/** Parsed model reference: provider + model id. */
export interface ModelRef {
	provider: string;
	modelId: string;
}

export function formatModelRef(ref: ModelRef): string {
	return `${ref.provider}/${ref.modelId}`;
}

/** Parse "provider/modelId" (first slash separates provider from id). */
export function parseModelRef(value: string): ModelRef | undefined {
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash >= trimmed.length - 1) {
		return undefined;
	}
	return {
		provider: trimmed.slice(0, slash),
		modelId: trimmed.slice(slash + 1),
	};
}

export function modelRefMatchesInfo(ref: ModelRef, model: HubModelInfo): boolean {
	return model.provider === ref.provider && model.id === ref.modelId;
}

/** Filter registry models to catalog entries that exist; empty catalog returns all. */
export function filterModelsByCatalog(models: HubModelInfo[], catalog: string[]): HubModelInfo[] {
	if (catalog.length === 0) {
		return models;
	}
	const refs = catalog.map(parseModelRef).filter((r): r is ModelRef => r !== undefined);
	if (refs.length === 0) {
		return models;
	}
	return models.filter((m) => refs.some((r) => modelRefMatchesInfo(r, m)));
}

export function applyRoleModelOverrides(roles: RoleConfig[], overrides: Record<string, string>): RoleConfig[] {
	return roles.map((role) => {
		const override = overrides[role.name];
		if (!override?.trim()) {
			return role;
		}
		return { ...role, model: override.trim() };
	});
}

export interface HubRoleModelEntry {
	name: string;
	description: string;
	/** Configured model ref (provider/id) or undefined. */
	modelRef?: string;
	/** From role markdown frontmatter when no override. */
	fileModelRef?: string;
}

export function buildRoleModelEntries(roles: RoleConfig[], overrides: Record<string, string>): HubRoleModelEntry[] {
	return roles.map((role) => {
		const override = overrides[role.name]?.trim();
		const fileModel = role.model?.trim();
		return {
			name: role.name,
			description: role.description,
			modelRef: override || fileModel || undefined,
			fileModelRef: fileModel || undefined,
		};
	});
}

/** Merge role model override into project .pi/hub.json and return updated overrides map. */
export function persistRoleModelOverride(
	cwd: string,
	roleName: string,
	modelRef: string | null,
): Record<string, string> {
	const path = projectConfigPath(cwd);
	const existing: HubConfigFile = existsSync(path) ? loadConfigFile(path) : {};
	const roleModels = { ...(existing.models?.roleModels ?? {}) };
	if (modelRef === null || modelRef.trim() === "") {
		delete roleModels[roleName];
	} else {
		roleModels[roleName] = modelRef.trim();
	}
	const next: HubConfigFile = {
		...existing,
		models: {
			...existing.models,
			roleModels,
		},
	};
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return roleModels;
}
