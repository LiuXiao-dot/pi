import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	AuthStorage,
	type CreateAgentSessionResult,
	createAgentSession,
	DefaultResourceLoader,
	findMostRecentSession,
	getAgentDir,
	ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedHubModelsConfig, ResolvedHubRolesConfig } from "./config.ts";
import { Room } from "./room.ts";
import { buildRoomContext } from "./room-context.ts";
import { RoomRegistry, RoomRegistryError, resolveRoomWorkspace } from "./room-registry.ts";

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

	createRoom(roomId: string, title?: string, workspace?: string) {
		return this.registry.createRoom(roomId, { title, workspace });
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
		const roomConfig = this.registry.loadRoomConfig(roomId);
		const workspace = resolveRoomWorkspace(this.options.cwd, roomConfig);
		const roomTitle = this.registry.getRoom(roomId)?.title;
		const roomContextHolder = { text: "" };
		roomContextHolder.text = buildRoomContext({
			roomId,
			title: roomTitle,
			workspace,
			cwd: this.options.cwd,
			rolesConfig: { rolesDir: this.options.rolesConfig.rolesDir },
			roomConfig,
		});
		const sessionResult = await this.createSessionForRoom(roomId, roomContextHolder);
		const room = new Room({
			roomId,
			sessionResult,
			cwd: workspace,
			rolesConfig: this.options.rolesConfig,
			modelsConfig: this.options.modelsConfig,
			roomConfig,
			registry: this.registry,
			roomContextHolder,
		});
		await room.start();
		await room.applyConfiguredSessionModel();
		return room;
	}

	private async createSessionForRoom(
		roomId: string,
		roomContextHolder?: { text: string },
	): Promise<CreateAgentSessionResult> {
		const hubCwd = resolve(this.options.cwd);
		const roomConfig = this.registry.loadRoomConfig(roomId);
		const agentDir = this.options.agentDir ?? getAgentDir();
		const workspace = resolveRoomWorkspace(hubCwd, roomConfig);

		if (this.options.createSession) {
			const sessionFile = this.registry.getSessionPath(roomId);
			return this.options.createSession(roomId, workspace, agentDir, sessionFile);
		}

		const appendOverride = roomContextHolder ? (base: string[]) => [roomContextHolder.text, ...base] : undefined;

		if (this.options.sessionPath) {
			const sessionFile = resolve(this.options.sessionPath);
			const sessionManager = SessionManager.open(sessionFile, undefined, workspace);
			const authStorage = AuthStorage.create(agentDir ? join(agentDir, "auth.json") : undefined);
			const modelRegistry = ModelRegistry.create(authStorage, agentDir ? join(agentDir, "models.json") : undefined);
			const resourceLoader = new DefaultResourceLoader({
				cwd: workspace,
				agentDir,
				appendSystemPromptOverride: appendOverride,
			});
			await resourceLoader.reload();
			return createAgentSession({
				cwd: workspace,
				agentDir,
				authStorage,
				modelRegistry,
				sessionManager,
				resourceLoader,
			});
		}

		const sessionFile = this.registry.getSessionPath(roomId);
		const sessionDir = resolve(sessionFile, "..");

		let sessionManager: SessionManager;
		if (hasSessionContent(sessionFile)) {
			sessionManager = SessionManager.open(sessionFile, undefined, workspace);
		} else {
			const recovered = existsSync(sessionDir) ? findMostRecentSession(sessionDir) : null;
			if (recovered) {
				console.warn(
					`[pi-hub] room ${roomId}: registry sessionFile missing (${sessionFile}); recovering most recent session ${recovered}`,
				);
				sessionManager = SessionManager.open(recovered, undefined, workspace);
				this.registry.updateSessionFile(roomId, recovered);
			} else {
				sessionManager = SessionManager.create(workspace, sessionDir);
				const actualFile = sessionManager.getSessionFile();
				if (actualFile && actualFile !== sessionFile) {
					this.registry.updateSessionFile(roomId, actualFile);
				}
			}
		}

		const authStorage = AuthStorage.create(agentDir ? join(agentDir, "auth.json") : undefined);
		const modelRegistry = ModelRegistry.create(authStorage, agentDir ? join(agentDir, "models.json") : undefined);

		const resourceLoader = new DefaultResourceLoader({
			cwd: workspace,
			agentDir,
			appendSystemPromptOverride: appendOverride,
		});
		await resourceLoader.reload();
		return createAgentSession({
			cwd: workspace,
			agentDir,
			authStorage,
			modelRegistry,
			sessionManager,
			resourceLoader,
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
