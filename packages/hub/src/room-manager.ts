import { join, resolve } from "node:path";
import {
	AuthStorage,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
	getAgentDir,
	ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedHubModelsConfig, ResolvedHubRolesConfig } from "./config.ts";
import { Room } from "./room.ts";

export interface RoomManagerOptions {
	cwd: string;
	agentDir?: string;
	sessionPath?: string;
	defaultRoomId?: string;
	modelsConfig: ResolvedHubModelsConfig;
	rolesConfig: ResolvedHubRolesConfig;
	/** Test hook: override default createAgentSession */
	createSession?: (cwd: string, agentDir: string) => Promise<CreateAgentSessionResult>;
}

export class RoomManager {
	private readonly rooms = new Map<string, Room>();
	private readonly roomInit = new Map<string, Promise<Room>>();
	private readonly options: RoomManagerOptions;

	constructor(options: RoomManagerOptions) {
		this.options = options;
	}

	async getOrCreateRoom(roomId: string): Promise<Room> {
		const existing = this.rooms.get(roomId);
		if (existing) {
			return existing;
		}

		let init = this.roomInit.get(roomId);
		if (!init) {
			init = this.createRoom(roomId);
			this.roomInit.set(roomId, init);
		}

		const room = await init;
		this.rooms.set(roomId, room);
		this.roomInit.delete(roomId);
		return room;
	}

	async shutdown(): Promise<void> {
		for (const room of this.rooms.values()) {
			await room.stop();
		}
		this.rooms.clear();
	}

	private async createRoom(roomId: string): Promise<Room> {
		const sessionResult = await this.createSession();
		const room = new Room({
			roomId,
			sessionResult,
			cwd: resolve(this.options.cwd),
			rolesConfig: this.options.rolesConfig,
			modelsConfig: this.options.modelsConfig,
		});
		await room.start();
		await room.applyConfiguredSessionModel();
		return room;
	}

	private async createSession(): Promise<CreateAgentSessionResult> {
		const cwd = resolve(this.options.cwd);
		const agentDir = this.options.agentDir ?? getAgentDir();

		if (this.options.createSession) {
			return this.options.createSession(cwd, agentDir);
		}

		const sessionManager = this.options.sessionPath
			? SessionManager.open(resolve(this.options.sessionPath))
			: SessionManager.create(cwd);

		const authStorage = AuthStorage.create(agentDir ? join(agentDir, "auth.json") : undefined);
		const modelRegistry = ModelRegistry.create(authStorage, agentDir ? join(agentDir, "models.json") : undefined);

		const createOptions: CreateAgentSessionOptions = {
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			sessionManager,
		};

		return createAgentSession(createOptions);
	}
}
