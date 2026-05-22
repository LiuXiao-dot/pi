/**
 * WebSocket protocol for pi LAN hub.
 * Command shapes align with coding-agent RPC where applicable.
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, RpcSessionState } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Extension UI (mirrors rpc-types.ts)
// ============================================================================

export type HubExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export type HubExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Client -> Hub
// ============================================================================

/** Hub-scoped commands (token required; no join). */
export type HubScopedClientMessage =
	| { type: "list_rooms"; token: string; id?: string }
	| { type: "create_room"; token: string; roomId: string; title?: string; id?: string }
	| { type: "delete_room"; token: string; roomId: string; deleteFiles?: boolean; id?: string }
	| { type: "get_room_config"; token: string; roomId: string; id?: string }
	| {
			type: "set_room_config";
			token: string;
			roomId: string;
			config: HubRoomConfigPayload;
			id?: string;
	  }
	| { type: "list_roles"; token: string; id?: string }
	| { type: "get_role"; token: string; name: string; id?: string }
	| { type: "save_role"; token: string; name: string; content: string; id?: string }
	| { type: "delete_role"; token: string; name: string; id?: string }
	| { type: "add_room_role"; token: string; roomId: string; roleName: string; id?: string }
	| { type: "remove_room_role"; token: string; roomId: string; roleName: string; id?: string }
	| { type: "set_room_roles"; token: string; roomId: string; roleNames: string[]; id?: string }
	| { type: "list_skills"; token: string; id?: string }
	| { type: "get_skill_content"; token: string; name: string; id?: string }
	| { type: "clear_room_session"; token: string; roomId: string; id?: string }
	| { type: "sleep_room"; token: string; roomId: string; id?: string }
	| { type: "get_role_memory"; token: string; roleName: string; id?: string }
	| { type: "delete_role_memory"; token: string; roleName: string; seq: number; id?: string }
	| { type: "clear_role_memory"; token: string; roleName: string; id?: string };

export function isHubScopedMessage(message: HubClientMessage): message is HubScopedClientMessage {
	return (
		message.type === "list_rooms" ||
		message.type === "create_room" ||
		message.type === "delete_room" ||
		message.type === "get_room_config" ||
		message.type === "set_room_config" ||
		message.type === "list_roles" ||
		message.type === "get_role" ||
		message.type === "save_role" ||
		message.type === "delete_role" ||
		message.type === "add_room_role" ||
		message.type === "remove_room_role" ||
		message.type === "set_room_roles" ||
		message.type === "list_skills" ||
		message.type === "get_skill_content" ||
		message.type === "clear_room_session" ||
		message.type === "sleep_room" ||
		message.type === "get_role_memory" ||
		message.type === "delete_role_memory" ||
		message.type === "clear_role_memory"
	);
}

export type HubClientMessage =
	| HubScopedClientMessage
	| { type: "join"; roomId: string; token: string; displayName: string }
	| {
			type: "prompt";
			id?: string;
			message: string;
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
	  }
	| { type: "steer"; id?: string; message: string; images?: ImageContent[] }
	| { type: "follow_up"; id?: string; message: string; images?: ImageContent[] }
	| { type: "abort"; id?: string }
	| { type: "leave" }
	| { type: "get_state"; id?: string }
	| { type: "get_available_models"; id?: string }
	| { type: "get_models_config"; id?: string }
	| { type: "set_model"; id?: string; provider: string; modelId: string }
	| { type: "set_role_model"; id?: string; roleName: string; provider?: string; modelId?: string }
	| { type: "set_provider_base_url"; id?: string; provider: string; baseUrl: string }
	| HubExtensionUIResponse;

// ============================================================================
// Hub -> Client
// ============================================================================

export interface HubPresenceMember {
	clientId: string;
	displayName: string;
}

export interface HubQueueItemSnapshot {
	id: string;
	clientId: string;
	displayName: string;
	command: "prompt" | "steer" | "follow_up";
	queuedAt: string;
}

