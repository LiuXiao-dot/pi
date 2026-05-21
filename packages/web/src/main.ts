import { defaultWsUrl, HubClient } from "./hub-client.ts";
import type { HubModelInfo, HubServerMessage, HubSessionState } from "./protocol.ts";

interface StoredConnect {
	hubUrl: string;
	roomId: string;
	token: string;
	displayName: string;
}

const STORAGE_KEY = "pi-hub-connect";
const PROVIDER_URLS_KEY = "pi-hub-provider-urls";

function modelOptionValue(provider: string, id: string): string {
	return `${provider}/${id}`;
}

function parseModelOptionValue(value: string): { provider: string; modelId: string } | null {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash >= value.length - 1) {
		return null;
	}
	return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

function loadProviderUrlPrefs(): Record<string, string> {
	try {
		return JSON.parse(localStorage.getItem(PROVIDER_URLS_KEY) ?? "{}") as Record<string, string>;
	} catch {
		return {};
	}
}

function saveProviderUrlPref(provider: string, baseUrl: string): void {
	const prefs = loadProviderUrlPrefs();
	prefs[provider] = baseUrl;
	localStorage.setItem(PROVIDER_URLS_KEY, JSON.stringify(prefs));
}

function formatModelLabel(model: HubModelInfo): string {
	const auth = model.hasAuth ? "" : " · no auth";
	return `${model.provider}/${model.id} — ${model.name}${auth}`;
}

function loadStored(): Partial<StoredConnect> {
	try {
		return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<StoredConnect>;
	} catch {
		return {};
	}
}

function saveStored(data: StoredConnect): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	return node;
}

function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const m = message as { role?: string; content?: string | Array<{ type: string; text?: string }> };
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		return m.content
			.filter((p) => p.type === "text")
			.map((p) => p.text ?? "")
			.join("\n");
	}
	return "";
}

function renderConnect(root: HTMLElement, onConnect: (cfg: StoredConnect) => void): void {
	const stored = loadStored();
	root.innerHTML = "";
	const panel = el("div", "connect-panel");
	panel.appendChild(Object.assign(el("h1"), { textContent: "pi Hub" }));
	panel.appendChild(
		Object.assign(el("p", "hint"), {
			textContent:
				"Open this page from the same host as pi-hub (e.g. http://localhost:3141). Copy the token from .pi/hub.json on the server.",
		}),
	);

	const fields: Array<{ key: keyof StoredConnect; label: string; type?: string }> = [
		{ key: "hubUrl", label: "WebSocket URL" },
		{ key: "roomId", label: "Room ID" },
		{ key: "token", label: "Token", type: "password" },
		{ key: "displayName", label: "Your name" },
	];

	const inputs: Record<string, HTMLInputElement> = {};
	for (const f of fields) {
		const label = el("label");
		label.textContent = f.label;
		const input = el("input") as HTMLInputElement;
		if (f.type) input.type = f.type;
		input.value =
			(stored[f.key] as string) ?? (f.key === "hubUrl" ? defaultWsUrl() : f.key === "roomId" ? "default" : "");
		inputs[f.key] = input;
		label.appendChild(input);
		panel.appendChild(label);
	}

	const err = el("div", "error-banner hidden");
	panel.appendChild(err);

	const btn = el("button");
	btn.textContent = "Connect";
	btn.onclick = () => {
		const cfg: StoredConnect = {
			hubUrl: inputs.hubUrl!.value.trim() || defaultWsUrl(),
			roomId: inputs.roomId!.value.trim() || "default",
			token: inputs.token!.value.trim(),
			displayName: inputs.displayName!.value.trim() || "anonymous",
		};
		if (!cfg.token) {
			err.textContent = "Token is required";
			err.classList.remove("hidden");
			return;
		}
		saveStored(cfg);
		onConnect(cfg);
	};
	panel.appendChild(btn);
	root.appendChild(panel);
}

