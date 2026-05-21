/** Client-side mirror of hub protocol (subset). */

export interface HubModelInfo {
	provider: string;
	id: string;
	name: string;
	baseUrl: string;
	api: string;
	hasAuth: boolean;
}

export interface HubSessionState {
	model?: { provider?: string; id?: string; name?: string; baseUrl?: string };
	thinkingLevel?: string;
	isStreaming?: boolean;
	[key: string]: unknown;
}

export type HubServerMessage = { type: string; [key: string]: unknown };
export type HubClientMessage = { type: string; [key: string]: unknown };

export interface HubCommandResultMessage extends HubServerMessage {
	type: "command_result";
	command: string;
	id?: string;
	success: boolean;
	error?: string;
	data?: unknown;
}
