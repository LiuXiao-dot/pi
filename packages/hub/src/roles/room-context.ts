import type { AgentSession } from "@earendil-works/pi-coding-agent";

const DEFAULT_MESSAGE_LIMIT = 20;
const DEFAULT_CHAR_LIMIT = 12000;

function getMessageText(msg: { role?: string; content?: unknown }): string {
	if (msg.role !== "user" && msg.role !== "assistant") {
		return "";
	}
	const content = msg.content;
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const part of content) {
			if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
				parts.push(String(part.text));
			}
		}
		return parts.join("\n");
	}
	return "";
}

/** Build recent room conversation for role subprocess context. */
export function buildRoomContextPrefix(
	session: AgentSession,
	options?: { messageLimit?: number; charLimit?: number },
): string | undefined {
	const messageLimit = options?.messageLimit ?? DEFAULT_MESSAGE_LIMIT;
	const charLimit = options?.charLimit ?? DEFAULT_CHAR_LIMIT;

	const lines: string[] = [];
	let chars = 0;

	const messages = session.messages;
	for (let i = messages.length - 1; i >= 0 && lines.length < messageLimit; i--) {
		const msg = messages[i] as { role?: string; content?: unknown };
		const text = getMessageText(msg);
		if (!text.trim()) {
			continue;
		}
		const line = `[${msg.role}]: ${text}`;
		if (chars + line.length > charLimit) {
			break;
		}
		lines.unshift(line);
		chars += line.length;
	}

	if (lines.length === 0) {
		return undefined;
	}

	return `Recent room conversation:\n${lines.join("\n")}`;
}
