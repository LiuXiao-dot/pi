import type {
	HubClientMessage,
	HubCommandResultMessage,
	HubModelInfo,
	HubModelsConfigPayload,
	HubRoleContentPayload,
	HubRoleMemory,
	HubRoleSummaryPayload,
	HubRoomConfigPayload,
	HubRoomSummary,
	HubServerMessage,
} from "./protocol.ts";

export type MessageHandler = (msg: HubServerMessage) => void;

function uuidV4(): string {
	const c = globalThis.crypto as Crypto | undefined;
	if (c && typeof c.randomUUID === "function") return c.randomUUID();
	const bytes = new Uint8Array(16);
	if (c && typeof c.getRandomValues === "function") {
		c.getRandomValues(bytes);
	} else {
		for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex: string[] = [];
	for (let i = 0; i < 16; i++) hex.push(bytes[i]!.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

type CommandResolver = {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
};

export class HubClient {
	private ws: WebSocket | null = null;
	private handlers: MessageHandler[] = [];
	private readonly pendingCommands = new Map<string, CommandResolver>();
	private readonly hubUrl: string;
	private roomId: string;
	private readonly token: string;
	private readonly displayName: string;
	private joined = false;
	private socketOpenSettled = false;

	constructor(hubUrl: string, roomId: string, token: string, displayName: string) {
		this.hubUrl = hubUrl;
		this.roomId = roomId;
		this.token = token;
		this.displayName = displayName;
	}

	getRoomId(): string {
		return this.roomId;
	}

	isJoined(): boolean {
		return this.joined;
	}

	isSocketOpen(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	onMessage(handler: MessageHandler): () => void {
		this.handlers.push(handler);
		return () => {
			this.handlers = this.handlers.filter((h) => h !== handler);
		};
	}

	private resetMembership(): void {
		this.joined = false;
	}

	private notifyHandlers(msg: HubServerMessage): void {
		for (const h of this.handlers) {
			h(msg);
		}
	}

	private handleSocketClosed(): void {
		this.resetMembership();
		this.notifyHandlers({ type: "connection_lost" });
	}

	private closeExistingSocket(): void {
		if (!this.ws) {
			return;
		}
		const existing = this.ws;
		existing.onopen = null;
		existing.onmessage = null;
		existing.onerror = null;
		existing.onclose = null;
		if (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING) {
			existing.close();
		}
		this.ws = null;
	}

	/** Open WebSocket only (no join). */
	openSocket(): Promise<void> {
		this.closeExistingSocket();
		this.socketOpenSettled = false;

		return new Promise((resolve, reject) => {
			let settled = false;
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				reject(error);
			};

			const timeoutId = setTimeout(() => {
				fail(new Error("Connection timed out waiting for hub."));
				this.ws?.close();
			}, 30_000);

			this.ws = new WebSocket(this.hubUrl);
			this.ws.onopen = () => {
				if (!settled) {
					settled = true;
					this.socketOpenSettled = true;
					clearTimeout(timeoutId);
					resolve();
				}
			};
			this.ws.onmessage = (ev) => this.dispatchMessage(ev);
			this.ws.onerror = () => fail(new Error(`WebSocket error connecting to ${this.hubUrl}`));
			this.ws.onclose = (ev) => {
				clearTimeout(timeoutId);
				if (this.socketOpenSettled) {
					this.handleSocketClosed();
				}
				if (!settled) {
					fail(new Error(`WebSocket closed (${ev.code})`));
				}
			};
		});
	}

	connect(): Promise<void> {
		return this.openSocket().then(() => this.join(this.roomId));
	}

	reconnect(roomId: string): Promise<void> {
		return this.switchRoom(roomId);
	}

	leave(): Promise<void> {
		if (!this.joined) {
			return Promise.resolve();
		}
		if (!this.isSocketOpen()) {
			this.resetMembership();
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const timeoutId = setTimeout(() => {
				this.resetMembership();
				resolve();
			}, 30_000);

			const unsub = this.onMessage((msg) => {
				if (msg.type === "left") {
					clearTimeout(timeoutId);
					unsub();
					this.joined = false;
					resolve();
				}
				if (msg.type === "error" && msg.code === "not_joined") {
					clearTimeout(timeoutId);
					unsub();
					this.joined = false;
					resolve();
				}
			});

			this.send({ type: "leave" });
		});
	}

	async switchRoom(roomId: string): Promise<void> {
		if (this.joined) {
			try {
				await this.leave();
			} catch {
				this.resetMembership();
			}
		}
		if (!this.isSocketOpen()) {
			this.resetMembership();
			await this.openSocket();
		}
		await this.join(roomId);
	}

	join(roomId: string): Promise<void> {
		this.roomId = roomId;
		if (this.joined) {
			return Promise.reject(new Error("Already joined; call leave() first"));
		}
		if (!this.isSocketOpen()) {
			return Promise.reject(new Error("WebSocket is not open"));
		}
		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				reject(new Error("Join timed out"));
			}, 120_000);

			const unsub = this.onMessage((msg) => {
				if (msg.type === "joined") {
					clearTimeout(timeoutId);
					unsub();
					this.joined = true;
					resolve();
				}
				if (
					msg.type === "error" &&
					(msg.code === "join_failed" || msg.code === "room_not_found" || msg.code === "already_joined")
				) {
					clearTimeout(timeoutId);
					unsub();
					reject(new Error(String(msg.message ?? msg.code)));
				}
			});

			this.send({
				type: "join",
				roomId: this.roomId,
				token: this.token,
				displayName: this.displayName,
			});
		});
	}

	private dispatchMessage(ev: MessageEvent): void {
		try {
			const msg = JSON.parse(String(ev.data)) as HubServerMessage;
			this.handleCommandResult(msg);
			this.notifyHandlers(msg);
		} catch {
			// ignore
		}
	}

	private handleCommandResult(msg: HubServerMessage): void {
		if (msg.type !== "command_result") return;
		const result = msg as HubCommandResultMessage;
		if (!result.id) return;
		const pending = this.pendingCommands.get(result.id);
		if (!pending) return;
		this.pendingCommands.delete(result.id);
		if (result.success) {
			pending.resolve(result.data);
		} else {
			pending.reject(new Error(result.error ?? `${result.command} failed`));
		}
	}

	private sendCommand<T>(message: HubClientMessage, timeoutMs = 30_000): Promise<T> {
		const id = uuidV4();
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingCommands.delete(id);
				reject(new Error(`Command timed out: ${message.type}`));
			}, timeoutMs);

			this.pendingCommands.set(id, {
				resolve: (data) => {
					clearTimeout(timer);
					resolve(data as T);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});

			this.send({ ...message, id });
		});
	}

	send(msg: HubClientMessage): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	async listRooms(): Promise<HubRoomSummary[]> {
		const data = await this.sendCommand<{ rooms: HubRoomSummary[] }>({
			type: "list_rooms",
			token: this.token,
		});
		return data.rooms ?? [];
	}

	async createRoom(roomId: string, title?: string): Promise<void> {
		await this.sendCommand({
			type: "create_room",
			token: this.token,
			roomId,
			title,
		});
	}

	async deleteRoom(roomId: string, deleteFiles = true): Promise<void> {
		await this.sendCommand({
			type: "delete_room",
			token: this.token,
			roomId,
			deleteFiles,
		});
	}

	async getRoomConfig(roomId: string): Promise<HubRoomConfigPayload> {
		const data = await this.sendCommand<{ config: HubRoomConfigPayload }>({
			type: "get_room_config",
			token: this.token,
			roomId,
		});
		return data.config ?? {};
	}

	async setRoomConfig(roomId: string, config: HubRoomConfigPayload): Promise<HubRoomConfigPayload> {
		const data = await this.sendCommand<{ config: HubRoomConfigPayload }>({
			type: "set_room_config",
			token: this.token,
			roomId,
			config,
		});
		return data.config ?? config;
	}

	async addRoomRole(roleName: string, roomId = this.roomId): Promise<HubRoomConfigPayload> {
		const data = await this.sendCommand<{ config: HubRoomConfigPayload }>({
			type: "add_room_role",
			token: this.token,
			roomId,
			roleName,
		});
		return data.config ?? {};
	}

	async removeRoomRole(roleName: string, roomId = this.roomId): Promise<HubRoomConfigPayload> {
		const data = await this.sendCommand<{ config: HubRoomConfigPayload }>({
			type: "remove_room_role",
			token: this.token,
			roomId,
			roleName,
		});
		return data.config ?? {};
	}

	async listSkills(): Promise<Array<{ name: string; source: string; description?: string }>> {
		const data = await this.sendCommand<{ skills: Array<{ name: string; source: string; description?: string }> }>({
			type: "list_skills",
			token: this.token,
		});
		return data.skills ?? [];
	}

	async getSkillContent(name: string): Promise<{ name: string; source: string; filePath: string; content: string }> {
		return this.sendCommand({
			type: "get_skill_content",
			token: this.token,
			name,
		});
	}

	async clearRoomSession(roomId: string): Promise<void> {
		await this.sendCommand({
			type: "clear_room_session",
			token: this.token,
			roomId,
		});
	}

	abort(): void {
		this.send({ type: "abort" });
	}

	abortTask(taskId: string): void {
		this.send({ type: "abort_task", taskId });
	}

	async sleepRoom(roomId: string): Promise<void> {
		await this.sendCommand({
			type: "sleep_room",
			token: this.token,
			roomId,
		});
	}

	async getRoleMemory(roleName: string): Promise<HubRoleMemory[]> {
		const data = await this.sendCommand<{ memories: HubRoleMemory[] }>({
			type: "get_role_memory",
			token: this.token,
			roleName,
		});
		return data.memories ?? [];
	}

	async deleteRoleMemory(roleName: string, seq: number): Promise<void> {
		await this.sendCommand({
			type: "delete_role_memory",
			token: this.token,
			roleName,
			seq,
		});
	}

	async clearRoleMemory(roleName: string): Promise<void> {
		await this.sendCommand({
			type: "clear_role_memory",
			token: this.token,
			roleName,
		});
	}

	async listRoles(): Promise<HubRoleSummaryPayload[]> {
		const data = await this.sendCommand<{ roles: HubRoleSummaryPayload[] }>({
			type: "list_roles",
			token: this.token,
		});
		return data.roles ?? [];
	}

	async getRole(name: string): Promise<HubRoleContentPayload> {
		return this.sendCommand<HubRoleContentPayload>({
			type: "get_role",
			token: this.token,
			name,
		});
	}

	async saveRole(name: string, content: string): Promise<HubRoleContentPayload> {
		return this.sendCommand<HubRoleContentPayload>({
			type: "save_role",
			token: this.token,
			name,
			content,
		});
	}

	async deleteRole(name: string): Promise<void> {
		await this.sendCommand({
			type: "delete_role",
			token: this.token,
			name,
		});
	}

	async getAvailableModels(): Promise<HubModelInfo[]> {
		const data = await this.sendCommand<{ models: HubModelInfo[] }>({ type: "get_available_models" });
		return data.models ?? [];
	}

	async getModelsConfig(): Promise<HubModelsConfigPayload> {
		return this.sendCommand<HubModelsConfigPayload>({ type: "get_models_config" });
	}

	async setRoleModel(
		roleName: string,
		provider: string | null,
		modelId: string | null,
	): Promise<HubModelsConfigPayload> {
		if (provider === null || modelId === null) {
			return this.sendCommand<HubModelsConfigPayload>({ type: "set_role_model", roleName });
		}
		return this.sendCommand<HubModelsConfigPayload>({
			type: "set_role_model",
			roleName,
			provider,
			modelId,
		});
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		await this.sendCommand({ type: "set_model", provider, modelId });
	}

	async setProviderBaseUrl(provider: string, baseUrl: string): Promise<HubModelInfo[]> {
		const data = await this.sendCommand<{ models: HubModelInfo[] }>({
			type: "set_provider_base_url",
			provider,
			baseUrl,
		});
		return data.models ?? [];
	}

	prompt(
		message: string,
		options?: {
			images?: Array<{ type: "image"; data: string; mimeType: string }>;
		},
	): void {
		const payload: Record<string, unknown> = { type: "prompt", message };
		if (options?.images && options.images.length > 0) {
			payload.images = options.images;
		}
		this.send(payload);
	}

	extensionUiResponse(response: HubClientMessage): void {
		this.send(response);
	}

	disconnect(): void {
		this.resetMembership();
		this.socketOpenSettled = false;
		this.closeExistingSocket();
		for (const pending of this.pendingCommands.values()) {
			pending.reject(new Error("Disconnected"));
		}
		this.pendingCommands.clear();
	}
}

export function defaultWsUrl(): string {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	return `${proto}//${location.host}/ws`;
}
