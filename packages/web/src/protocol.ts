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

export type HubActivityPhase = "idle" | "replying" | "thinking" | "tool" | "compacting";

export interface HubActivityUpdateMessage extends HubServerMessage {
	type: "activity_update";
	hostDisplayName: string | null;
	phase: HubActivityPhase;
	detail?: string;
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

export interface HubTaskPlanTask {
	role: string;
	task: string;
	dependsOn?: string[];
}

export interface HubTaskPlanGap {
	description: string;
	reason: string;
}

export interface HubTaskPlan {
	summary: string;
	tasks: HubTaskPlanTask[];
	uncovered: HubTaskPlanGap[];
}

export interface HubRolePlanMessage extends HubServerMessage {
	type: "role_plan";
	plan: HubTaskPlan;
}

export type HubRoleProgressPhase = "started" | "done" | "failed";

export interface HubRoleProgressMessage extends HubServerMessage {
	type: "role_progress";
	role: string;
	taskId: string;
	phase: HubRoleProgressPhase;
	preview?: string;
}

export interface HubRoleGapMessage extends HubServerMessage {
	type: "role_gap";
	uncovered: HubTaskPlanGap[];
}

export interface HubRoleModelEntry {
	name: string;
	description: string;
	modelRef?: string;
	fileModelRef?: string;
}

export interface HubModelsConfigPayload {
	models: HubModelInfo[];
	catalog: string[];
	sessionModelRef?: string;
	roles: HubRoleModelEntry[];
}
