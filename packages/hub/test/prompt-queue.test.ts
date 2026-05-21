import { describe, expect, it, vi } from "vitest";
import { PromptQueue } from "../src/prompt-queue.ts";

function createMockSession() {
	let streaming = false;
	const session = {
		get isStreaming() {
			return streaming;
		},
		prompt: vi.fn(async () => {
			streaming = true;
			await Promise.resolve();
			streaming = false;
		}),
		steer: vi.fn(async () => {}),
		followUp: vi.fn(async () => {}),
	};
	return {
		session,
		setStreaming: (v: boolean) => {
			streaming = v;
		},
	};
}

describe("PromptQueue", () => {
	it("runs prompts sequentially", async () => {
		const { session } = createMockSession();
		const updates: unknown[] = [];
		const queue = new PromptQueue(session as never, (u) => updates.push(u));

		queue.enqueue({
			command: "prompt",
			clientId: "a",
			displayName: "A",
			message: "first",
		});
		queue.enqueue({
			command: "prompt",
			clientId: "b",
			displayName: "B",
			message: "second",
		});

		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2), { timeout: 5000 });
		expect(session.prompt).toHaveBeenNthCalledWith(1, "first", expect.objectContaining({ source: "rpc" }));
		expect(session.prompt).toHaveBeenNthCalledWith(2, "second", expect.objectContaining({ source: "rpc" }));
	});
});