function renderChat(root: HTMLElement, cfg: StoredConnect): void {
	root.innerHTML = "";
	const panel = el("div", "chat-panel");

	const header = el("div", "header");
	const title = el("span");
	title.textContent = `Room: ${cfg.roomId}`;
	const status = el("span", "status");
	status.textContent = "Connecting…";
	header.append(title, status);
	panel.appendChild(header);

	const modelBar = el("div", "model-bar");
	const modelRow = el("div", "model-row");
	const modelLabel = el("label", "model-label");
	modelLabel.textContent = "Model";
	const modelSelect = el("select") as HTMLSelectElement;
	modelLabel.appendChild(modelSelect);
	modelRow.appendChild(modelLabel);
	modelBar.appendChild(modelRow);

	const endpointDetails = el("details", "endpoint-details");
	const endpointSummary = el("summary");
	endpointSummary.textContent = "API endpoint (proxy base URL)";
	endpointDetails.appendChild(endpointSummary);

	const endpointForm = el("div", "endpoint-form");
	const providerLabel = el("label");
	providerLabel.textContent = "Provider";
	const providerInput = el("input") as HTMLInputElement;
	providerInput.readOnly = true;
	providerLabel.appendChild(providerInput);

	const baseUrlLabel = el("label");
	baseUrlLabel.textContent = "Base URL";
	const baseUrlInput = el("input") as HTMLInputElement;
	baseUrlInput.placeholder = "https://your-proxy.example/v1";
	baseUrlLabel.appendChild(baseUrlInput);

	const applyUrlBtn = el("button", "secondary-btn");
	applyUrlBtn.type = "button";
	applyUrlBtn.textContent = "Apply URL";
	endpointForm.append(providerLabel, baseUrlLabel, applyUrlBtn);
	endpointDetails.appendChild(endpointForm);
	modelBar.appendChild(endpointDetails);
	panel.appendChild(modelBar);

	const err = el("div", "error-banner hidden");
	panel.appendChild(err);

	const messages = el("div", "messages");
	panel.appendChild(messages);

	const queueBar = el("div", "queue-bar");
	queueBar.textContent = "Queue empty";
	panel.appendChild(queueBar);

	const composer = el("div", "composer");
	const input = el("textarea") as HTMLTextAreaElement;
	input.placeholder = "Message…";
	const sendBtn = el("button");
	sendBtn.textContent = "Send";
	composer.append(input, sendBtn);
	panel.appendChild(composer);

	root.appendChild(panel);

	const client = new HubClient(cfg.hubUrl, cfg.roomId, cfg.token, cfg.displayName);
	const messageEls = new Map<string, HTMLElement>();
	let clientId = "";
	let presenceCount = 0;
	let statusModelSuffix = "no model";
	let availableModels: HubModelInfo[] = [];
	let switchingModel = false;

	function updateHeaderStatus(): void {
		const online = presenceCount > 0 ? `${presenceCount} online · ` : "";
		status.textContent = `${online}${statusModelSuffix}`;
	}

	function applyStateModel(state: HubSessionState | undefined): void {
		const model = state?.model;
		if (model?.provider && model.id) {
			statusModelSuffix = `${model.provider}/${model.id}`;
			const value = modelOptionValue(model.provider, model.id);
			if ([...modelSelect.options].some((o) => o.value === value)) {
				modelSelect.value = value;
			}
			providerInput.value = model.provider;
			if (typeof model.baseUrl === "string") {
				baseUrlInput.value = model.baseUrl;
			}
		} else {
			statusModelSuffix = "no model";
		}
		updateHeaderStatus();
	}

	function fillModelSelect(models: HubModelInfo[], selected?: { provider: string; id: string }): void {
		modelSelect.innerHTML = "";
		for (const m of models) {
			const option = el("option") as HTMLOptionElement;
			option.value = modelOptionValue(m.provider, m.id);
			option.textContent = formatModelLabel(m);
			modelSelect.appendChild(option);
		}
		if (selected) {
			const value = modelOptionValue(selected.provider, selected.id);
			if ([...modelSelect.options].some((o) => o.value === value)) {
				modelSelect.value = value;
			}
		}
	}

	async function refreshModelList(selected?: { provider: string; id: string }): Promise<void> {
		availableModels = await client.getAvailableModels();
		fillModelSelect(availableModels, selected);
		const current = availableModels.find((m) => selected && m.provider === selected.provider && m.id === selected.id);
		if (current) {
			providerInput.value = current.provider;
			baseUrlInput.value = current.baseUrl;
		}
	}

	function syncEndpointFieldsFromSelection(): void {
		const parsed = parseModelOptionValue(modelSelect.value);
		if (!parsed) {
			return;
		}
		const model = availableModels.find((m) => m.provider === parsed.provider && m.id === parsed.modelId);
		if (model) {
			providerInput.value = model.provider;
			baseUrlInput.value = model.baseUrl;
		}
	}

	function showError(message: string): void {
		err.textContent = message;
		err.classList.remove("hidden");
	}

	function appendMessage(role: string, text: string, meta?: string): HTMLElement {
		const div = el("div", `msg ${role}`);
		if (meta) {
			const m = el("div", "meta");
			m.textContent = meta;
			div.appendChild(m);
		}
		const body = el("div");
		body.textContent = text;
		div.appendChild(body);
		messages.appendChild(div);
		messages.scrollTop = messages.scrollHeight;
		return div;
	}

	function renderHistory(msgs: unknown[]): void {
		messages.innerHTML = "";
		messageEls.clear();
		for (const msg of msgs) {
			const m = msg as { role?: string };
			if (m.role === "user" || m.role === "assistant") {
				appendMessage(m.role, getMessageText(msg));
			}
		}
	}

	function updateQueue(msg: HubServerMessage): void {
		if (msg.type !== "queue_update") return;
		const pending = (msg.pending as unknown[]) ?? [];
		const current = msg.current as { displayName?: string } | null;
		if (current) {
			queueBar.textContent = `Running: ${current.displayName ?? "?"} · ${pending.length} queued`;
		} else if (pending.length > 0) {
			queueBar.textContent = `${pending.length} message(s) queued`;
		} else {
			queueBar.textContent = "Queue empty";
		}
	}

	function handleAgentEvent(msg: HubServerMessage): void {
		if (msg.type !== "agent_event") return;
		const event = msg.event as {
			type: string;
			message?: unknown;
			assistantMessageEvent?: { type: string; delta?: string };
		};
		if (event.type === "message_start" && event.message) {
			const m = event.message as { role?: string; id?: string };
			if (m.role === "assistant" && m.id) {
				messageEls.set(m.id, appendMessage("assistant", ""));
			}
		}
		if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
			const delta = event.assistantMessageEvent.delta ?? "";
			const last = messageEls.values().next().value;
			if (last) {
				const body = last.querySelector("div:last-child");
				if (body) body.textContent = (body.textContent ?? "") + delta;
				messages.scrollTop = messages.scrollHeight;
			}
		}
		if (event.type === "message_end" && event.message) {
			const m = event.message as { role?: string };
			if (m.role === "user") {
				appendMessage("user", getMessageText(m));
			}
		}
		if (event.type === "tool_execution_start") {
			const t = event as { toolName?: string };
			appendMessage("tool", `Tool: ${t.toolName ?? "unknown"}`);
		}
	}

	function showExtensionModal(msg: HubServerMessage): void {
		if (msg.type !== "extension_ui_request") return;
		const target = msg.targetClientId as string | null;
		const waiting = msg.waitingForDisplayName as string | undefined;
		if (target && target !== clientId) {
			queueBar.textContent = `Waiting for ${waiting ?? "operator"} to respond…`;
			return;
		}

		const backdrop = el("div", "modal-backdrop");
		const modal = el("div", "modal");
		const method = msg.method as string;
		const id = msg.id as string;

		const title = el("h3");
		title.textContent = (msg.title as string) ?? method;
		modal.appendChild(title);

		const finish = (response: Record<string, unknown>) => {
			backdrop.remove();
			client.extensionUiResponse({ type: "extension_ui_response", id, ...response });
		};

		if (method === "select" || method === "confirm") {
			const options = method === "confirm" ? ["Yes", "No"] : ((msg.options as string[]) ?? []);
			if (method === "confirm" && msg.message) {
				const p = el("p");
				p.textContent = String(msg.message);
				modal.appendChild(p);
			}
			const list = el("div", "options");
			for (const opt of options) {
				const b = el("button", "option");
				b.textContent = opt;
				b.onclick = () => {
					if (method === "confirm") {
						finish({ confirmed: opt === "Yes" });
					} else {
						finish({ value: opt });
					}
				};
				list.appendChild(b);
			}
			modal.appendChild(list);
		} else if (method === "input" || method === "editor") {
			const field = method === "editor" ? el("textarea") : el("input");
			if (method === "editor") {
				(field as HTMLTextAreaElement).value = (msg.prefill as string) ?? "";
				(field as HTMLTextAreaElement).rows = 6;
			} else {
				(field as HTMLInputElement).placeholder = (msg.placeholder as string) ?? "";
			}
			modal.appendChild(field);
			const actions = el("div", "actions");
			const ok = el("button");
			ok.textContent = "OK";
			ok.onclick = () => finish({ value: (field as HTMLInputElement).value });
			const cancel = el("button");
			cancel.textContent = "Cancel";
			cancel.onclick = () => finish({ cancelled: true });
			actions.append(ok, cancel);
			modal.appendChild(actions);
		} else {
			backdrop.remove();
			return;
		}

		backdrop.appendChild(modal);
		document.body.appendChild(backdrop);
	}

	modelSelect.addEventListener("change", () => {
		void (async () => {
			if (switchingModel) {
				return;
			}
			const parsed = parseModelOptionValue(modelSelect.value);
			if (!parsed) {
				return;
			}
			switchingModel = true;
			try {
				await client.setModel(parsed.provider, parsed.modelId);
				syncEndpointFieldsFromSelection();
				const model = availableModels.find((m) => m.provider === parsed.provider && m.id === parsed.modelId);
				if (model) {
					statusModelSuffix = `${model.provider}/${model.id}`;
					updateHeaderStatus();
				}
			} catch (e) {
				showError(e instanceof Error ? e.message : String(e));
			} finally {
				switchingModel = false;
			}
		})();
	});

	applyUrlBtn.onclick = () => {
		void (async () => {
			const provider = providerInput.value.trim();
			const baseUrl = baseUrlInput.value.trim();
			if (!provider || !baseUrl) {
				showError("Provider and base URL are required");
				return;
			}
			try {
				availableModels = await client.setProviderBaseUrl(provider, baseUrl);
				saveProviderUrlPref(provider, baseUrl);
				const parsed = parseModelOptionValue(modelSelect.value);
				fillModelSelect(availableModels, parsed ? { provider: parsed.provider, id: parsed.modelId } : undefined);
				syncEndpointFieldsFromSelection();
			} catch (e) {
				showError(e instanceof Error ? e.message : String(e));
			}
		})();
	};

	client.onMessage((msg) => {
		if (msg.type === "joined") {
			clientId = (msg.clientId as string) ?? "";
			applyStateModel(msg.state as HubSessionState | undefined);
			renderHistory((msg.messages as unknown[]) ?? []);
			void refreshModelList(
				(msg.state as HubSessionState | undefined)?.model?.provider && (msg.state as HubSessionState).model?.id
					? {
							provider: (msg.state as HubSessionState).model!.provider!,
							id: (msg.state as HubSessionState).model!.id!,
						}
					: undefined,
			).catch((e) => showError(e instanceof Error ? e.message : String(e)));
		}
		if (msg.type === "state_update") {
			applyStateModel(msg.state as HubSessionState | undefined);
		}
		if (msg.type === "presence") {
			presenceCount = ((msg.members as unknown[]) ?? []).length;
			updateHeaderStatus();
		}
		if (msg.type === "error") {
			const text = (msg.message as string) ?? "Error";
			showError(text);
			if (msg.code === "disconnected" || msg.code === "join_failed" || msg.code === "unauthorized") {
				status.textContent = "Disconnected";
			}
		}
		updateQueue(msg);
		handleAgentEvent(msg);
		if (msg.type === "extension_ui_request") {
			showExtensionModal(msg);
		}
	});

	sendBtn.onclick = () => {
		const text = input.value.trim();
		if (!text) return;
		input.value = "";
		appendMessage("user", text, cfg.displayName);
		client.prompt(text);
	};

	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			sendBtn.click();
		}
	});

	client
		.connect()
		.then(() => {
			statusModelSuffix = "loading models…";
			updateHeaderStatus();
		})
		.catch((e) => {
			showError(e instanceof Error ? e.message : String(e));
			status.textContent = "Failed";
			setTimeout(() => renderConnect(root, (c) => renderChat(root, c)), 2000);
		});
}

const app = document.getElementById("app")!;
renderConnect(app, (cfg) => renderChat(app, cfg));
