import type {
	HubClientMessage,
	HubCommandResultMessage,
	HubModelInfo,
	HubModelsConfigPayload,
	HubServerMessage,
} from "./protocol.ts";

export type MessageHandler = (msg: HubServerMessage) => void;

/**
 * Generate a UUID v4. Falls back to `crypto.getRandomValues` when
 * `crypto.randomUUID` is unavailable (non-secure contexts, e.g. plain HTTP
 * on a LAN IP).
 */
function uuidV4(): string {
	const c = globalThis.crypto as Crypto | undefined;
	if (c && typeof c.randomUUID === "function") return c.randomUUID();
	const bytes = new Uint8Array(16);
	if (c && typeof c.getRandomValues === "function") {
		c.getRandomValues(bytes);
	} else {
		for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex: string[] = [];
	for (let i = 0; i < 16; i++) hex.push(bytes[i]!.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

type CommandResolver = {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
};

export class HubClient {
	private ws: WebSocket | null = null;
	private handlers: MessageHandler[] = [];
	private joined = false;
	private readonly pendingCommands = new Map<string, CommandResolver>();
	private readonly hubUrl: string;
	private readonly roomId: string;
	private readonly token: string;
	private readonly displayName: string;

	constructor(hubUrl: string, roomId: string, token: string, displayName: string) {
		this.hubUrl = hubUrl;
		this.roomId = roomId;
		this.token = token;
		this.displayName = displayName;
	}

	onMessage(handler: MessageHandler): () => void {
		this.handlers.push(handler);
		return () => {
			this.handlers = this.handlers.filter((h) => h !== handler);
		};
	}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const fail = (error: Error) => {
				if (settled) {
					return;
				}
				settled = true;
				reject(error);
			};

			const timeoutId = setTimeout(() => {
				fail(new Error("Connection timed out waiting for hub. Is pi-hub running? Check WebSocket URL and token."));
				this.ws?.close();
			}, 120_000);

			this.ws = new WebSocket(this.hubUrl);

			this.ws.onopen = () => {
				this.send({
					type: "join",
					roomId: this.roomId,
					token: this.token,
					displayName: this.displayName,
				});
			};

			this.ws.onmessage = (ev) => {
				try {
					const msg = JSON.parse(String(ev.data)) as HubServerMessage;
					this.handleCommandResult(msg);
					if (msg.type === "joined") {
						this.joined = true;
						if (!settled) {
							settled = true;
							clearTimeout(timeoutId);
							resolve();
						}
					}
					for (const h of this.handlers) {
						h(msg);
					}
				} catch {
					// ignore
				}
			};

			this.ws.onerror = () => {
				fail(new Error(`WebSocket error connecting to ${this.hubUrl}`));
			};

			this.ws.onclose = (ev) => {
				clearTimeout(timeoutId);
				if (!settled) {
					const hint =
						ev.code === 4401
							? "Invalid token. Copy the token from .pi/hub.json on the machine running pi-hub."
							: `WebSocket closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ""}). Is pi-hub running at ${this.hubUrl}?`;
					fail(new Error(hint));
					return;
				}
				if (this.joined) {
					for (const h of this.handlers) {
						h({
							type: "error",
							code: "disconnected",
							message:
								ev.code === 4401
									? "Disconnected: invalid token"
									: `Disconnected from hub (${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`,
						});
					}
				}
			};
		});
	}

	private handleCommandResult(msg: HubServerMessage): void {
		if (msg.type !== "command_result") {
			return;
		}
		const result = msg as HubCommandResultMessage;
		if (!result.id) {
			return;
		}
		const pending = this.pendingCommands.get(result.id);
		if (!pending) {
			return;
		}
		this.pendingCommands.delete(result.id);
		if (result.success) {
			pending.resolve(result.data);
		} else {
			pending.reject(new Error(result.error ?? `${result.command} failed`));
		}
	}

	private sendCommand<T>(message: HubClientMessage, timeoutMs = 30_000): Promise<T> {
		const id = uuidV4();
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingCommands.delete(id);
				reject(new Error(`Command timed out: ${message.type}`));
			}, timeoutMs);

			this.pendingCommands.set(id, {
				resolve: (data) => {
					clearTimeout(timer);
					resolve(data as T);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});

			this.send({ ...message, id });
		});
	}

	send(msg: HubClientMessage): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	async getAvailableModels(): Promise<HubModelInfo[]> {
		const data = await this.sendCommand<{ models: HubModelInfo[] }>({ type: "get_available_models" });
		return data.models ?? [];
	}

	async getModelsConfig(): Promise<HubModelsConfigPayload> {
		return this.sendCommand<HubModelsConfigPayload>({ type: "get_models_config" });
	}

	async setRoleModel(
		roleName: string,
		provider: string | null,
		modelId: string | null,
	): Promise<HubModelsConfigPayload> {
		if (provider === null || modelId === null) {
			return this.sendCommand<HubModelsConfigPayload>({ type: "set_role_model", roleName });
		}
		return this.sendCommand<HubModelsConfigPayload>({
			type: "set_role_model",
			roleName,
			provider,
			modelId,
		});
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		await this.sendCommand({ type: "set_model", provider, modelId });
	}

	async setProviderBaseUrl(provider: string, baseUrl: string): Promise<HubModelInfo[]> {
		const data = await this.sendCommand<{ models: HubModelInfo[] }>({
			type: "set_provider_base_url",
			provider,
			baseUrl,
		});
		return data.models ?? [];
	}

	prompt(message: string): void {
		this.send({ type: "prompt", message });
	}

	extensionUiResponse(response: HubClientMessage): void {
		this.send(response);
	}

	disconnect(): void {
		this.ws?.close();
		this.ws = null;
	}
}

export function defaultWsUrl(): string {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	return `${proto}//${location.host}/ws`;
}
