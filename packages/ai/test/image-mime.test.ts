import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.ts";
import type { Model, UserMessage } from "../src/types.ts";
import { detectSupportedImageMimeTypeFromBase64, normalizeImageContentBlock } from "../src/utils/image-mime.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const anthropicModel: Model<"anthropic-messages"> = {
	id: "test",
	name: "Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.com",
	reasoning: false,
	input: ["text", "image"],
	contextWindow: 200000,
	maxTokens: 8192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("image-mime", () => {
	it("sniffs PNG when mimeType is empty", () => {
		expect(detectSupportedImageMimeTypeFromBase64(TINY_PNG_BASE64)).toBe("image/png");
	});

	it("fills missing mimeType on image blocks", () => {
		const block = normalizeImageContentBlock({
			type: "image",
			data: TINY_PNG_BASE64,
			mimeType: "",
		});
		expect(block).toEqual({ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
	});
});

describe("transformMessages image mime", () => {
	it("normalizes historical user images with empty mimeType", () => {
		const userMsg: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: "see screenshot" },
				{ type: "image", data: TINY_PNG_BASE64, mimeType: "" },
			],
			timestamp: 1,
		};
		const result = transformMessages([userMsg], anthropicModel);
		const out = result[0] as UserMessage;
		expect(Array.isArray(out.content)).toBe(true);
		const image = (out.content as Array<{ type: string; mimeType?: string }>).find((b) => b.type === "image");
		expect(image?.mimeType).toBe("image/png");
	});
});
