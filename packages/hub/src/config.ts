import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Model catalog and per-role/session defaults in hub.json. */
export interface HubModelsConfigFile {
	/** Models shown in Web UI dropdowns (`provider/modelId`). Empty = all registry models with auth. */
	catalog?: string[];
	/** Main session (synthesis) model ref. */
	session?: string;
	/** Per-role subprocess model refs. */
	roleModels?: Record<string, string>;
}

/** Multi-role orchestration settings in hub.json. */
export interface HubRolesConfigFile {
	enabled?: boolean;
	rolesDir?: string;
	pmRole?: string;
	maxParallel?: number;
	confirmProjectRoles?: boolean;
}

/** User-editable hub settings (JSON files). */
export interface HubConfigFile {
	token?: string;
	port?: number;
	host?: string;
	cwd?: string;
	session?: string;
	defaultRoomId?: string;
	/** Override static web root (normally set by CLI/build). */
	publicDir?: string;
	models?: HubModelsConfigFile;
	roles?: HubRolesConfigFile;
}

export type HubTokenSource = "env" | "cli" | "config";

export interface ResolvedHubModelsConfig {
	catalog: string[];
	sessionModelRef?: string;
	roleModels: Record<string, string>;
}

export interface ResolvedHubRolesConfig {
	enabled: boolean;
	rolesDir: string;
	pmRole: string;
	maxParallel: number;
	confirmProjectRoles: boolean;
}

export interface ResolvedHubConfig {
	token?: string;
	/** Where the active token came from (for startup logs). */
	tokenSource?: HubTokenSource;
	port: number;
	host: string;
	cwd: string;
	session?: string;
	defaultRoomId: string;
	publicDir?: string;
	models: ResolvedHubModelsConfig;
	roles: ResolvedHubRolesConfig;
	configPaths: string[];
}

