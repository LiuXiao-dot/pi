import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { prepareRoomConfigPatch, type ValidateRoomRolesOptions } from "./room-roles.ts";

const MAX_ROOM_ID_LENGTH = 64;
/** Unicode letters (e.g. Chinese), numbers, hyphen, underscore. */
const ROOM_ID_PATTERN = /^[\p{L}\p{N}_-][\p{L}\p{N}_-]{0,63}$/u;
const SESSION_FILENAME = "session.jsonl";
const CONFIG_FILENAME = "config.json";

export interface RoomRoleOverride {
	skills?: string[];
	rules?: string;
	tools?: string[];
	model?: string;
}

export interface RoomConfigFile {
	/** Role names assigned to this room (ordered, unique). */
	roleNames?: string[];
	skills?: string[];
	rules?: string;
	roleOverrides?: Record<string, RoomRoleOverride>;
	rolesEnabled?: boolean;
}

export interface RoomIndexEntry {
	roomId: string;
	title?: string;
	createdAt: string;
	updatedAt: string;
	/** Path relative to cwd or absolute. */
	sessionFile: string;
}

export interface RoomsIndexFile {
	rooms: RoomIndexEntry[];
}

export class RoomRegistryError extends Error {
	readonly code: string;

	constructor(message: string, code: string) {
		super(message);
		this.name = "RoomRegistryError";
		this.code = code;
	}
}

function mergeRoomConfigSimple(patch: RoomConfigFile, current: RoomConfigFile): RoomConfigFile {
	return {
		...current,
		...patch,
		roleOverrides: patch.roleOverrides !== undefined ? patch.roleOverrides : current.roleOverrides,
	};
}

export function validateRoomId(roomId: string): string {
	const trimmed = roomId.trim();
	if (!trimmed) {
		throw new RoomRegistryError("roomId is required", "invalid_room_id");
	}
	if (trimmed.length > MAX_ROOM_ID_LENGTH) {
		throw new RoomRegistryError(`roomId must be at most ${MAX_ROOM_ID_LENGTH} characters`, "invalid_room_id");
	}
	if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
		throw new RoomRegistryError("roomId must not contain path separators", "invalid_room_id");
	}
	if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
		throw new RoomRegistryError("roomId must not contain control characters", "invalid_room_id");
	}
	if (!ROOM_ID_PATTERN.test(trimmed)) {
		throw new RoomRegistryError(
			"roomId must be 1-64 chars: letters (including Chinese), digits, hyphen, or underscore",
			"invalid_room_id",
		);
	}
	return trimmed;
}

export class RoomRegistry {
	private readonly cwd: string;
	private readonly hubDir: string;
	private readonly roomsDir: string;
	private readonly indexPath: string;

	constructor(cwd: string) {
		this.cwd = resolve(cwd);
		this.hubDir = join(this.cwd, ".pi", "hub");
		this.roomsDir = join(this.hubDir, "rooms");
		this.indexPath = join(this.hubDir, "rooms.json");
	}

	getHubDir(): string {
		return this.hubDir;
	}

	private ensureHubDir(): void {
		if (!existsSync(this.hubDir)) {
			mkdirSync(this.hubDir, { recursive: true });
		}
	}

	private readIndex(): RoomsIndexFile {
		this.ensureHubDir();
		if (!existsSync(this.indexPath)) {
			return { rooms: [] };
		}
		try {
			const raw = readFileSync(this.indexPath, "utf8");
			const parsed = JSON.parse(raw) as RoomsIndexFile;
			return { rooms: Array.isArray(parsed.rooms) ? parsed.rooms : [] };
		} catch {
			return { rooms: [] };
		}
	}

