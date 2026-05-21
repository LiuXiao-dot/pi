import type { AgentSession, AgentSessionEvent, CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";
import type { WebSocket } from "ws";
import { ExtensionUiRouter } from "./extension-ui.ts";
import { listHubModels } from "./model-info.ts";
import { PromptQueue } from "./prompt-queue.ts";
import type {
	HubClientMessage,
	HubCommandResult,
	HubExtensionUIOutbound,
	HubExtensionUIRequest,
	HubPresenceMember,
	HubPresenceUpdate,
	HubQueueUpdate,
	HubServerMessage,
} from "./protocol.ts";
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
}

export class Room {
	readonly roomId: string;
	readonly session: AgentSession;
	private readonly clients = new Map<string, RoomClient>();
	private unsubscribeSession: (() => void) | undefined;
	private readonly extensionUi: ExtensionUiRouter;
	private readonly queue: PromptQueue;

	constructor(options: RoomOptions) {
		this.roomId = options.roomId;
		this.session = options.sessionResult.session;

		this.extensionUi = new ExtensionUiRouter(
			(request, targetClientId) => this.broadcastExtensionUi(request, targetClientId),
			() => this.queue.getTurnOriginClientId(),
		);

		this.queue = new PromptQueue(this.session, (update) => this.broadcast(update));
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
					const models = await listHubModels(this.session.modelRegistry);
					this.sendCommandResult(client, "get_available_models", message.id, true, undefined, { models });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.sendCommandResult(client, "get_available_models", message.id, false, msg);
				}
				return;
			}

			case "set_model": {
				try {
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
					const models = await listHubModels(this.session.modelRegistry);
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

	broadcast(message: HubServerMessage | HubQueueUpdate): void {
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
