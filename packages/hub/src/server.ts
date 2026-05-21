import type { AddressInfo } from "node:net";
import { createHttpServer, defaultPublicDir } from "./http-server.ts";
import { RoomManager, type RoomManagerOptions } from "./room-manager.ts";
import { WsHub } from "./ws-hub.ts";

export interface HubServerOptions extends RoomManagerOptions {
	createSession?: RoomManagerOptions["createSession"];
	port: number;
	host: string;
	token: string;
	publicDir?: string;
	defaultRoomId?: string;
}

export interface HubServerHandle {
	port: number;
	host: string;
	url: string;
	wsUrl: string;
	roomManager: RoomManager;
	close: () => Promise<void>;
}

export async function startHubServer(options: HubServerOptions): Promise<HubServerHandle> {
	const publicDir = options.publicDir ?? defaultPublicDir();
	const defaultRoomId = options.defaultRoomId ?? "default";
	const roomManager = new RoomManager({
		cwd: options.cwd,
		agentDir: options.agentDir,
		sessionPath: options.sessionPath,
		defaultRoomId,
		modelsConfig: options.modelsConfig,
		rolesConfig: options.rolesConfig,
		createSession: options.createSession,
	});
	roomManager.initialize(defaultRoomId);

	const server = createHttpServer({ publicDir });

	void new WsHub(server, {
		token: options.token,
		roomManager,
		defaultRoomId,
		rolesConfig: options.rolesConfig,
		cwd: options.cwd,
	});

	await new Promise<void>((resolve, reject) => {
		server.listen(options.port, options.host, () => resolve());
		server.on("error", reject);
	});

	const addr = server.address() as AddressInfo;
	const port = addr?.port ?? options.port;
	const host = options.host === "0.0.0.0" ? "127.0.0.1" : options.host;

	return {
		port,
		host,
		url: `http://${host}:${port}`,
		wsUrl: `ws://${host}:${port}/ws`,
		roomManager,
		close: async () => {
			await roomManager.shutdown();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
