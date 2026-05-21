import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { HubQueueItemSnapshot, HubQueueUpdate } from "./protocol.ts";

export type QueueCommand = "prompt" | "steer" | "follow_up";

export interface QueueItem {
	id: string;
	command: QueueCommand;
	clientId: string;
	displayName: string;
	message: string;
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
	queuedAt: string;
}

export type QueueUpdateListener = (update: HubQueueUpdate) => void;

export class PromptQueue {
	private items: QueueItem[] = [];
	private current: QueueItem | null = null;
	private draining = false;
	private idleWaiters: Array<() => void> = [];
	private turnOriginClientId: string | null = null;
	private readonly session: AgentSession;
	private readonly onUpdate: QueueUpdateListener;

	constructor(session: AgentSession, onUpdate: QueueUpdateListener) {
		this.session = session;
		this.onUpdate = onUpdate;
	}

	getTurnOriginClientId(): string | null {
		return this.turnOriginClientId;
	}

	enqueue(item: Omit<QueueItem, "id" | "queuedAt"> & { id?: string }): {
		accepted: boolean;
		position: number;
		error?: string;
	} {
		const entry: QueueItem = {
			id: item.id ?? crypto.randomUUID(),
			queuedAt: new Date().toISOString(),
			command: item.command,
			clientId: item.clientId,
			displayName: item.displayName,
			message: item.message,
			images: item.images,
			streamingBehavior: item.streamingBehavior,
		};

		if (entry.command === "prompt" && this.session.isStreaming && !entry.streamingBehavior) {
			this.items.push(entry);
			this.emitUpdate();
			void this.drain();
			return { accepted: true, position: this.items.length };
		}

		this.items.push(entry);
		this.emitUpdate();
		void this.drain();
		return { accepted: true, position: this.items.length };
	}

	notifyAgentIdle(): void {
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const resolve of waiters) {
			resolve();
		}
		void this.drain();
	}

	private emitUpdate(): void {
		this.onUpdate({
			type: "queue_update",
			pending: this.items.map(toSnapshot),
			current: this.current ? toSnapshot(this.current) : null,
		});
	}

	private async waitUntilIdle(): Promise<void> {
		if (!this.session.isStreaming) {
			return;
		}
		await new Promise<void>((resolve) => {
			this.idleWaiters.push(resolve);
		});
	}

	private async drain(): Promise<void> {
		if (this.draining) {
			return;
		}
		this.draining = true;
		try {
			while (this.items.length > 0) {
				await this.waitUntilIdle();
				const item = this.items.shift()!;
				this.current = item;
				this.turnOriginClientId = item.clientId;
				this.emitUpdate();

				try {
					if (item.command === "prompt") {
						await this.runPrompt(item);
					} else if (item.command === "steer") {
						await this.session.steer(item.message, item.images);
					} else {
						await this.session.followUp(item.message, item.images);
					}
					await this.waitUntilIdle();
				} catch (err) {
					// Continue queue after failure
					const message = err instanceof Error ? err.message : String(err);
					console.error(`[pi-hub] queue item failed: ${message}`);
				} finally {
					this.current = null;
					this.turnOriginClientId = null;
					this.emitUpdate();
				}
			}
		} finally {
			this.draining = false;
		}
	}

	private async runPrompt(item: QueueItem): Promise<void> {
		await this.session.prompt(item.message, {
			images: item.images,
			streamingBehavior: item.streamingBehavior,
			source: "rpc",
		});
	}
}

function toSnapshot(item: QueueItem): HubQueueItemSnapshot {
	return {
		id: item.id,
		clientId: item.clientId,
		displayName: item.displayName,
		command: item.command,
		queuedAt: item.queuedAt,
	};
}
