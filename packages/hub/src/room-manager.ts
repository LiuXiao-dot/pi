import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	AuthStorage,
	type CreateAgentSessionResult,
	createAgentSession,
	findMostRecentSession,
	getAgentDir,
	ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedHubModelsConfig, ResolvedHubRolesConfig } from "./config.ts";
import { Room } from "./room.ts";
import { RoomRegistry, RoomRegistryError } from "./room-registry.ts";

export interface RoomManagerOptions {
	cwd: string;
	agentDir?: string;
	/** Legacy: single session file shared by all rooms (discouraged). */
	sessionPath?: string;
	defaultRoomId?: string;
	modelsConfig: ResolvedHubModelsConfig;
	rolesConfig: ResolvedHubRolesConfig;
	registry?: RoomRegistry;
	/** Test hook: override default createAgentSession */
	createSession?: (
		roomId: string,
		cwd: string,
		agentDir: string,
		sessionFile: string,
	) => Promise<CreateAgentSessionResult>;
}

export class RoomManager {
	private readonly rooms = new Map<string, Room>();
	private readonly roomInit = new Map<string, Promise<Room>>();
	private readonly options: RoomManagerOptions;
	readonly registry: RoomRegistry;

	constructor(options: RoomManagerOptions) {
		this.options = options;
		this.registry = options.registry ?? new RoomRegistry(options.cwd);
	}

	/** Ensure default room exists in registry at startup. */
	initialize(defaultRoomId: string): void {
		this.registry.ensureDefaultRoom(defaultRoomId);
	}

	listRooms(): ReturnType<RoomRegistry["listRooms"]> {
		return this.registry.listRooms();
	}

	createRoom(roomId: string, title?: string) {
		return this.registry.createRoom(roomId, { title });
	}

	async deleteRoom(roomId: string, options?: { deleteFiles?: boolean }): Promise<void> {
		const room = this.rooms.get(roomId);
		if (room) {
			await room.stop();
			this.rooms.delete(roomId);
		}
		this.roomInit.delete(roomId);
		this.registry.deleteRoom(roomId, options);
	}

	getActiveRoom(roomId: string): Room | undefined {
		return this.rooms.get(roomId);
	}

	async getOrCreateRoom(roomId: string): Promise<Room> {
		if (!this.registry.hasRoom(roomId)) {
			throw new RoomRegistryError(
				`Room "${roomId}" not found. Create it with create_room before joining.`,
				"room_not_found",
			);
		}

		const existing = this.rooms.get(roomId);
		if (existing) {
			return existing;
		}

		let init = this.roomInit.get(roomId);
		if (!init) {
			init = this.createRoomInstance(roomId);
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
		this.roomInit.clear();
	}

	private async createRoomInstance(roomId: string): Promise<Room> {
		const sessionResult = await this.createSessionForRoom(roomId);
		const roomConfig = this.registry.loadRoomConfig(roomId);
		const room = new Room({
			roomId,
			sessionResult,
			cwd: resolve(this.options.cwd),
			rolesConfig: this.options.rolesConfig,
			modelsConfig: this.options.modelsConfig,
			roomConfig,
			registry: this.registry,
		});
		await room.start();
		await room.applyConfiguredSessionModel();
		return room;
	}

	private async createSessionForRoom(roomId: string): Promise<CreateAgentSessionResult> {
		const cwd = resolve(this.options.cwd);
		const agentDir = this.options.agentDir ?? getAgentDir();

		if (this.options.createSession) {
			const sessionFile = this.registry.getSessionPath(roomId);
			return this.options.createSession(roomId, cwd, agentDir, sessionFile);
		}

		if (this.options.sessionPath) {
			const sessionFile = resolve(this.options.sessionPath);
			const sessionManager = SessionManager.open(sessionFile, undefined, cwd);
			const authStorage = AuthStorage.create(agentDir ? join(agentDir, "auth.json") : undefined);
			const modelRegistry = ModelRegistry.create(authStorage, agentDir ? join(agentDir, "models.json") : undefined);
			return createAgentSession({
				cwd,
				agentDir,
				authStorage,
				modelRegistry,
				sessionManager,
			});
		}

		const sessionFile = this.registry.getSessionPath(roomId);
		const sessionDir = resolve(sessionFile, "..");

		let sessionManager: SessionManager;
		if (hasSessionContent(sessionFile)) {
			sessionManager = SessionManager.open(sessionFile, undefined, cwd);
		} else {
			// Self-heal: the registry's sessionFile is missing or empty (e.g. a
			// rebirth/sleep rotated the session but never wrote the new path back
			// to the registry, leaving an orphan jsonl in the same directory).
			// Prefer the most recently modified valid session file in the room
			// directory before giving up and creating a brand-new empty session.
			const recovered = existsSync(sessionDir) ? findMostRecentSession(sessionDir) : null;
			if (recovered) {
				console.warn(
					`[pi-hub] room ${roomId}: registry sessionFile missing (${sessionFile}); recovering most recent session ${recovered}`,
				);
				sessionManager = SessionManager.open(recovered, undefined, cwd);
				this.registry.updateSessionFile(roomId, recovered);
			} else {
				sessionManager = SessionManager.create(cwd, sessionDir);
				const actualFile = sessionManager.getSessionFile();
				if (actualFile && actualFile !== sessionFile) {
					this.registry.updateSessionFile(roomId, actualFile);
				}
			}
		}

		const authStorage = AuthStorage.create(agentDir ? join(agentDir, "auth.json") : undefined);
		const modelRegistry = ModelRegistry.create(authStorage, agentDir ? join(agentDir, "models.json") : undefined);

		return createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			sessionManager,
		});
	}
}

function hasSessionContent(path: string): boolean {
	try {
		if (!existsSync(path)) {
			return false;
		}
		const st = statSync(path);
		if (!st.isFile()) {
			return false;
		}
		return readFileSync(path, "utf8").trim().length > 0;
	} catch {
		return false;
	}
}
