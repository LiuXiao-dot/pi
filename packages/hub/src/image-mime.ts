import type { ImageContent } from "@earendil-works/pi-ai";

const SUPPORTED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function detectSupportedImageMimeType(buffer: Uint8Array): SupportedImageMimeType | null {
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
		return buffer[3] === 0xf7 ? null : "image/jpeg";
	}
	if (startsWith(buffer, PNG_SIGNATURE)) {
		return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
	}
	if (startsWithAscii(buffer, 0, "GIF")) {
		return "image/gif";
	}
	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
		return "image/webp";
	}
	return null;
}

export function detectSupportedImageMimeTypeFromBase64(data: string): SupportedImageMimeType | null {
	try {
		const buffer = Buffer.from(data, "base64");
		return detectSupportedImageMimeType(buffer);
	} catch {
		return null;
	}
}

function isSupportedDeclaredMimeType(mimeType: string): SupportedImageMimeType | null {
	const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
	if ((SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(base)) {
		return base as SupportedImageMimeType;
	}
	return null;
}

export function normalizeImageAttachments(images: ImageContent[] | undefined): {
	images: ImageContent[] | undefined;
	rejected: string[];
} {
	if (!images || images.length === 0) {
		return { images: undefined, rejected: [] };
	}

	const rejected: string[] = [];
	const normalized: ImageContent[] = [];

	for (const img of images) {
		const declared = img.mimeType ? isSupportedDeclaredMimeType(img.mimeType) : null;
		const sniffed = detectSupportedImageMimeTypeFromBase64(img.data);
		const mimeType = declared ?? sniffed;
		if (!mimeType) {
			const label = img.mimeType?.trim() || "unknown";
			rejected.push(label);
			continue;
		}
		normalized.push({ type: "image", data: img.data, mimeType });
	}

	return {
		images: normalized.length > 0 ? normalized : undefined,
		rejected,
	};
}

function isPng(buffer: Uint8Array): boolean {
	return (
		buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR")
	);
}

function isAnimatedPng(buffer: Uint8Array): boolean {
	let offset = PNG_SIGNATURE.length;
	while (offset + 8 <= buffer.length) {
		const chunkLength = readUint32BE(buffer, offset);
		const chunkTypeOffset = offset + 4;
		if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
		if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;

		const nextOffset = offset + 8 + chunkLength + 4;
		if (nextOffset <= offset || nextOffset > buffer.length) return false;
		offset = nextOffset;
	}
	return false;
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) * 0x1000000 +
		((buffer[offset + 1] ?? 0) << 16) +
		((buffer[offset + 2] ?? 0) << 8) +
		(buffer[offset + 3] ?? 0)
	);
}

function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
	if (buffer.length < bytes.length) return false;
	return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
	if (buffer.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index++) {
		if (buffer[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}
