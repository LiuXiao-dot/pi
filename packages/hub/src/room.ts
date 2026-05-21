import type { AgentSession, AgentSessionEvent, CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";
import type { WebSocket } from "ws";
import type { ResolvedHubModelsConfig, ResolvedHubRolesConfig } from "./config.ts";
import { ExtensionUiRouter } from "./extension-ui.ts";
import { listHubModels } from "./model-info.ts";
import {
	applyRoleModelOverrides,
	buildRoleModelEntries,
	parseModelRef,
	persistRoleModelOverride,
} from "./models-config.ts";
import { PromptQueue } from "./prompt-queue.ts";
import type {
	HubClientMessage,
	HubCommandResult,
	HubExtensionUIOutbound,
	HubExtensionUIRequest,
	HubPresenceMember,
	HubPresenceUpdate,
	HubQueueUpdate,
	HubRoleGap,
	HubRolePlan,
	HubRoleProgress,
	HubServerMessage,
} from "./protocol.ts";
import { RoleOrchestrator } from "./role-orchestrator.ts";
import { discoverRoles } from "./roles/discovery.ts";
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
}

export class Room {
	readonly roomId: string;
	readonly session: AgentSession;
	readonly cwd: string;
	readonly modelsConfig: ResolvedHubModelsConfig;
	private readonly rolesConfig: ResolvedHubRolesConfig;
	private roleModelOverrides: Record<string, string>;
	private readonly clients = new Map<string, RoomClient>();
	private unsubscribeSession: (() => void) | undefined;
	private readonly extensionUi: ExtensionUiRouter;
	private readonly queue: PromptQueue;

	constructor(options: RoomOptions) {
		this.roomId = options.roomId;
		this.session = options.sessionResult.session;
		this.cwd = options.cwd;
		this.modelsConfig = options.modelsConfig;
		this.rolesConfig = options.rolesConfig;
		this.roleModelOverrides = { ...options.modelsConfig.roleModels };

		this.extensionUi = new ExtensionUiRouter(
			(request, targetClientId) => this.broadcastExtensionUi(request, targetClientId),
			() => this.queue.getTurnOriginClientId(),
		);

		const roleOrchestrator = options.rolesConfig.enabled
			? new RoleOrchestrator({
					session: this.session,
					cwd: options.cwd,
					rolesConfig: options.rolesConfig,
					getRoleModelOverrides: () => this.roleModelOverrides,
					onBroadcast: (msg) => this.broadcastRoleEvent(msg),
				})
			: undefined;

		this.queue = new PromptQueue(this.session, (update) => this.broadcast(update), {
			roleOrchestrator,
		});
	}

	private broadcastRoleEvent(message: HubRolePlan | HubRoleGap | HubRoleProgress): void {
		this.broadcast(message);
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

	/** Apply models.session from hub.json if configured. */
	async applyConfiguredSessionModel(): Promise<void> {
		const ref = this.modelsConfig.sessionModelRef ? parseModelRef(this.modelsConfig.sessionModelRef) : undefined;
		if (!ref) {
			return;
		}
		const available = await this.session.modelRegistry.getAvailable();
		const model = available.find((m) => m.provider === ref.provider && m.id === ref.modelId);
		if (!model) {
			console.warn(`[pi-hub] models.session not found: ${this.modelsConfig.sessionModelRef}`);
			return;
		}
		await this.session.setModel(model);
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

	getClient(clientId: string): RoomClient | undefined {
		return this.clients.get(clientId);
	}

	sendJoined(client: RoomClient): void {
		this.send(client, {
			type: "joined",
			clientId: client.id,
			roomId: this.roomId,
			state: buildSessionState(this.session),
			messages: this.session.messages,
		});
		this.send(client, {
			type: "queue_update",
			pending: [],
			current: null,
		});
		this.broadcastPresence();
	}

	async handleMessage(client: RoomClient, message: HubClientMessage): Promise<void> {
		switch (message.type) {
			case "join":
				this.sendError(client, "already_joined", "Send join only before room membership is established");
				return;

			case "prompt": {
				const result = this.queue.enqueue({
					command: "prompt",
					clientId: client.id,
					displayName: client.displayName,
					message: message.message,
					images: message.images,
					streamingBehavior: message.streamingBehavior,
					id: message.id,
				});
				this.sendCommandResult(client, "prompt", message.id, result.accepted, result.error);
				return;
			}

			case "steer": {
				const result = this.queue.enqueue({
					command: "steer",
					clientId: client.id,
					displayName: client.displayName,
					message: message.message,
					images: message.images,
					id: message.id,
				});
				this.sendCommandResult(client, "steer", message.id, result.accepted, result.error);
				return;
			}

			case "follow_up": {
				const result = this.queue.enqueue({
					command: "follow_up",
					clientId: client.id,
					displayName: client.displayName,
					message: message.message,
					images: message.images,
					id: message.id,
				});
				this.sendCommandResult(client, "follow_up", message.id, result.accepted, result.error);
				return;
			}

			case "abort": {
				try {
					await this.session.abort();
					this.sendCommandResult(client, "abort", message.id, true);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.sendCommandResult(client, "abort", message.id, false, msg);
				}
				return;
			}

			case "get_state": {
				this.send(client, {
					type: "joined",
					clientId: client.id,
					roomId: this.roomId,
					state: buildSessionState(this.session),
					messages: this.session.messages,
				});
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
			this.broadcast({ type: "agent_event", event });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[pi-hub] session event error: ${message}`);
		}
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

	broadcast(message: HubServerMessage | HubQueueUpdate | HubRolePlan | HubRoleGap | HubRoleProgress): void {
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
}
