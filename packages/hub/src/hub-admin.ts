import type { WebSocket } from "ws";
import type { ResolvedHubRolesConfig } from "./config.ts";
import type { HubCommandResult, HubRoomConfigPayload, HubScopedClientMessage } from "./protocol.ts";
import {
	deleteRoleFile,
	getRoleContent,
	listRoleSummaries,
	RoleStoreError,
	saveRoleContent,
} from "./roles/role-store.ts";
import { getSkillContent, listSkillFiles } from "./roles/skill-store.ts";
import type { RoomManager } from "./room-manager.ts";
import { RoomRegistryError } from "./room-registry.ts";
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
					await this.handleCreateRoom(ws, message.roomId, message.title, message.id);
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
					await this.handleListSkills(ws, message.id);
					return;
				case "get_skill_content":
					await this.handleGetSkillContent(ws, message.name, message.id);
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
		id?: string,
	): Promise<void> {
		const entry = this.options.roomManager.createRoom(roomId, title);
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

	private handleListSkills(ws: WebSocket, id?: string): void {
		const skills = listSkillFiles({ cwd: this.options.cwd });
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
