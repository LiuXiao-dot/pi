declare module "@earendil-works/pi-hub" {
	import type { Server } from "node:http";

	export interface HubModelsConfigFile {
		catalog?: string[];
		session?: string;
		roleModels?: Record<string, string>;
	}

	export interface HubRolesConfigFile {
		enabled?: boolean;
		rolesDir?: string;
		pmRole?: string;
		maxParallel?: number;
		confirmProjectRoles?: boolean;
	}

	export interface HubServerOptions {
		port: number;
		host: string;
		token: string;
		cwd: string;
		agentDir?: string;
		sessionPath?: string;
		publicDir?: string;
		defaultRoomId?: string;
		modelsConfig?: HubModelsConfigFile;
		rolesConfig?: HubRolesConfigFile;
	}

	export interface HubServerHandle {
		port: number;
		host: string;
		url: string;
		wsUrl: string;
		close: () => Promise<void>;
	}

	export function startHubServer(options: HubServerOptions): Promise<HubServerHandle>;
	export function createHttpServer(options: { publicDir: string }): Server;
	export function defaultPublicDir(): string;
}
