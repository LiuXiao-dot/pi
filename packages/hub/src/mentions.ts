/** Match @role-name tokens (letters, digits, hyphens, underscores). */
const MENTION_PATTERN = /@([a-zA-Z0-9][-a-zA-Z0-9_]*)/g;

export function extractMentionTokens(text: string): string[] {
	const tokens: string[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(MENTION_PATTERN)) {
		const name = match[1];
		if (name && !seen.has(name)) {
			seen.add(name);
			tokens.push(name);
		}
	}
	return tokens;
}

export interface ResolvedMentions {
	roles: string[];
	users: string[];
	/** Tokens that matched neither a room role nor a presence user (preserves original casing, deduped). */
	unknown: string[];
}

export function resolveMentions(
	tokens: string[],
	options: { roleNames: string[]; userNames: string[] },
): ResolvedMentions {
	const roleLookup = new Map(options.roleNames.map((r) => [r.toLowerCase(), r]));
	const userLookup = new Map(options.userNames.map((u) => [u.toLowerCase(), u]));
	const roles: string[] = [];
	const users: string[] = [];
	const unknown: string[] = [];
	const seenRoles = new Set<string>();
	const seenUsers = new Set<string>();
	const seenUnknown = new Set<string>();

	for (const token of tokens) {
		const key = token.toLowerCase();
		const role = roleLookup.get(key);
		if (role && !seenRoles.has(role)) {
			seenRoles.add(role);
			roles.push(role);
			continue;
		}
		const user = userLookup.get(key);
		if (user && !seenUsers.has(user)) {
			seenUsers.add(user);
			users.push(user);
			continue;
		}
		if (!role && !user && !seenUnknown.has(key)) {
			seenUnknown.add(key);
			unknown.push(token);
		}
	}

	return { roles, users, unknown };
}

export function resolveMessageMentions(
	text: string,
	options: { roleNames: string[]; userNames: string[] },
): ResolvedMentions {
	return resolveMentions(extractMentionTokens(text), options);
}

export function formatUserMentionPrefix(users: string[]): string | undefined {
	if (users.length === 0) {
		return undefined;
	}
	return `[Directed at: ${users.map((u) => `@${u}`).join(", ")}]\n\n`;
}