	private writeIndex(index: RoomsIndexFile): void {
		this.ensureHubDir();
		writeFileSync(this.indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
	}

	private roomDir(roomId: string): string {
		return join(this.roomsDir, validateRoomId(roomId));
	}

	private defaultSessionRelativePath(roomId: string): string {
		return join(".pi", "hub", "rooms", roomId, SESSION_FILENAME);
	}

	listRooms(): RoomIndexEntry[] {
		return this.readIndex().rooms;
	}

	getRoom(roomId: string): RoomIndexEntry | undefined {
		const id = validateRoomId(roomId);
		return this.readIndex().rooms.find((r) => r.roomId === id);
	}

	hasRoom(roomId: string): boolean {
		return this.getRoom(roomId) !== undefined;
	}

	/** Create registry entry and room directory. Does not create session file until resolveSessionPath. */
	createRoom(roomId: string, options?: { title?: string }): RoomIndexEntry {
		const id = validateRoomId(roomId);
		const index = this.readIndex();
		if (index.rooms.some((r) => r.roomId === id)) {
			throw new RoomRegistryError(`Room already exists: ${id}`, "room_exists");
		}

		const now = new Date().toISOString();
		const sessionFile = this.defaultSessionRelativePath(id);
		const entry: RoomIndexEntry = {
			roomId: id,
			title: options?.title?.trim() || undefined,
			createdAt: now,
			updatedAt: now,
			sessionFile,
		};

		const dir = this.roomDir(id);
		mkdirSync(dir, { recursive: true });
		if (!existsSync(join(dir, CONFIG_FILENAME))) {
			writeFileSync(join(dir, CONFIG_FILENAME), "{}\n", "utf8");
		}

		index.rooms.push(entry);
		this.writeIndex(index);
		return entry;
	}

	/** Ensure default room exists when index is empty. */
	ensureDefaultRoom(defaultRoomId: string): RoomIndexEntry {
		const id = validateRoomId(defaultRoomId);
		const existing = this.getRoom(id);
		if (existing) {
			return existing;
		}
		const index = this.readIndex();
		if (index.rooms.length > 0) {
			throw new RoomRegistryError(`Default room "${id}" not in registry`, "room_not_found");
		}
		return this.createRoom(id, { title: "Default" });
	}

	deleteRoom(roomId: string, options?: { deleteFiles?: boolean }): void {
		const id = validateRoomId(roomId);
		const deleteFiles = options?.deleteFiles !== false;
		const index = this.readIndex();
		const next = index.rooms.filter((r) => r.roomId !== id);
		if (next.length === index.rooms.length) {
			throw new RoomRegistryError(`Room not found: ${id}`, "room_not_found");
		}
		this.writeIndex({ rooms: next });

		if (deleteFiles) {
			const dir = this.roomDir(id);
			if (existsSync(dir)) {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	}

	/** Absolute path to session JSONL from registry (file may not exist yet). */
	getSessionPath(roomId: string): string {
		const id = validateRoomId(roomId);
		const entry = this.getRoom(id);
		if (!entry) {
			throw new RoomRegistryError(`Room not found: ${id}. Create it with create_room first.`, "room_not_found");
		}

		const absPath = resolve(this.cwd, entry.sessionFile);
		const dir = resolve(absPath, "..");
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		return absPath;
	}

	/** Update session file path after SessionManager creates a new file in the room directory. */
	updateSessionFile(roomId: string, absoluteSessionPath: string): void {
		const id = validateRoomId(roomId);
		const index = this.readIndex();
		const entry = index.rooms.find((r) => r.roomId === id);
		if (!entry) {
			throw new RoomRegistryError(`Room not found: ${id}`, "room_not_found");
		}
		const rel = absoluteSessionPath.startsWith(this.cwd)
			? absoluteSessionPath.slice(this.cwd.length).replace(/^[/\\]/, "")
			: absoluteSessionPath;
		entry.sessionFile = rel.split("\\").join("/");
		entry.updatedAt = new Date().toISOString();
		this.writeIndex(index);
	}

	touchRoom(roomId: string): void {
		const id = validateRoomId(roomId);
		const index = this.readIndex();
		const entry = index.rooms.find((r) => r.roomId === id);
		if (!entry) {
			return;
		}
		entry.updatedAt = new Date().toISOString();
		this.writeIndex(index);
	}

	loadRoomConfig(roomId: string): RoomConfigFile {
		const id = validateRoomId(roomId);
		const path = join(this.roomDir(id), CONFIG_FILENAME);
		if (!existsSync(path)) {
			return {};
		}
		try {
			const raw = readFileSync(path, "utf8");
			return JSON.parse(raw) as RoomConfigFile;
		} catch {
			return {};
		}
	}

	saveRoomConfig(roomId: string, patch: RoomConfigFile, options?: ValidateRoomRolesOptions): RoomConfigFile {
		const id = validateRoomId(roomId);
		if (!this.hasRoom(id)) {
			throw new RoomRegistryError(`Room not found: ${id}`, "room_not_found");
		}
		const dir = this.roomDir(id);
		mkdirSync(dir, { recursive: true });
		const current = this.loadRoomConfig(id);
		const merged = options ? prepareRoomConfigPatch(patch, current, options) : mergeRoomConfigSimple(patch, current);
		writeFileSync(join(dir, CONFIG_FILENAME), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
		this.touchRoom(id);
		return merged;
	}

	getRoomSkillsDir(roomId: string): string {
		const id = validateRoomId(roomId);
		return join(this.roomDir(id), "skills");
	}
}