export interface HubQueueUpdate {
	type: "queue_update";
	pending: HubQueueItemSnapshot[];
	current: HubQueueItemSnapshot | null;
}

export interface HubPresenceUpdate {
	type: "presence";
	members: HubPresenceMember[];
}

export interface HubJoined {
	type: "joined";
	clientId: string;
	roomId: string;
	state: RpcSessionState;
	messages: unknown[];
}

export interface HubLeft {
	type: "left";
	roomId: string;
}

export type HubActivityPhase = "idle" | "replying" | "thinking" | "tool" | "compacting" | "sleeping";

export interface HubActivityUpdate {
	type: "activity_update";
	hostDisplayName: string | null;
	phase: HubActivityPhase;
	/** Tool name during `tool`, compaction reason during `compacting`, etc. */
	detail?: string;
}

export interface HubAgentEvent {
	type: "agent_event";
	event: AgentSessionEvent;
	/** Display name of the client that owns the current queue turn. */
	hostDisplayName?: string;
}

export interface HubModelInfoPayload {
	provider: string;
	id: string;
	name: string;
	baseUrl: string;
	api: string;
	hasAuth: boolean;
}

export interface HubRoleModelEntryPayload {
	name: string;
	description: string;
	modelRef?: string;
	fileModelRef?: string;
}

export interface HubModelsConfigPayload {
	models: HubModelInfoPayload[];
	catalog: string[];
	sessionModelRef?: string;
	roles: HubRoleModelEntryPayload[];
}

export interface HubCommandResult {
	type: "command_result";
	command: string;
	id?: string;
	success: boolean;
	error?: string;
	data?: unknown;
}

export interface HubStateUpdate {
	type: "state_update";
	state: RpcSessionState;
}

export interface HubError {
	type: "error";
	code: string;
	message: string;
}

// ============================================================================
// Multi-role orchestration
// ============================================================================

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

export interface HubRolePlan {
	type: "role_plan";
	plan: HubTaskPlan;
}

export type HubRoleProgressPhase = "started" | "done" | "failed";

export interface HubRoleProgress {
	type: "role_progress";
	role: string;
	taskId: string;
	phase: HubRoleProgressPhase;
	preview?: string;
	fullOutput?: string;
}

export interface HubRoomSummary {
	roomId: string;
	title?: string;
	createdAt: string;
	updatedAt: string;
	clientCount?: number;
}

export interface HubRoomsList {
	type: "rooms_list";
	rooms: HubRoomSummary[];
}

export interface HubRoomDeleted {
	type: "room_deleted";
	roomId: string;
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
	who?: string;
	can?: string;
	when?: string;
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

export interface HubRoleGap {
	type: "role_gap";
	uncovered: HubTaskPlanGap[];
}

export interface HubSkillSummary {
	name: string;
	source: "user" | "project";
	description?: string;
}

export interface HubSkillContent {
	name: string;
	source: "user" | "project";
	filePath: string;
	content: string;
}

export type HubSleepPhase = "extracting" | "storing" | "clearing";

export interface HubSleepProgressMessage {
	type: "sleep_progress";
	roomId: string;
	phase: HubSleepPhase;
}

export interface HubSleepDoneMessage {
	type: "sleep_done";
	roomId: string;
	memories: HubRoleMemory[];
}

export interface HubRoleMemory {
	seq: number;
	ts: string;
	room: string;
	goal: string;
	result: string;
	roleName: string;
}

export type HubExtensionUIOutbound = HubExtensionUIRequest & {
	targetClientId: string | null;
	waitingForDisplayName?: string;
};

export type HubServerMessage =
	| HubJoined
	| HubLeft
	| HubAgentEvent
	| HubActivityUpdate
	| HubQueueUpdate
	| HubPresenceUpdate
	| HubCommandResult
	| HubStateUpdate
	| HubExtensionUIOutbound
	| HubRolePlan
	| HubRoleProgress
	| HubRoleGap
	| HubRoomsList
	| HubRoomDeleted
	| HubSleepProgressMessage
	| HubSleepDoneMessage
	| HubError;
