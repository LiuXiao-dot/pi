import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverRoles, formatRoomRosterForPm, getRoleByName } from "../src/roles/discovery.ts";

describe("discoverRoles", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-hub-roles-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads roles from project dir with frontmatter", () => {
		const rolesDir = join(tempDir, ".pi", "roles");
		mkdirSync(rolesDir, { recursive: true });
		writeFileSync(
			join(rolesDir, "developer.md"),
			`---
name: developer
description: Writes code
model: test-model
tools: read, bash
skills: my-skill
---
Do the work.`,
		);

		const { roles } = discoverRoles({ cwd: tempDir, rolesDir: ".pi/roles", agentDir: join(tempDir, "agent") });
		const dev = getRoleByName(roles, "developer");
		expect(dev?.model).toBe("test-model");
		expect(dev?.tools).toEqual(["read", "bash"]);
		expect(dev?.skills).toEqual(["my-skill"]);
		expect(dev?.systemPrompt).toContain("Do the work");
		expect(dev?.source).toBe("project");
	});

	it("project role overrides user role with same name", () => {
		const agentDir = join(tempDir, "agent", "roles");
		const projectDir = join(tempDir, ".pi", "roles");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });

		writeFileSync(
			join(agentDir, "worker.md"),
			`---
name: worker
description: user version
---
user body`,
		);
		writeFileSync(
			join(projectDir, "worker.md"),
			`---
name: worker
description: project version
---
project body`,
		);

		const { roles } = discoverRoles({ cwd: tempDir, rolesDir: ".pi/roles", agentDir: join(tempDir, "agent") });
		const worker = getRoleByName(roles, "worker");
		expect(worker?.description).toBe("project version");
		expect(worker?.systemPrompt).toContain("project body");
		expect(worker?.source).toBe("project");
	});

	it("loads who, can, and when from frontmatter", () => {
		const rolesDir = join(tempDir, ".pi", "roles");
		mkdirSync(rolesDir, { recursive: true });
		writeFileSync(
			join(rolesDir, "reviewer.md"),
			`---
name: reviewer
description: Reviews code
who: Code reviewer
can: Read-only review
when: After implementation
---
Review.`,
		);

		const { roles } = discoverRoles({ cwd: tempDir, rolesDir: ".pi/roles", agentDir: join(tempDir, "agent") });
		const reviewer = getRoleByName(roles, "reviewer");
		expect(reviewer?.who).toBe("Code reviewer");
		expect(reviewer?.can).toBe("Read-only review");
		expect(reviewer?.when).toBe("After implementation");
	});

	it("formatRoomRosterForPm includes presentation and falls back to description", () => {
		const rolesDir = join(tempDir, ".pi", "roles");
		mkdirSync(rolesDir, { recursive: true });
		writeFileSync(
			join(rolesDir, "dev.md"),
			`---
name: dev
description: Builds features
who: Developer
can: Code changes
when: Implementation tasks
---
Work.`,
		);
		writeFileSync(
			join(rolesDir, "bare.md"),
			`---
name: bare
description: Minimal role
---
Body.`,
		);

		const { roles } = discoverRoles({ cwd: tempDir, rolesDir: ".pi/roles", agentDir: join(tempDir, "agent") });
		const roster = formatRoomRosterForPm(roles);
		expect(roster).toContain("### dev");
		expect(roster).toContain("- Who: Developer");
		expect(roster).toContain("- Can do: Code changes");
		expect(roster).toContain("- When to assign: Implementation tasks");
		expect(roster).toContain("### bare");
		expect(roster).toContain("- Can do: Minimal role");
	});

	it("skips files without name or description", () => {
		const rolesDir = join(tempDir, ".pi", "roles");
		mkdirSync(rolesDir, { recursive: true });
		writeFileSync(join(rolesDir, "bad.md"), "---\nname: only-name\n---\n");

		const { roles } = discoverRoles({ cwd: tempDir, rolesDir: ".pi/roles", agentDir: join(tempDir, "agent") });
		expect(roles).toHaveLength(0);
	});
});
