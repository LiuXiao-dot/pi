import { readdir } from "node:fs/promises";
import { resolve as resolvePath, sep } from "node:path";
import type { WebSocket } from "ws";
import type { ResolvedHubRolesConfig } from "./config.ts";
import type { HubCommandResult, HubRoomConfigPayload, HubScopedClientMessage } from "./protocol.ts";
import {
	appendRoleMemory,
	clearRoleMemory as clearRoleMemoryStore,
	deleteRoleMemory,
	loadRoleMemory,
} from "./roles/memory-store.ts";
import {
	deleteRoleFile,
	getRoleContent,
	listRoleSummaries,
	RoleStoreError,
	saveRoleContent,
} from "./roles/role-store.ts";
import { getSkillContent, listSkillFiles } from "./roles/skill-store.ts";
import type { RoomManager } from "./room-manager.ts";
import { RoomRegistryError, resolveRoomWorkspace } from "./room-registry.ts";
import {
	addRoomRoleName,
	assertRolesExist,
	normalizeRoleNames,
	removeRoomRoleName,
	type ValidateRoomRolesOptions,
} from "./room-roles.ts";

export interface HubAdminOptions {
	token: string;
	roomManager: RoomManager;
	rolesConfig: ResolvedHubRolesConfig;
	cwd: string;
}

export class HubAdmin {
	private readonly options: HubAdminOptions;

	constructor(options: HubAdminOptions) {
		this.options = options;
	}

	private roleValidateOptions(): ValidateRoomRolesOptions {
		return { cwd: this.options.cwd, rolesDir: this.options.rolesConfig.rolesDir };
	}

	private reloadActiveRoomConfig(roomId: string, config: ReturnType<RoomManager["registry"]["loadRoomConfig"]>): void {
		const active = this.options.roomManager.getActiveRoom(roomId);
		if (active) {
			active.reloadRoomConfig(config);
		}
	}

