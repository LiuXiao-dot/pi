/** JSON.stringify that won't throw on circular or non-serializable agent payloads. */
export function safeStringify(value: unknown): string | null {
	try {
		return JSON.stringify(value);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[pi-hub] JSON serialize failed: ${message}`);
		return null;
	}
}
