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

	it("skips role orchestration when no @roles are mentioned", async () => {
		const { session } = createMockSession();
		const run = vi.fn(async () => {});
		const orchestrator = {
			isReady: () => true,
			run,
		};
		const queue = new PromptQueue(session as never, () => {}, { roleOrchestrator: orchestrator as never });

		queue.enqueue({
			command: "prompt",
			clientId: "a",
			displayName: "A",
			message: "direct",
			mentionedRoles: [],
		});

		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(1), { timeout: 5000 });
		expect(run).not.toHaveBeenCalled();
		expect(session.prompt).toHaveBeenCalledWith("direct", expect.objectContaining({ source: "rpc" }));
	});

	it("runs orchestration when @roles are mentioned", async () => {
		const { session } = createMockSession();
		const run = vi.fn(async () => {});
		const orchestrator = {
			isReady: () => true,
			run,
		};
		const queue = new PromptQueue(session as never, () => {}, { roleOrchestrator: orchestrator as never });

		queue.enqueue({
			command: "prompt",
			clientId: "a",
			displayName: "A",
			message: "@web-ui implement",
			mentionedRoles: ["web-ui"],
		});

		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1), { timeout: 5000 });
		expect(session.prompt).not.toHaveBeenCalled();
	});

	it("calls onQueueError when a prompt fails", async () => {
		const { session } = createMockSession();
		session.prompt = vi.fn(async () => {
			throw new Error("model unavailable");
		});
		const onQueueError = vi.fn();
		const queue = new PromptQueue(session as never, () => {}, { onQueueError });

		queue.enqueue({
			command: "prompt",
			clientId: "a",
			displayName: "A",
			message: "fail",
		});

		await vi.waitFor(() => expect(onQueueError).toHaveBeenCalledTimes(1), { timeout: 5000 });
		expect(onQueueError).toHaveBeenCalledWith(
			expect.objectContaining({ displayName: "A", message: "fail" }),
			"model unavailable",
		);
	});
});
