import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HubSkillContent, HubSkillSummary } from "../protocol.ts";

function loadSkillsFromDir(dir: string, source: "user" | "project"): HubSkillSummary[] {
	const skills: HubSkillSummary[] = [];
	if (!existsSync(dir)) return skills;

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return skills;
	}

	for (const entry of entries) {
		let skillDir = entry.name;
		let filePath = join(dir, skillDir, "SKILL.md");
		let isDir = entry.isDirectory();

		// Also support single-file skills: <name>.md in the skills root
		if (!isDir && entry.name.endsWith(".md")) {
			filePath = join(dir, entry.name);
			skillDir = entry.name.slice(0, -3);
			isDir = true; // treat as valid
		}

		if (!isDir) continue;

		if (!existsSync(filePath)) continue;

		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		// Extract description from first line or frontmatter
		const firstLine = content.split("\n")[0] ?? "";
		const description = firstLine.startsWith("#") ? firstLine.replace(/^#+\s*/, "").trim() : undefined;

		skills.push({ name: skillDir, source, description });
	}

	return skills;
}

export interface ListSkillsOptions {
	cwd: string;
	agentDir?: string;
}

export function listSkillFiles(options: ListSkillsOptions): HubSkillSummary[] {
	const agentDir = options.agentDir ?? getAgentDir();
	const projectSkillsDir = join(options.cwd, ".pi", "skills");
	const userSkillsDir = join(agentDir, "skills");

	const projectSkills = loadSkillsFromDir(projectSkillsDir, "project");
	const userSkills = loadSkillsFromDir(userSkillsDir, "user");

	// Project skills override user skills with the same name
	const map = new Map<string, HubSkillSummary>();
	for (const s of userSkills) map.set(s.name, s);
	for (const s of projectSkills) map.set(s.name, s);

	return Array.from(map.values());
}

export function getSkillContent(cwd: string, name: string, agentDir?: string): HubSkillContent | undefined {
	const ad = agentDir ?? getAgentDir();
	const candidates = [
		{ dir: join(cwd, ".pi", "skills", name), source: "project" as const },
		{ dir: join(cwd, ".pi", "skills"), source: "project" as const, flat: `${name}.md` },
		{ dir: join(ad, "skills", name), source: "user" as const },
		{ dir: join(ad, "skills"), source: "user" as const, flat: `${name}.md` },
	];

	for (const c of candidates) {
		const filePath = "flat" in c ? join(c.dir, c.flat as string) : join(c.dir, "SKILL.md");
		if (existsSync(filePath)) {
			const content = readFileSync(filePath, "utf-8");
			return { name, source: c.source, filePath, content };
		}
		// Also check directory-style with SKILL.md
		if (!("flat" in c)) {
			const altPath = join(c.dir, `${name}.md`);
			if (existsSync(altPath)) {
				const content = readFileSync(altPath, "utf-8");
				return { name, source: c.source, filePath: altPath, content };
			}
		}
	}
	return undefined;
}

export function saveSkillContent(cwd: string, name: string, content: string): HubSkillContent {
	const dir = join(cwd, ".pi", "skills", name);
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, "SKILL.md");
	writeFileSync(filePath, content, "utf-8");
	return { name, source: "project", filePath, content };
}
