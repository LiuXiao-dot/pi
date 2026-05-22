import type { AgentSession, AgentSessionEvent, CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";
import type { WebSocket } from "ws";
import type { ResolvedHubModelsConfig, ResolvedHubRolesConfig } from "./config.ts";
import { ExtensionUiRouter } from "./extension-ui.ts";
import { normalizeImageAttachments } from "./image-mime.ts";
import { type ResolvedMentions, resolveMessageMentions } from "./mentions.ts";
import { listHubModels } from "./model-info.ts";
import {
	applyRoleModelOverrides,
	buildRoleModelEntries,
	parseModelRef,
	persistRoleModelOverride,
} from "./models-config.ts";
import { PromptQueue } from "./prompt-queue.ts";
import type {
	HubActivityPhase,
	HubActivityUpdate,
	HubClientMessage,
	HubCommandResult,
	HubExtensionUIOutbound,
	HubExtensionUIRequest,
	HubMentionWarning,
	HubPresenceMember,
	HubPresenceUpdate,
	HubQueueUpdate,
	HubRoleGap,
	HubRolePlan,
	HubRoleProgress,
	HubRoleSummaryEntry,
	HubRoomInfo,
	HubServerMessage,
	HubSkillSummaryEntry,
} from "./protocol.ts";
import { RoleOrchestrator } from "./role-orchestrator.ts";
import { discoverRoles } from "./roles/discovery.ts";
import { buildRoomContext, buildRoomContextSummaries } from "./room-context.ts";
import type { RoomConfigFile, RoomRegistry } from "./room-registry.ts";
import { safeStringify } from "./safe-json.ts";
import { buildSessionState } from "./state-snapshot.ts";

export interface RoomClient {
	id: string;
	displayName: string;
	socket: WebSocket;
}

export interface RoomOptions {
	roomId: string;
	sessionResult: CreateAgentSessionResult;
	cwd: string;
	rolesConfig: ResolvedHubRolesConfig;
	modelsConfig: ResolvedHubModelsConfig;
	roomConfig: RoomConfigFile;
	registry: RoomRegistry;
	/** Mutable holder for room context text. Used to rebuild system prompt on config change. */
	roomContextHolder?: { text: string };
}

export class Room {
	readonly roomId: string;
	readonly session: AgentSession;
	readonly cwd: string;
	readonly modelsConfig: ResolvedHubModelsConfig;
	private readonly rolesConfig: ResolvedHubRolesConfig;
	private readonly registry: RoomRegistry;
	private readonly roomContextHolder: { text: string } | undefined;
	private roomConfig: RoomConfigFile;
	private roleModelOverrides: Record<string, string>;
	private queueAbortController: AbortController | null = null;
	private readonly roleOrchestrator: RoleOrchestrator | undefined;
	private readonly clients = new Map<string, RoomClient>();
	private unsubscribeSession: (() => void) | undefined;
	private readonly extensionUi: ExtensionUiRouter;
	private readonly queue: PromptQueue;
	private activityPhase: HubActivityPhase = "idle";
	private activityDetail: string | undefined;
	private activityHostDisplayName: string | null = null;
	/** Server-side mutex: true while a sleep operation is in progress. */
	private sleeping = false;

	constructor(options: RoomOptions) {
		this.roomId = options.roomId;
		this.session = options.sessionResult.session;
		this.cwd = options.cwd;
		this.modelsConfig = options.modelsConfig;
		this.rolesConfig = options.rolesConfig;
		this.registry = options.registry;
		this.roomConfig = options.roomConfig;
		this.roleModelOverrides = { ...options.modelsConfig.roleModels };
		this.roomContextHolder = options.roomContextHolder;

		const roleOrchestrator = this.isRolesEnabledForRoom()
			? new RoleOrchestrator({
					session: this.session,
					cwd: options.cwd,
					roomId: options.roomId,
					registry: options.registry,
					rolesConfig: options.rolesConfig,
					getRoomConfig: () => this.roomConfig,
					getRoleModelOverrides: () => this.roleModelOverrides,
					onBroadcast: (msg) => this.broadcastRoleEvent(msg),
				})
			: undefined;
		this.roleOrchestrator = roleOrchestrator;

		this.queue = new PromptQueue(
			this.session,
			(update) => {
				this.broadcast(update);
				this.syncActivityFromQueue();
			},
			{
				roleOrchestrator,
				getAbortSignal: () => this.queueAbortController?.signal,
				onTurnStart: () => {
					this.queueAbortController = new AbortController();
				},
				onTurnEnd: () => {
					this.queueAbortController = null;
				},
				onQueueError: (item, message) => {
					const who = item.displayName ? `${item.displayName}: ` : "";
					this.broadcast({
						type: "error",
						code: "queue_failed",
						message: `${who}${message}`,
					});
				},
			},
		);

		this.extensionUi = new ExtensionUiRouter(
			(request, targetClientId) => this.broadcastExtensionUi(request, targetClientId),
			() => this.queue.getTurnOriginClientId(),
		);
	}

	isRolesEnabledForRoom(): boolean {
		if (this.roomConfig.rolesEnabled === true) {
			return true;
		}
		if (this.roomConfig.rolesEnabled === false) {
			return false;
		}
		return this.rolesConfig.enabled;
	}

	reloadRoomConfig(config: RoomConfigFile): void {
		this.roomConfig = config;
		// Rebuild room context and refresh system prompt so the AI
		// immediately learns about changed roles, skills, or rules.
		if (this.roomContextHolder) {
			const title = this.registry.getRoom(this.roomId)?.title;
			this.roomContextHolder.text = buildRoomContext({
				roomId: this.roomId,
				title,
				workspace: this.cwd,
				cwd: this.cwd,
				rolesConfig: { rolesDir: this.rolesConfig.rolesDir },
				roomConfig: config,
			});
			void this.session.reload();
		}
		// Broadcast updated room info so all clients see the new badges.
		this.broadcastRoomInfo();
	}

	/** Broadcast room metadata (title, roles, skills, rules, model) to all clients. */
	broadcastRoomInfo(): void {
		const title = this.registry.getRoom(this.roomId)?.title;
		const summaries = buildRoomContextSummaries({
			roomId: this.roomId,
			title,
			workspace: this.cwd,
			cwd: this.cwd,
			rolesConfig: { rolesDir: this.rolesConfig.rolesDir },
			roomConfig: this.roomConfig,
		});
		const currentModel = this.session.model;
		this.broadcast({
			type: "room_info",
			roomId: this.roomId,
			roomTitle: title,
			roomRoles: summaries.roles,
			roomSkills: summaries.skills,
			roomRules: this.roomConfig.rules,
			roomModel: currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined,
		});
	}

	private broadcastRoleEvent(message: HubRolePlan | HubRoleGap | HubRoleProgress): void {
		this.broadcast(message);
	}

	/**
	 * If the user typed @tokens that don't resolve to any room role or present user,
	 * broadcast a warning so all room members see it. Falls through silently when
	 * every mention resolved (or the message had no mentions at all).
	 */
	private broadcastMentionWarning(
		command: HubMentionWarning["command"],
		requestId: string | undefined,
		mentions: ResolvedMentions,
		fromDisplayName: string | undefined,
	): void {
		if (mentions.unknown.length === 0) {
			return;
		}
		const warning: HubMentionWarning = {
			type: "mention_warning",
			roomId: this.roomId,
			requestId,
			command,
			unknown: mentions.unknown,
			resolvedRoles: mentions.roles,
			resolvedUsers: mentions.users,
			fromDisplayName,
		};
		this.broadcast(warning);
	}

	async listCatalogModels() {
		return listHubModels(this.session.modelRegistry, this.modelsConfig.catalog);
	}

	async buildModelsConfigPayload() {
		const models = await this.listCatalogModels();
		const discovery = discoverRoles({
			cwd: this.cwd,
			rolesDir: this.rolesConfig.rolesDir,
		});
		const rolesWithModels = applyRoleModelOverrides(discovery.roles, this.roleModelOverrides);
		return {
			models,
			catalog: this.modelsConfig.catalog,
			sessionModelRef: this.modelsConfig.sessionModelRef,
			roles: buildRoleModelEntries(rolesWithModels, this.roleModelOverrides),
		};
	}

	/** Apply models.session from hub.json, or first catalog model with auth if session is unavailable. */
	async applyConfiguredSessionModel(): Promise<void> {
		const model = await this.resolveSessionModel();
		if (!model) {
			return;
		}
		await this.session.setModel(model);
	}

	private async resolveSessionModel() {
		const available = await this.session.modelRegistry.getAvailable();
		const findRef = (refStr: string | undefined) => {
			const ref = refStr ? parseModelRef(refStr) : undefined;
			if (!ref) {
				return undefined;
			}
			return available.find((m) => m.provider === ref.provider && m.id === ref.modelId);
		};

		const sessionRef = this.modelsConfig.sessionModelRef;
		const sessionModel = findRef(sessionRef);
		if (sessionModel) {
			return sessionModel;
		}

		if (sessionRef) {
			console.warn(`[pi-hub] models.session not available: ${sessionRef}; trying models.catalog fallback`);
		}

		for (const entry of this.modelsConfig.catalog) {
			const model = findRef(entry);
			if (model && this.session.modelRegistry.hasConfiguredAuth(model)) {
				console.log(`[pi-hub] Using catalog session model: ${entry}`);
				return model;
			}
		}

		for (const entry of this.modelsConfig.catalog) {
			const model = findRef(entry);
			if (model) {
				console.warn(`[pi-hub] Using catalog session model without auth: ${entry}`);
				return model;
			}
		}

		return undefined;
	}

	async start(): Promise<void> {
		await this.session.bindExtensions({
			uiContext: this.extensionUi.createContext(),
			onError: (err) => {
				console.error(`[pi-hub] extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		this.unsubscribeSession = this.session.subscribe((event) => {
			this.handleSessionEvent(event);
		});
	}

	async stop(): Promise<void> {
		this.unsubscribeSession?.();
		this.unsubscribeSession = undefined;
		for (const client of this.clients.values()) {
			client.socket.close();
		}
		this.clients.clear();
	}

	addClient(socket: WebSocket, displayName: string): RoomClient {
		const client: RoomClient = {
			id: crypto.randomUUID(),
			displayName: displayName.trim() || "anonymous",
			socket,
		};
		this.clients.set(client.id, client);
		this.broadcastPresence();
		return client;
	}

	removeClient(clientId: string): void {
		if (!this.clients.delete(clientId)) {
			return;
		}
		this.broadcastPresence();
	}

	getClientCount(): number {
		return this.clients.size;
	}

	private getPresenceDisplayNames(): string[] {
		return [...this.clients.values()].map((c) => c.displayName);
	}

	getClient(clientId: string): RoomClient | undefined {
		return this.clients.get(clientId);
	}

	sendJoined(client: RoomClient): void {
		this.send(client, this.buildJoinedMessage(client));
		this.send(client, {
			type: "queue_update",
			pending: [],
			current: null,
		});
		this.broadcastPresence();
	}

	private buildJoinedMessage(client: RoomClient) {
		const title = this.registry.getRoom(this.roomId)?.title;
		const summaries = buildRoomContextSummaries({
			roomId: this.roomId,
			title,
			workspace: this.cwd,
			cwd: this.cwd,
			rolesConfig: { rolesDir: this.rolesConfig.rolesDir },
			roomConfig: this.roomConfig,
		});
		const currentModel = this.session.model;
		return {
			type: "joined" as const,
			clientId: client.id,
			roomId: this.roomId,
			state: buildSessionState(this.session),
			messages: this.session.messages,
			workspace: this.cwd,
			roomTitle: title,
			roomRoles: summaries.roles.map((r) => ({
				name: r.name,
				description: r.description,
				who: r.who,
				can: r.can,
				when: r.when,
			})) as HubRoleSummaryEntry[],
			roomSkills: summaries.skills.map((s) => ({
				name: s.name,
				source: s.source,
				description: s.description,
			})) as HubSkillSummaryEntry[],
			roomRules: this.roomConfig.rules,
			roomModel: currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined,
		};
	}

	async handleMessage(client: RoomClient, message: HubClientMessage): Promise<void> {
		switch (message.type) {
			case "join":
				this.sendError(client, "already_joined", "Send join only before room membership is established");
				return;

			case "prompt": {
				const imageResult = normalizeImageAttachments(message.images);
				if (imageResult.rejected.length > 0) {
					this.sendCommandResult(
						client,
						"prompt",
						message.id,
						false,
						`Unsupported image type(s): ${imageResult.rejected.join(", ")}. Use JPEG, PNG, GIF, or WebP.`,
					);
					return;
				}
				const mentions = resolveMessageMentions(message.message, {
					roleNames: this.roomConfig.roleNames ?? [],
					userNames: this.getPresenceDisplayNames(),
				});
				this.broadcastMentionWarning("prompt", message.id, mentions, client.displayName);
				const result = this.queue.enqueue({
					command: "prompt",
					clientId: client.id,
					displayName: client.displayName,
					message: message.message,
					images: imageResult.images,
					streamingBehavior: message.streamingBehavior,
					mentionedRoles: mentions.roles,
					mentionedUsers: mentions.users,
					id: message.id,
				});
				this.sendCommandResult(client, "prompt", message.id, result.accepted, result.error);
				return;
			}

			case "steer": {
				const imageResult = normalizeImageAttachments(message.images);
				if (imageResult.rejected.length > 0) {
					this.sendCommandResult(
						client,
						"steer",
						message.id,
						false,
						`Unsupported image type(s): ${imageResult.rejected.join(", ")}. Use JPEG, PNG, GIF, or WebP.`,
					);
					return;
				}
				this.broadcastMentionWarning(
					"steer",
					message.id,
					resolveMessageMentions(message.message, {
						roleNames: this.roomConfig.roleNames ?? [],
						userNames: this.getPresenceDisplayNames(),
					}),
					client.displayName,
				);
				const result = this.queue.enqueue({
					command: "steer",
					clientId: client.id,
					displayName: client.displayName,
					message: message.message,
					images: imageResult.images,
					id: message.id,
				});
				this.sendCommandResult(client, "steer", message.id, result.accepted, result.error);
				return;
			}

			case "follow_up": {
				const imageResult = normalizeImageAttachments(message.images);
				if (imageResult.rejected.length > 0) {
					this.sendCommandResult(
						client,
						"follow_up",
						message.id,
						false,
						`Unsupported image type(s): ${imageResult.rejected.join(", ")}. Use JPEG, PNG, GIF, or WebP.`,
					);
					return;
				}
				this.broadcastMentionWarning(
					"follow_up",
					message.id,
					resolveMessageMentions(message.message, {
						roleNames: this.roomConfig.roleNames ?? [],
						userNames: this.getPresenceDisplayNames(),
					}),
					client.displayName,
				);
				const result = this.queue.enqueue({
					command: "follow_up",
					clientId: client.id,
					displayName: client.displayName,
					message: message.message,
					images: imageResult.images,
					id: message.id,
				});
				this.sendCommandResult(client, "follow_up", message.id, result.accepted, result.error);
				return;
			}

			case "abort": {
				try {
					this.queueAbortController?.abort();
					await this.session.abort();
					this.sendCommandResult(client, "abort", message.id, true);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.sendCommandResult(client, "abort", message.id, false, msg);
				}
				return;
			}

			case "abort_task": {
				const taskId = typeof message.taskId === "string" ? message.taskId : "";
				if (!taskId) {
					this.sendCommandResult(client, "abort_task", message.id, false, "taskId required");
					return;
				}
				const aborted = this.roleOrchestrator?.abortTask(taskId) ?? false;
				if (aborted) {
					this.sendCommandResult(client, "abort_task", message.id, true);
				} else {
					this.sendCommandResult(client, "abort_task", message.id, false, "task not found");
				}
				return;
			}

			case "get_state": {
				this.send(client, this.buildJoinedMessage(client));
				this.sendCommandResult(client, "get_state", message.id, true);
				return;
			}

			case "get_available_models": {
				try {
					const models = await this.listCatalogModels();
					this.sendCommandResult(client, "get_available_models", message.id, true, undefined, { models });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.sendCommandResult(client, "get_available_models", message.id, false, msg);
				}
				return;
			}

			case "get_models_config": {
				try {
					const payload = await this.buildModelsConfigPayload();
					this.sendCommandResult(client, "get_models_config", message.id, true, undefined, payload);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.sendCommandResult(client, "get_models_config", message.id, false, msg);
				}
				return;
			}

			case "set_role_model": {
				try {
					const roleName = message.roleName.trim();
					if (!roleName) {
						this.sendCommandResult(client, "set_role_model", message.id, false, "roleName is required");
						return;
					}
					let modelRef: string | null = null;
					if (message.provider && message.modelId) {
						modelRef = `${message.provider}/${message.modelId}`;
						const catalogModels = await this.listCatalogModels();
						const found = catalogModels.some((m) => m.provider === message.provider && m.id === message.modelId);
						if (!found) {
							this.sendCommandResult(
								client,
								"set_role_model",
								message.id,
								false,
								`Model not in catalog: ${modelRef}`,
							);
							return;
						}
					}
					this.roleModelOverrides = persistRoleModelOverride(this.cwd, roleName, modelRef);
					const payload = await this.buildModelsConfigPayload();
					this.sendCommandResult(client, "set_role_model", message.id, true, undefined, payload);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.sendCommandResult(client, "set_role_model", message.id, false, msg);
				}
				return;
			}

			case "set_model": {
				try {
					const catalogModels = await this.listCatalogModels();
					const modelInfo = catalogModels.find((m) => m.provider === message.provider && m.id === message.modelId);
					if (!modelInfo) {
						this.sendCommandResult(
							client,
							"set_model",
							message.id,
							false,
							`Model not found in catalog: ${message.provider}/${message.modelId}`,
						);
						return;
					}
					const models = await this.session.modelRegistry.getAvailable();
					const model = models.find((m) => m.provider === message.provider && m.id === message.modelId);
					if (!model) {
						this.sendCommandResult(
							client,
							"set_model",
							message.id,
							false,
							`Model not found: ${message.provider}/${message.modelId}`,
						);
						return;
					}
					await this.session.setModel(model);
					this.broadcastStateUpdate();
					this.sendCommandResult(client, "set_model", message.id, true, undefined, {
						model: buildSessionState(this.session).model,
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.sendCommandResult(client, "set_model", message.id, false, msg);
				}
				return;
			}

			case "set_provider_base_url": {
				try {
					const provider = message.provider.trim();
					const baseUrl = message.baseUrl.trim();
					if (!provider || !baseUrl) {
						this.sendCommandResult(
							client,
							"set_provider_base_url",
							message.id,
							false,
							"provider and baseUrl are required",
						);
						return;
					}
					const available = await this.session.modelRegistry.getAvailable();
					if (!available.some((m) => m.provider === provider)) {
						this.sendCommandResult(
							client,
							"set_provider_base_url",
							message.id,
							false,
							`Unknown provider: ${provider}`,
						);
						return;
					}
					this.session.modelRegistry.registerProvider(provider, { baseUrl });
					const current = this.session.model;
					if (current?.provider === provider) {
						const updated = this.session.modelRegistry.find(provider, current.id);
						if (updated) {
							await this.session.setModel(updated);
						}
					}
					this.broadcastStateUpdate();
					const models = await this.listCatalogModels();
					this.sendCommandResult(client, "set_provider_base_url", message.id, true, undefined, { models });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.sendCommandResult(client, "set_provider_base_url", message.id, false, msg);
				}
				return;
			}

			case "extension_ui_response": {
				if (!this.extensionUi.handleResponse(message)) {
					this.sendError(client, "unknown_extension_ui", `No pending extension UI request: ${message.id}`);
				}
				return;
			}
		}
	}

	private handleSessionEvent(event: AgentSessionEvent): void {
		try {
			if (event.type === "agent_end") {
				this.queue.notifyAgentIdle();
			}
			this.updateActivityFromEvent(event);
			const hostDisplayName = this.queue.getTurnOriginDisplayName() ?? undefined;
			this.broadcast({ type: "agent_event", event, hostDisplayName });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[pi-hub] session event error: ${message}`);
		}
	}

	private syncActivityFromQueue(): void {
		if (this.queue.getTurnOriginDisplayName() === null && !this.session.isStreaming && !this.session.isCompacting) {
			this.setActivity("idle");
		}
	}

	private updateActivityFromEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
			case "turn_start":
				this.setActivity("replying");
				return;
			case "message_update": {
				const sub = event.assistantMessageEvent?.type;
				if (sub === "thinking_delta") {
					this.setActivity("thinking");
				} else if (sub === "text_delta") {
					this.setActivity("replying");
				}
				return;
			}
			case "tool_execution_start":
				this.setActivity("tool", event.toolName);
				return;
			case "tool_execution_end":
				this.setActivity(this.session.isStreaming ? "replying" : "idle");
				return;
			case "compaction_start":
				this.setActivity("compacting", event.reason);
				return;
			case "compaction_end":
				this.setActivity(this.session.isStreaming ? "replying" : "idle");
				return;
			case "agent_end":
				this.setActivity(this.session.isStreaming ? "replying" : "idle");
				return;
		}
	}

	private setActivity(phase: HubActivityPhase, detail?: string): void {
		const hostDisplayName = this.queue.getTurnOriginDisplayName();
		if (
			this.activityPhase === phase &&
			this.activityDetail === detail &&
			this.activityHostDisplayName === hostDisplayName
		) {
			return;
		}
		this.activityPhase = phase;
		this.activityDetail = detail;
		this.activityHostDisplayName = hostDisplayName;
		const update: HubActivityUpdate = {
			type: "activity_update",
			hostDisplayName,
			phase,
			detail,
		};
		this.broadcast(update);
	}

	private broadcastExtensionUi(request: HubExtensionUIRequest, targetClientId: string | null): void {
		const waitingForDisplayName =
			targetClientId !== null ? (this.clients.get(targetClientId)?.displayName ?? "operator") : undefined;
		const outbound: HubExtensionUIOutbound = {
			...request,
			targetClientId,
			waitingForDisplayName,
		};
		this.broadcast(outbound);
	}

	private broadcastPresence(): void {
		const update: HubPresenceUpdate = {
			type: "presence",
			members: [...this.clients.values()].map(
				(c): HubPresenceMember => ({
					clientId: c.id,
					displayName: c.displayName,
				}),
			),
		};
		this.broadcast(update);
	}

	broadcastRoomDeleted(): void {
		this.broadcast({ type: "room_deleted", roomId: this.roomId });
	}

	broadcast(
		message: HubServerMessage | HubQueueUpdate | HubRolePlan | HubRoleGap | HubRoleProgress | HubRoomInfo,
	): void {
		const data = safeStringify(message);
		if (!data) {
			return;
		}
		for (const client of this.clients.values()) {
			if (client.socket.readyState === client.socket.OPEN) {
				client.socket.send(data);
			}
		}
	}

	private send(client: RoomClient, message: HubServerMessage | HubQueueUpdate): void {
		if (client.socket.readyState !== client.socket.OPEN) {
			return;
		}
		const data = safeStringify(message);
		if (data) {
			client.socket.send(data);
		}
	}

	private broadcastStateUpdate(): void {
		this.broadcast({ type: "state_update", state: buildSessionState(this.session) });
	}

	private sendCommandResult(
		client: RoomClient,
		command: string,
		id: string | undefined,
		success: boolean,
		error?: string,
		data?: unknown,
	): void {
		const result: HubCommandResult = { type: "command_result", command, id, success, error, data };
		this.send(client, result);
	}

	private sendError(client: RoomClient, code: string, message: string): void {
		this.send(client, { type: "error", code, message });
	}

	/** Send current session state + messages to all clients (used after session clear). */
	sendClientUpdate(): void {
		for (const client of this.clients.values()) {
			const joined = this.buildJoinedMessage(client);
			this.send(client, { ...joined, messages: [] });
		}
	}

	/**
	 * True when the room cannot accept rebirth / sleep right now: there is an
	 * in-flight session turn, compaction is running, or a sleep is already
	 * underway.
	 */
	isBusy(): boolean {
		return (
			this.sleeping ||
			this.session.isStreaming ||
			this.session.isCompacting ||
			this.queue.getTurnOriginDisplayName() !== null
		);
	}

	/** Acquire the server-side sleep mutex. Returns false if another sleep is already in progress. */
	beginSleep(): boolean {
		if (this.sleeping) return false;
		this.sleeping = true;
		this.setActivity("sleeping");
		return true;
	}

	/** Release the sleep mutex and restore activity to idle. */
	endSleep(): void {
		this.sleeping = false;
		this.setActivity(this.session.isStreaming ? "replying" : "idle");
	}

	/**
	 * Abort any in-flight queue turn. Used by rebirth/sleep when the caller has
	 * already confirmed they want to discard the running work.
	 */
	abortInflight(): void {
		this.queueAbortController?.abort();
	}

	/**
	 * Reset the agent and rotate to a fresh session file in the same room
	 * directory, then propagate the new path back to the registry so a
	 * subsequent hub restart resumes from this new session instead of the
	 * pre-rebirth/sleep file.
	 *
	 * Also broadcasts an empty `joined` (via `sendClientUpdate`) and a
	 * `room_session_cleared` event so every connected client purges its local
	 * reply / turn cache.
	 */
	clearAndRotateSession(reason: "rebirth" | "sleep"): void {
		this.session.agent.reset();
		this.session.sessionManager.newSession();
		const newFile = this.session.sessionManager.getSessionFile();
		if (newFile) {
			try {
				this.registry.updateSessionFile(this.roomId, newFile);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(`[pi-hub] failed to update sessionFile for room ${this.roomId}: ${message}`);
			}
		}
		this.sendClientUpdate();
		this.broadcast({ type: "room_session_cleared", roomId: this.roomId, reason });
	}

	/** Broadcast a hub server message to all clients in the room. */
	broadcastMessage(message: HubServerMessage): void {
		this.broadcast(message);
	}
}