export function normalizeHubToken(token: string | undefined): string | undefined {
	if (token === undefined) return undefined;
	const trimmed = token.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

const DEFAULT_PORT = 3141;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_ROOM_ID = "default";
const DEFAULT_ROLES_DIR = ".pi/roles";
const DEFAULT_PM_ROLE = "pm";
const DEFAULT_MAX_PARALLEL = 4;

export function resolveModelsConfig(file?: HubModelsConfigFile): ResolvedHubModelsConfig {
	const catalog = (file?.catalog ?? []).map((e) => e.trim()).filter((e) => e.length > 0);
	const sessionModelRef = file?.session?.trim() || undefined;
	const roleModels: Record<string, string> = {};
	if (file?.roleModels) {
		for (const [name, ref] of Object.entries(file.roleModels)) {
			const trimmed = ref.trim();
			if (trimmed.length > 0) {
				roleModels[name] = trimmed;
			}
		}
	}
	return { catalog, sessionModelRef, roleModels };
}

export function resolveRolesConfig(file?: HubRolesConfigFile): ResolvedHubRolesConfig {
	return {
		enabled: file?.enabled === true,
		rolesDir: file?.rolesDir ?? DEFAULT_ROLES_DIR,
		pmRole: file?.pmRole ?? DEFAULT_PM_ROLE,
		maxParallel: file?.maxParallel ?? DEFAULT_MAX_PARALLEL,
		confirmProjectRoles: file?.confirmProjectRoles !== false,
	};
}

export function globalConfigPath(): string {
	return join(homedir(), ".pi", "hub.json");
}

export function projectConfigPath(cwd: string): string {
	return join(resolve(cwd), ".pi", "hub.json");
}

export function loadConfigFile(path: string): HubConfigFile {
	if (!existsSync(path)) {
		return {};
	}
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as HubConfigFile;
		if (typeof parsed.token === "string") {
			parsed.token = parsed.token.trim();
		}
		return parsed;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${path}: ${message}`);
	}
}

function mergeConfig(base: HubConfigFile, next: HubConfigFile): HubConfigFile {
	return {
		...base,
		...next,
	};
}

function envString(name: string): string | undefined {
	const value = process.env[name];
	return value && value.length > 0 ? value : undefined;
}

function envNumber(name: string): number | undefined {
	const raw = envString(name);
	if (raw === undefined) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

export interface CliOverrides {
	configPath?: string;
	token?: string;
	port?: number;
	host?: string;
	cwd?: string;
	session?: string;
	defaultRoomId?: string;
	publicDir?: string;
}

/** Merge config files, then CLI flags, then environment variables. */
export function resolveHubConfig(overrides: CliOverrides, initialCwd: string): ResolvedHubConfig {
	const configPaths: string[] = [];
	let merged: HubConfigFile = {};

	const globalPath = globalConfigPath();
	if (existsSync(globalPath)) {
		merged = mergeConfig(merged, loadConfigFile(globalPath));
		configPaths.push(globalPath);
	}

	const projectPath = projectConfigPath(initialCwd);
	if (existsSync(projectPath)) {
		merged = mergeConfig(merged, loadConfigFile(projectPath));
		configPaths.push(projectPath);
	}

	if (overrides.configPath) {
		const explicit = resolve(overrides.configPath);
		merged = mergeConfig(merged, loadConfigFile(explicit));
		configPaths.push(explicit);
	} else {
		const envConfig = envString("PI_HUB_CONFIG");
		if (envConfig) {
			const explicit = resolve(envConfig);
			merged = mergeConfig(merged, loadConfigFile(explicit));
			configPaths.push(explicit);
		}
	}

	let token = merged.token;
	let port = merged.port ?? DEFAULT_PORT;
	let host = merged.host ?? DEFAULT_HOST;
	let cwd = merged.cwd ?? initialCwd;
	let session = merged.session;
	let defaultRoomId = merged.defaultRoomId ?? DEFAULT_ROOM_ID;
	let publicDir = merged.publicDir;

	let tokenSource: HubTokenSource | undefined = token !== undefined ? "config" : undefined;

	if (overrides.token !== undefined) {
		token = overrides.token;
		tokenSource = "cli";
	}
	if (overrides.port !== undefined) port = overrides.port;
	if (overrides.host !== undefined) host = overrides.host;
	if (overrides.cwd !== undefined) cwd = overrides.cwd;
	if (overrides.session !== undefined) session = overrides.session;
	if (overrides.defaultRoomId !== undefined) defaultRoomId = overrides.defaultRoomId;
	if (overrides.publicDir !== undefined) publicDir = overrides.publicDir;

	const envToken = envString("PI_HUB_TOKEN");
	if (envToken !== undefined) {
		token = envToken;
		tokenSource = "env";
	}
	port = envNumber("PI_HUB_PORT") ?? port;
	host = envString("PI_HUB_HOST") ?? host;
	cwd = envString("PI_HUB_CWD") ?? cwd;
	session = envString("PI_HUB_SESSION") ?? session;
	defaultRoomId = envString("PI_HUB_DEFAULT_ROOM") ?? defaultRoomId;

	return {
		token: normalizeHubToken(token),
		tokenSource,
		port,
		host,
		cwd: resolve(cwd),
		session,
		defaultRoomId,
		publicDir: publicDir ? resolve(publicDir) : undefined,
		models: resolveModelsConfig(merged.models),
		roles: resolveRolesConfig(merged.roles),
		configPaths,
	};
}

export interface WriteConfigOptions {
	global: boolean;
	cwd: string;
	overwrite: boolean;
}

export function writeExampleConfig(options: WriteConfigOptions): string {
	const path = options.global ? globalConfigPath() : projectConfigPath(options.cwd);
	if (existsSync(path) && !options.overwrite) {
		throw new Error(`Config already exists: ${path} (use --force to overwrite)`);
	}

	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const token = generateToken();
	const example: HubConfigFile = {
		token,
		port: DEFAULT_PORT,
		host: DEFAULT_HOST,
		cwd: options.global ? undefined : options.cwd,
		defaultRoomId: DEFAULT_ROOM_ID,
	};

	writeFileSync(path, `${JSON.stringify(example, null, 2)}\n`, "utf8");
	return path;
}

export function generateToken(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}

export function formatConfigHelp(): string {
	return `Configuration (later sources override earlier):

  Files (merged in order):
    1. ${globalConfigPath()}
    2. <cwd>/.pi/hub.json
    3. --config <path>  or  PI_HUB_CONFIG

  Environment:
    PI_HUB_TOKEN, PI_HUB_PORT, PI_HUB_HOST, PI_HUB_CWD,
    PI_HUB_SESSION, PI_HUB_DEFAULT_ROOM, PI_HUB_CONFIG

  CLI flags override files and env for the same field.

  Create a starter file:
    pi-hub init              -> .pi/hub.json in current directory
    pi-hub init --global     -> ~/.pi/hub.json
`;
}