	async handle(ws: WebSocket, message: HubScopedClientMessage): Promise<void> {
		if (!this.checkToken(message.token)) {
			this.send(ws, { type: "error", code: "unauthorized", message: "Invalid token" });
			return;
		}

		try {
			switch (message.type) {
				case "list_rooms":
					await this.handleListRooms(ws, message.id);
					return;
				case "create_room":
					await this.handleCreateRoom(ws, message.roomId, message.title, message.workspace, message.id);
					return;
				case "delete_room":
					await this.handleDeleteRoom(ws, message.roomId, message.deleteFiles, message.id);
					return;
				case "get_room_config":
					await this.handleGetRoomConfig(ws, message.roomId, message.id);
					return;
				case "set_room_config":
					await this.handleSetRoomConfig(ws, message.roomId, message.config, message.id);
					return;
				case "add_room_role":
					await this.handleAddRoomRole(ws, message.roomId, message.roleName, message.id);
					return;
				case "remove_room_role":
					await this.handleRemoveRoomRole(ws, message.roomId, message.roleName, message.id);
					return;
				case "set_room_roles":
					await this.handleSetRoomRoles(ws, message.roomId, message.roleNames, message.id);
					return;
				case "list_roles":
					await this.handleListRoles(ws, message.id);
					return;
				case "get_role":
					await this.handleGetRole(ws, message.name, message.id);
					return;
				case "save_role":
					await this.handleSaveRole(ws, message.name, message.content, message.id);
					return;
				case "delete_role":
					await this.handleDeleteRole(ws, message.name, message.id);
					return;
				case "list_skills":
					await this.handleListSkills(ws, message.roomId, message.id);
					return;
				case "get_skill_content":
					await this.handleGetSkillContent(ws, message.name, message.id);
					return;
				case "clear_room_session":
					await this.handleClearRoomSession(ws, message.roomId, message.id);
					return;
				case "sleep_room":
					await this.handleSleepRoom(ws, message.roomId, message.id);
					return;
				case "get_role_memory":
					await this.handleGetRoleMemory(ws, message.roleName, message.id);
					return;
				case "delete_role_memory":
					await this.handleDeleteRoleMemory(ws, message.roleName, message.seq, message.id);
					return;
				case "clear_role_memory":
					await this.handleClearRoleMemory(ws, message.roleName, message.id);
					return;
				case "list_directory":
					await this.handleListDirectory(ws, message.path, message.id);
					return;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const code =
				err instanceof RoomRegistryError ? err.code : err instanceof RoleStoreError ? err.code : "internal";
			this.sendCommandResult(ws, message.type, message.id, false, msg, undefined);
			if (message.type !== "list_rooms") {
				this.send(ws, { type: "error", code, message: msg });
			}
		}
	}

	private checkToken(clientToken: string): boolean {
		return clientToken.trim() === this.options.token.trim();
	}

	private async handleListRooms(ws: WebSocket, id?: string): Promise<void> {
		const entries = this.options.roomManager.listRooms();
		const rooms = entries.map((e) => ({
			roomId: e.roomId,
			title: e.title,
			createdAt: e.createdAt,
			updatedAt: e.updatedAt,
			clientCount: this.options.roomManager.getActiveRoom(e.roomId)?.getClientCount() ?? 0,
		}));
		this.send(ws, { type: "rooms_list", rooms });
		this.sendCommandResult(ws, "list_rooms", id, true, undefined, { rooms });
	}

	private async handleCreateRoom(
		ws: WebSocket,
		roomId: string,
		title: string | undefined,
		workspace: string | undefined,
		id?: string,
	): Promise<void> {
		const entry = this.options.roomManager.createRoom(roomId, title, workspace);
		const rooms = this.options.roomManager.listRooms().map((e) => ({
			roomId: e.roomId,
			title: e.title,
			createdAt: e.createdAt,
			updatedAt: e.updatedAt,
			clientCount: 0,
		}));
		this.send(ws, { type: "rooms_list", rooms });
		this.sendCommandResult(ws, "create_room", id, true, undefined, { room: entry });
	}

	private async handleDeleteRoom(
		ws: WebSocket,
		roomId: string,
		deleteFiles: boolean | undefined,
		id?: string,
	): Promise<void> {
		const active = this.options.roomManager.getActiveRoom(roomId);
		if (active) {
			active.broadcastRoomDeleted();
		}
		await this.options.roomManager.deleteRoom(roomId, { deleteFiles: deleteFiles !== false });
		this.send(ws, { type: "room_deleted", roomId });
		const rooms = this.options.roomManager.listRooms().map((e) => ({
			roomId: e.roomId,
			title: e.title,
			createdAt: e.createdAt,
			updatedAt: e.updatedAt,
			clientCount: 0,
		}));
		this.send(ws, { type: "rooms_list", rooms });
		this.sendCommandResult(ws, "delete_room", id, true);
	}

	private handleGetRoomConfig(ws: WebSocket, roomId: string, id?: string): void {
		const config = this.options.roomManager.registry.loadRoomConfig(roomId);
		this.sendCommandResult(ws, "get_room_config", id, true, undefined, { config });
	}

	private handleSetRoomConfig(ws: WebSocket, roomId: string, config: HubRoomConfigPayload, id?: string): void {
		const saved = this.options.roomManager.registry.saveRoomConfig(roomId, config, this.roleValidateOptions());
		this.reloadActiveRoomConfig(roomId, saved);
		this.sendCommandResult(ws, "set_room_config", id, true, undefined, { config: saved });
	}

	private handleAddRoomRole(ws: WebSocket, roomId: string, roleName: string, id?: string): void {
		const validateOpts = this.roleValidateOptions();
		const name = roleName.trim();
		assertRolesExist([name], validateOpts);
		const current = this.options.roomManager.registry.loadRoomConfig(roomId);
		const roleNames = addRoomRoleName(current.roleNames, name);
		const saved = this.options.roomManager.registry.saveRoomConfig(roomId, { roleNames }, validateOpts);
		this.reloadActiveRoomConfig(roomId, saved);
		this.sendCommandResult(ws, "add_room_role", id, true, undefined, { config: saved });
	}

	private handleRemoveRoomRole(ws: WebSocket, roomId: string, roleName: string, id?: string): void {
		const validateOpts = this.roleValidateOptions();
		const current = this.options.roomManager.registry.loadRoomConfig(roomId);
		const roleNames = removeRoomRoleName(current.roleNames, roleName);
		const saved = this.options.roomManager.registry.saveRoomConfig(roomId, { roleNames }, validateOpts);
		this.reloadActiveRoomConfig(roomId, saved);
		this.sendCommandResult(ws, "remove_room_role", id, true, undefined, { config: saved });
	}

	private handleSetRoomRoles(ws: WebSocket, roomId: string, roleNames: string[], id?: string): void {
		const validateOpts = this.roleValidateOptions();
		const normalized = normalizeRoleNames(roleNames);
		assertRolesExist(normalized, validateOpts);
		const saved = this.options.roomManager.registry.saveRoomConfig(roomId, { roleNames: normalized }, validateOpts);
		this.reloadActiveRoomConfig(roomId, saved);
		this.sendCommandResult(ws, "set_room_roles", id, true, undefined, { config: saved });
	}

	private handleListRoles(ws: WebSocket, id?: string): void {
		const roles = listRoleSummaries(this.options.cwd, this.options.rolesConfig.rolesDir);
		this.sendCommandResult(ws, "list_roles", id, true, undefined, { roles });
	}

	private handleGetRole(ws: WebSocket, name: string, id?: string): void {
		const role = getRoleContent(this.options.cwd, this.options.rolesConfig.rolesDir, name);
		this.sendCommandResult(ws, "get_role", id, true, undefined, role);
	}

	private handleSaveRole(ws: WebSocket, name: string, content: string, id?: string): void {
		const role = saveRoleContent(this.options.cwd, this.options.rolesConfig.rolesDir, name, content);
		this.sendCommandResult(ws, "save_role", id, true, undefined, role);
	}

	private handleDeleteRole(ws: WebSocket, name: string, id?: string): void {
		deleteRoleFile(this.options.cwd, this.options.rolesConfig.rolesDir, name, {
			pmRole: this.options.rolesConfig.pmRole,
		});
		this.sendCommandResult(ws, "delete_role", id, true);
	}

	private handleListSkills(ws: WebSocket, roomId: string | undefined, id?: string): void {
		const cwd = roomId
			? resolveRoomWorkspace(this.options.cwd, this.options.roomManager.registry.loadRoomConfig(roomId))
			: this.options.cwd;
		const skills = listSkillFiles({ cwd });
		this.sendCommandResult(ws, "list_skills", id, true, undefined, { skills });
	}

	private handleGetSkillContent(ws: WebSocket, name: string, id?: string): void {
		const skill = getSkillContent(this.options.cwd, name);
		if (!skill) {
			this.sendCommandResult(ws, "get_skill_content", id, false, `Skill "${name}" not found`);
			return;
		}
		this.sendCommandResult(ws, "get_skill_content", id, true, undefined, skill);
	}

	private handleClearRoomSession(ws: WebSocket, roomId: string, id?: string): void {
		const room = this.options.roomManager.getActiveRoom(roomId);
		if (!room) {
			this.sendCommandResult(ws, "clear_room_session", id, false, `Room "${roomId}" not active`);
			return;
		}
		// In-flight protection: refuse rebirth while the room is replying / sleeping.
		if (room.isBusy()) {
			this.sendCommandResult(
				ws,
				"clear_room_session",
				id,
				false,
				"Room is busy (replying, compacting, or sleeping). Wait for the current turn to finish.",
			);
			return;
		}
		room.clearAndRotateSession("rebirth");
		this.sendCommandResult(ws, "clear_room_session", id, true);
	}

	private async handleSleepRoom(ws: WebSocket, roomId: string, id?: string): Promise<void> {
		const room = this.options.roomManager.getActiveRoom(roomId);
		if (!room) {
			this.sendCommandResult(ws, "sleep_room", id, false, `Room "${roomId}" not active`);
			return;
		}
		// In-flight protection: refuse if the room is replying or already sleeping.
		if (room.isBusy()) {
			const err = "Room is busy (replying, compacting, or sleeping). Wait for the current turn to finish.";
			this.sendCommandResult(ws, "sleep_room", id, false, err);
			room.broadcastMessage({ type: "sleep_done", roomId, success: false, memories: [], error: err });
			return;
		}
		if (!room.beginSleep()) {
			const err = "Another sleep is already in progress for this room.";
			this.sendCommandResult(ws, "sleep_room", id, false, err);
			room.broadcastMessage({ type: "sleep_done", roomId, success: false, memories: [], error: err });
			return;
		}

		try {
			const messages = room.session.messages;

			// Phase 1: extracting (real async tick so clients see the phase change).
			room.broadcastMessage({ type: "sleep_progress", roomId, phase: "extracting" });
			await new Promise((r) => setImmediate(r));

			const extracted: Array<{ ts: string; room: string; goal: string; result: string; roleName: string }> = [];
			for (const msg of messages) {
				if (msg.role !== "custom") continue;
				const cm = msg as { customType?: string; content?: string; details?: Record<string, unknown> };
				if (cm.customType !== "hub_role_output" || !cm.details?.role) continue;
				const roleName = cm.details.role as string;
				const output = (cm.content as string) ?? "";
				if (!output.trim()) continue;

				// Prefer structured fields populated by role-orchestrator; fall back to
				// content-based heuristics only when older messages lack details.
				const structuredTask = typeof cm.details.task === "string" ? (cm.details.task as string).trim() : "";
				const exitCodeRaw = cm.details.exitCode;
				const exitCode = typeof exitCodeRaw === "number" ? exitCodeRaw : Number.NaN;

				let goal = structuredTask;
				if (!goal) {
					const goalLine = output.match(/Task:\s*(.+?)(?:\n|$)/);
					goal = goalLine?.[1]?.trim() ?? output.slice(0, 80);
				}

				// Strip the leading `[role] (status)` and `Task: ...` lines so result
				// holds the actual assistant output rather than the framing.
				const body = output
					.replace(/^\[[^\]]+\]\s*\((?:completed|failed)\)\s*\n?/i, "")
					.replace(/^Task:\s*.+?\n+/i, "")
					.trim();
				const statusLabel = Number.isFinite(exitCode) ? (exitCode === 0 ? "completed" : "failed") : "completed";
				const summary = body.length > 600 ? `${body.slice(0, 600)}…` : body;
				const result = `(${statusLabel}) ${summary}`.trim();

				extracted.push({ ts: new Date().toISOString(), room: roomId, goal, result, roleName });
			}

			// Phase 2: storing
			room.broadcastMessage({ type: "sleep_progress", roomId, phase: "storing" });
			await new Promise((r) => setImmediate(r));

			const byRole = new Map<string, typeof extracted>();
			for (const e of extracted) {
				if (!byRole.has(e.roleName)) byRole.set(e.roleName, []);
				byRole.get(e.roleName)!.push(e);
			}

			const allStored: Array<{
				seq: number;
				ts: string;
				room: string;
				goal: string;
				result: string;
				roleName: string;
			}> = [];
			const seenPerRole = new Map<string, Set<string>>();

			for (const [roleName, items] of byRole) {
				if (!seenPerRole.has(roleName)) seenPerRole.set(roleName, new Set());
				const seen = seenPerRole.get(roleName)!;
				const unique = items.filter((m) => {
					if (seen.has(m.goal)) return false;
					seen.add(m.goal);
					return true;
				});
				if (unique.length === 0) continue;
				appendRoleMemory(this.options.cwd, roleName, unique);
				const fresh = loadRoleMemory(this.options.cwd, roleName);
				allStored.push(...fresh.slice(-unique.length));
			}

			// Phase 3: clearing
			room.broadcastMessage({ type: "sleep_progress", roomId, phase: "clearing" });
			await new Promise((r) => setImmediate(r));

			// Single source of truth: reset agent, rotate session file, sync
			// registry, sendClientUpdate, broadcast room_session_cleared.
			room.clearAndRotateSession("sleep");

			this.sendCommandResult(ws, "sleep_room", id, true, undefined, { roomId, memories: allStored });
			room.broadcastMessage({ type: "sleep_done", roomId, success: true, memories: allStored });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.sendCommandResult(ws, "sleep_room", id, false, message);
			room.broadcastMessage({ type: "sleep_done", roomId, success: false, memories: [], error: message });
		} finally {
			room.endSleep();
		}
	}

