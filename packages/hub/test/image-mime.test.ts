import { describe, expect, it } from "vitest";
import { detectSupportedImageMimeTypeFromBase64, normalizeImageAttachments } from "../src/image-mime.ts";

// Minimal valid 1x1 PNG
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("image-mime", () => {
	it("sniffs PNG when mimeType is empty", () => {
		expect(detectSupportedImageMimeTypeFromBase64(TINY_PNG_BASE64)).toBe("image/png");
	});

	it("normalizes attachments with missing mimeType", () => {
		const result = normalizeImageAttachments([{ type: "image", data: TINY_PNG_BASE64, mimeType: "" }]);
		expect(result.rejected).toEqual([]);
		expect(result.images).toEqual([{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }]);
	});

	it("rejects unknown image bytes", () => {
		const result = normalizeImageAttachments([
			{ type: "image", data: Buffer.from("not-an-image").toString("base64"), mimeType: "image/bmp" },
		]);
		expect(result.images).toBeUndefined();
		expect(result.rejected).toEqual(["image/bmp"]);
	});
});
