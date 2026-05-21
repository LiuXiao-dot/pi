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
	fullOutput?: string;
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

export interface HubRoomSummary {
	roomId: string;
	title?: string;
	createdAt: string;
	updatedAt: string;
	clientCount?: number;
}

export interface HubRoomRoleOverridePayload {
	skills?: string[];
	rules?: string;
	tools?: string[];
	model?: string;
}

export interface HubRoomConfigPayload {
	roleNames?: string[];
	skills?: string[];
	rules?: string;
	roleOverrides?: Record<string, HubRoomRoleOverridePayload>;
	rolesEnabled?: boolean;
}

export interface HubRoleSummaryPayload {
	name: string;
	description: string;
	source: "user" | "project";
	filePath: string;
	model?: string;
	tools?: string[];
	skills?: string[];
	rulesPath?: string;
	systemPromptPreview: string;
}

export interface HubRoleContentPayload {
	name: string;
	source: "user" | "project";
	filePath: string;
	content: string;
}