	private handleGetRoleMemory(ws: WebSocket, roleName: string, id?: string): void {
		const memories = loadRoleMemory(this.options.cwd, roleName);
		this.sendCommandResult(ws, "get_role_memory", id, true, undefined, { memories });
	}

	private handleDeleteRoleMemory(ws: WebSocket, roleName: string, seq: number, id?: string): void {
		deleteRoleMemory(this.options.cwd, roleName, seq);
		this.sendCommandResult(ws, "delete_role_memory", id, true);
	}

	private async handleListDirectory(ws: WebSocket, dirPath: string | undefined, id?: string): Promise<void> {
		const hubRoot = resolvePath(this.options.cwd);
		const base = resolvePath(hubRoot, dirPath ?? ".");
		// Prevent directory traversal above the hub workspace root.
		if (!base.startsWith(hubRoot + sep) && base !== hubRoot) {
			this.sendCommandResult(ws, "list_directory", id, false, `Access denied: path is outside the hub workspace`);
			return;
		}
		const entries: Array<{ name: string; isDirectory: boolean }> = [];
		try {
			const dirents = await readdir(base, { withFileTypes: true });
			for (const d of dirents) {
				if (d.isDirectory() || d.isSymbolicLink()) {
					entries.push({ name: d.name, isDirectory: true });
				}
			}
			entries.sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			this.sendCommandResult(ws, "list_directory", id, false, `Cannot read directory: ${base}`);
			return;
		}
		this.sendCommandResult(ws, "list_directory", id, true, undefined, { path: base, entries });
	}

	private handleClearRoleMemory(ws: WebSocket, roleName: string, id?: string): void {
		clearRoleMemoryStore(this.options.cwd, roleName);
		this.sendCommandResult(ws, "clear_role_memory", id, true);
	}

	private send(ws: WebSocket, message: object): void {
		if (ws.readyState === ws.OPEN) {
			ws.send(JSON.stringify(message));
		}
	}

	private sendCommandResult(
		ws: WebSocket,
		command: string,
		id: string | undefined,
		success: boolean,
		error?: string,
		data?: unknown,
	): void {
		const result: HubCommandResult = { type: "command_result", command, id, success, error, data };
		this.send(ws, result);
	}
}
