import { describe, expect, it } from "vitest";
import {
	extractMentionTokens,
	formatUserMentionPrefix,
	resolveMentions,
	resolveMessageMentions,
} from "../src/mentions.ts";

describe("mentions", () => {
	it("extracts unique @tokens", () => {
		expect(extractMentionTokens("@pm please @web-ui fix @pm")).toEqual(["pm", "web-ui"]);
	});

	it("resolves roles before users on name collision", () => {
		const { roles, users, unknown } = resolveMentions(["alice"], {
			roleNames: ["alice"],
			userNames: ["alice"],
		});
		expect(roles).toEqual(["alice"]);
		expect(users).toEqual([]);
		expect(unknown).toEqual([]);
	});

	it("resolves room roles and presence users", () => {
		const result = resolveMessageMentions("@pm split work @web-ui implement @tx-lan", {
			roleNames: ["pm", "web-ui"],
			userNames: ["tx-lan", "tx"],
		});
		expect(result.roles).toEqual(["pm", "web-ui"]);
		expect(result.users).toEqual(["tx-lan"]);
		expect(result.unknown).toEqual([]);
	});

	it("reports unknown @tokens that match neither a role nor a user", () => {
		const result = resolveMessageMentions("@web-ui go @ghost @PM done @ghost again", {
			roleNames: ["pm"],
			userNames: ["alice"],
		});
		expect(result.roles).toEqual(["pm"]);
		expect(result.users).toEqual([]);
		// Deduped (case-insensitive), original casing preserved on first occurrence.
		expect(result.unknown).toEqual(["web-ui", "ghost"]);
	});

	it("formats user mention prefix", () => {
		expect(formatUserMentionPrefix(["Alice"])).toBe("[Directed at: @Alice]\n\n");
		expect(formatUserMentionPrefix([])).toBeUndefined();
	});
});
