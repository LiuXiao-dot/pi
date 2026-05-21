import { describe, expect, it } from "vitest";
import type { HubModelInfo } from "../src/model-info.ts";
import { applyRoleModelOverrides, filterModelsByCatalog, formatModelRef, parseModelRef } from "../src/models-config.ts";
import type { RoleConfig } from "../src/roles/types.ts";

const sampleModels: HubModelInfo[] = [
	{
		provider: "anthropic",
		id: "claude-sonnet-4-5",
		name: "Sonnet",
		baseUrl: "https://api.anthropic.com",
		api: "anthropic",
		hasAuth: true,
	},
	{
		provider: "openai",
		id: "gpt-5.4",
		name: "GPT",
		baseUrl: "https://api.openai.com",
		api: "openai",
		hasAuth: true,
	},
];

describe("parseModelRef", () => {
	it("parses provider/id", () => {
		expect(parseModelRef("anthropic/claude-sonnet-4-5")).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		});
	});
});

describe("filterModelsByCatalog", () => {
	it("returns all when catalog empty", () => {
		expect(filterModelsByCatalog(sampleModels, [])).toHaveLength(2);
	});

	it("filters to catalog entries", () => {
		const filtered = filterModelsByCatalog(sampleModels, ["anthropic/claude-sonnet-4-5"]);
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.id).toBe("claude-sonnet-4-5");
	});
});

describe("applyRoleModelOverrides", () => {
	it("overrides role model", () => {
		const roles: RoleConfig[] = [
			{
				name: "dev",
				description: "d",
				systemPrompt: "",
				source: "project",
				filePath: "/x",
				model: "openai/gpt-4o",
			},
		];
		const updated = applyRoleModelOverrides(roles, { dev: "anthropic/claude-sonnet-4-5" });
		expect(updated[0]?.model).toBe("anthropic/claude-sonnet-4-5");
	});
});

describe("formatModelRef", () => {
	it("round-trips", () => {
		const ref = parseModelRef("openai/gpt-5.4");
		expect(ref && formatModelRef(ref)).toBe("openai/gpt-5.4");
	});
});
