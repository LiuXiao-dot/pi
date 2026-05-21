import type { createServer, IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import type { HubClientMessage } from "./protocol.ts";
import type { Room } from "./room.ts";
import type { RoomManager } from "./room-manager.ts";

export interface WsHubOptions {
	token: string;
	roomManager: RoomManager;
	defaultRoomId: string;
}

export class WsHub {
	private readonly wss: WebSocketServer;
	private readonly server: ReturnType<typeof createServer>;
	private readonly options: WsHubOptions;

	constructor(server: ReturnType<typeof createServer>, options: WsHubOptions) {
		this.server = server;
		this.options = options;
		this.wss = new WebSocketServer({ noServer: true });

		this.server.on("upgrade", (request, socket, head) => {
			if (!this.isWebSocketPath(request)) {
				socket.destroy();
				return;
			}
			this.wss.handleUpgrade(request, socket, head, (ws) => {
				this.wss.emit("connection", ws, request);
			});
		});

		this.wss.on("connection", (ws) => {
			ws.on("message", (data) => {
				void this.onMessage(ws, data).catch((err) => {
					const message = err instanceof Error ? err.message : String(err);
					this.send(ws, { type: "error", code: "internal", message });
				});
			});
		});
	}

	getAddress(): AddressInfo | string | null {
		return this.server.address();
	}

	private isWebSocketPath(request: IncomingMessage): boolean {
		const url = new URL(request.url ?? "/", "http://localhost");
		return url.pathname === "/ws" || url.pathname === "/ws/";
	}

	private async onMessage(ws: WebSocket, data: unknown): Promise<void> {
		let parsed: HubClientMessage;
		try {
			const text = typeof data === "string" ? data : data instanceof Buffer ? data.toString("utf8") : "";
			parsed = JSON.parse(text) as HubClientMessage;
		} catch {
			this.send(ws, { type: "error", code: "invalid_json", message: "Invalid JSON message" });
			return;
		}

		if (parsed.type === "join") {
			await this.handleJoin(ws, parsed);
			return;
		}

		const room = (ws as WebSocket & { __piRoom?: Room }).__piRoom;
		const client = (ws as WebSocket & { __piClient?: { id: string; displayName: string } }).__piClient;
		if (!room || !client) {
			this.send(ws, { type: "error", code: "not_joined", message: "Send join before other commands" });
			return;
		}

		const bound = room.getClient(client.id);
		if (!bound) {
			this.send(ws, { type: "error", code: "not_joined", message: "Client not registered" });
			return;
		}

		await room.handleMessage(bound, parsed);
	}

	private async handleJoin(ws: WebSocket, message: Extract<HubClientMessage, { type: "join" }>): Promise<void> {
		if ((ws as WebSocket & { __piRoom?: Room }).__piRoom) {
			this.send(ws, { type: "error", code: "already_joined", message: "Already joined" });
			return;
		}

		const clientToken = message.token.trim();
		const serverToken = this.options.token.trim();
		if (clientToken !== serverToken) {
			this.send(ws, {
				type: "error",
				code: "unauthorized",
				message:
					"Invalid token. Use the token the running pi-hub process expects (from .pi/hub.json, or PI_HUB_TOKEN if set in that shell).",
			});
			ws.close(4401, "unauthorized");
			return;
		}

		try {
			const roomId = message.roomId.trim() || this.options.defaultRoomId;
			console.log(`[pi-hub] Join room=${roomId} as ${message.displayName}`);
			const room = await this.options.roomManager.getOrCreateRoom(roomId);
			const client = room.addClient(ws, message.displayName);

			(ws as WebSocket & { __piRoom?: Room }).__piRoom = room;
			(ws as WebSocket & { __piClient?: { id: string; displayName: string } }).__piClient = {
				id: client.id,
				displayName: client.displayName,
			};

			room.sendJoined(client);

			ws.on("close", () => {
				room.removeClient(client.id);
			});
		} catch (err) {
			const messageText = err instanceof Error ? err.message : String(err);
			console.error(`[pi-hub] Join failed:`, err);
			this.send(ws, {
				type: "error",
				code: "join_failed",
				message: `Failed to start session: ${messageText}`,
			});
			ws.close(1011, "join failed");
		}
	}

	private send(ws: WebSocket, message: object): void {
		if (ws.readyState === ws.OPEN) {
			ws.send(JSON.stringify(message));
		}
	}
}
