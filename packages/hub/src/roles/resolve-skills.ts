import { existsSync } from "node:fs";
import { join } from "node:path";

/** Resolve skill names to filesystem paths for pi --skill. */
export function resolveSkillPaths(
	cwd: string,
	agentDir: string,
	skillNames: string[],
	roomSkillsDir?: string,
): string[] {
	const paths: string[] = [];
	for (const name of skillNames) {
		const resolved = resolveOneSkillPath(cwd, agentDir, name, roomSkillsDir);
		if (resolved) {
			paths.push(resolved);
		}
	}
	return paths;
}

function resolveOneSkillPath(cwd: string, agentDir: string, name: string, roomSkillsDir?: string): string | undefined {
	if (existsSync(name)) {
		return name;
	}

	const candidates: string[] = [];
	if (roomSkillsDir) {
		candidates.push(join(roomSkillsDir, name, "SKILL.md"), join(roomSkillsDir, `${name}.md`));
	}
	candidates.push(
		join(cwd, ".pi", "skills", name, "SKILL.md"),
		join(cwd, ".pi", "skills", `${name}.md`),
		join(agentDir, "skills", name, "SKILL.md"),
		join(agentDir, "skills", `${name}.md`),
	);

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	return undefined;
}
