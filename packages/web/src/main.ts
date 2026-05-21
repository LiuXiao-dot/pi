import { defaultWsUrl, HubClient } from "./hub-client.ts";
import type {
	HubActivityUpdateMessage,
	HubModelInfo,
	HubModelsConfigPayload,
	HubServerMessage,
	HubSessionState,
} from "./protocol.ts";

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

function transitionView(root: HTMLElement, render: () => void): void {
	root.classList.add("view-exit");
	window.setTimeout(() => {
		render();
		root.classList.remove("view-exit");
		root.classList.add("view-enter");
		window.requestAnimationFrame(() => {
			root.classList.remove("view-enter");
		});
	}, 200);
}

function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const m = message as {
		role?: string;
		customType?: string;
		content?: string | Array<{ type: string; text?: string }>;
	};
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		return m.content
			.filter((p) => p.type === "text")
			.map((p) => p.text ?? "")
			.join("\n");
	}
	return "";
}

function messageRoleClass(msg: { role?: string; customType?: string }): string {
	if (msg.role === "custom") {
		const t = msg.customType ?? "";
		if (t === "hub_role_plan") return "role-plan";
		if (t === "hub_role_output") return "role-output";
		return "role";
	}
	return msg.role ?? "unknown";
}

function renderConnect(root: HTMLElement, onConnect: (cfg: StoredConnect) => void): void {
	const stored = loadStored();
	root.innerHTML = "";
	const shell = el("div", "connect-shell");

	const hero = el("div", "connect-hero");
	hero.appendChild(Object.assign(el("p", "eyebrow"), { textContent: "LAN workspace" }));
	hero.appendChild(Object.assign(el("h1"), { textContent: "pi Hub" }));
	shell.appendChild(hero);

	const panel = el("div", "connect-panel");
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
		const span = el("span");
		span.textContent = f.label;
		label.appendChild(span);
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

	const roomSection = el("div", "connect-rooms");
	roomSection.appendChild(Object.assign(el("p", "hint"), { textContent: "Rooms (create before first join):" }));
	const roomSelect = el("select") as HTMLSelectElement;
	const newRoomInput = el("input") as HTMLInputElement;
	newRoomInput.placeholder = "new-room-id";
	const roomActions = el("div", "room-actions");
	const refreshRoomsBtn = el("button", "secondary-btn");
	refreshRoomsBtn.type = "button";
	refreshRoomsBtn.textContent = "Refresh rooms";
	const createRoomBtn = el("button", "secondary-btn");
	createRoomBtn.type = "button";
	createRoomBtn.textContent = "Create room";
	roomActions.append(refreshRoomsBtn, createRoomBtn);
	roomSection.append(roomSelect, newRoomInput, roomActions);
	panel.appendChild(roomSection);

	async function refreshRoomList(): Promise<void> {
		const token = inputs.token!.value.trim();
		const hubUrl = inputs.hubUrl!.value.trim() || defaultWsUrl();
		if (!token) {
			err.textContent = "Token required to list rooms";
			err.classList.remove("hidden");
			return;
		}
		const tmp = new HubClient(hubUrl, "default", token, "setup");
		try {
			await tmp.openSocket();
			const rooms = await tmp.listRooms();
			roomSelect.innerHTML = "";
			for (const r of rooms) {
				const opt = el("option") as HTMLOptionElement;
				opt.value = r.roomId;
				opt.textContent = r.title ? `${r.roomId} — ${r.title}` : r.roomId;
				roomSelect.appendChild(opt);
			}
			if (rooms.length > 0) {
				inputs.roomId!.value = roomSelect.value;
			}
			err.classList.add("hidden");
		} catch (e) {
			err.textContent = e instanceof Error ? e.message : String(e);
			err.classList.remove("hidden");
		} finally {
			tmp.disconnect();
		}
	}

	refreshRoomsBtn.onclick = () => void refreshRoomList();
	createRoomBtn.onclick = () => {
		void (async () => {
			const token = inputs.token!.value.trim();
			const hubUrl = inputs.hubUrl!.value.trim() || defaultWsUrl();
			const newId = newRoomInput.value.trim();
			if (!token || !newId) {
				err.textContent = "Token and new room id required";
				err.classList.remove("hidden");
				return;
			}
			const tmp = new HubClient(hubUrl, newId, token, "setup");
			try {
				await tmp.openSocket();
				await tmp.createRoom(newId);
				await refreshRoomList();
				roomSelect.value = newId;
				inputs.roomId!.value = newId;
			} catch (e) {
				err.textContent = e instanceof Error ? e.message : String(e);
				err.classList.remove("hidden");
			} finally {
				tmp.disconnect();
			}
		})();
	};

	roomSelect.addEventListener("change", () => {
		inputs.roomId!.value = roomSelect.value;
	});

	const btn = el("button", "btn-primary");
	btn.textContent = "Connect";
	btn.onclick = () => {
		const cfg: StoredConnect = {
			hubUrl: inputs.hubUrl!.value.trim() || defaultWsUrl(),
			roomId: roomSelect.value || inputs.roomId!.value.trim() || "default",
			token: inputs.token!.value.trim(),
			displayName: inputs.displayName!.value.trim() || "anonymous",
		};
		if (!cfg.token) {
			err.textContent = "Token is required";
			err.classList.remove("hidden");
			return;
		}
		saveStored(cfg);
		transitionView(root, () => onConnect(cfg));
	};
	panel.appendChild(btn);
	shell.appendChild(panel);
	root.appendChild(shell);
}

function renderChat(root: HTMLElement, cfg: StoredConnect): void {
	root.innerHTML = "";
	const layout = el("div", "chat-layout");
	const sidebarBackdrop = el("div", "sidebar-backdrop");
	const sidebar = el("aside", "sidebar");
	const panel = el("div", "chat-panel");
	layout.append(sidebarBackdrop, sidebar, panel);

	function closeSidebar(): void {
		sidebar.classList.remove("open");
		sidebarBackdrop.classList.remove("visible");
	}

	function openSidebar(): void {
		sidebar.classList.add("open");
		sidebarBackdrop.classList.add("visible");
	}

	const header = el("div", "header");
	const headerBrand = el("div", "header-brand");
	const sidebarToggle = el("button", "sidebar-toggle");
	sidebarToggle.type = "button";
	sidebarToggle.setAttribute("aria-label", "Toggle sidebar");
	sidebarToggle.textContent = "Menu";
	sidebarToggle.onclick = () => {
		if (sidebar.classList.contains("open")) closeSidebar();
		else openSidebar();
	};
	headerBrand.appendChild(sidebarToggle);
	const logo = el("span", "logo");
	logo.textContent = "pi Hub";
	const room = el("span", "room");
	room.textContent = cfg.roomId;
	headerBrand.append(logo, room);

	const statusWrap = el("div", "status-wrap");
	const statusDot = el("span", "status-dot connecting");
	const status = el("span", "status");
	status.textContent = "Connecting…";
	statusWrap.append(statusDot, status);
	header.append(headerBrand, statusWrap);
	panel.appendChild(header);
	sidebarBackdrop.onclick = () => closeSidebar();
	panel.addEventListener("click", () => {
		if (window.matchMedia("(max-width: 640px)").matches && sidebar.classList.contains("open")) {
			closeSidebar();
		}
	});

	function setConnectionLive(live: boolean): void {
		statusDot.classList.toggle("live", live);
		statusDot.classList.toggle("connecting", !live);
	}

	const modelBar = el("div", "model-bar");
	const modelRow = el("div", "model-row");
	const modelLabel = el("label", "model-label");
	modelLabel.textContent = "Session model";
	const modelSelect = el("select") as HTMLSelectElement;
	modelLabel.appendChild(modelSelect);
	modelRow.appendChild(modelLabel);
	modelBar.appendChild(modelRow);

	const roleModelsDetails = el("details", "role-models-details");
	const roleModelsSummary = el("summary");
	roleModelsSummary.textContent = "Role models";
	roleModelsDetails.appendChild(roleModelsSummary);
	const roleModelsForm = el("div", "role-models-form");
	roleModelsDetails.appendChild(roleModelsForm);
	modelBar.appendChild(roleModelsDetails);

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

	const roleGapBar = el("div", "role-gap-bar hidden");
	panel.appendChild(roleGapBar);

	const rolePlanPanel = el("div", "role-plan-panel hidden");
	panel.appendChild(rolePlanPanel);

	const roleProgressBar = el("div", "role-progress-bar hidden");
	panel.appendChild(roleProgressBar);

	const activityBar = el("div", "activity-bar hidden");
	panel.appendChild(activityBar);

	const queueBar = el("div", "queue-bar");
	queueBar.textContent = "Queue empty";
	panel.appendChild(queueBar);

	const composer = el("div", "composer");
	const input = el("textarea") as HTMLTextAreaElement;
	input.placeholder = "Message…";
	const sendBtn = el("button", "btn-send");
	sendBtn.textContent = "Send";
	composer.append(input, sendBtn);
	panel.appendChild(composer);

	root.appendChild(layout);

	// Sidebar: rooms
	const roomsDetails = el("details", "sidebar-section");
	roomsDetails.open = true;
	roomsDetails.appendChild(Object.assign(el("summary"), { textContent: "Rooms" }));
	const roomsList = el("ul", "rooms-list");
	const roomCreateRow = el("div", "sidebar-row");
	const roomNewInput = el("input") as HTMLInputElement;
	roomNewInput.placeholder = "new-room-id";
	const roomCreateBtn = el("button", "secondary-btn");
	roomCreateBtn.type = "button";
	roomCreateBtn.textContent = "Create";
	const roomDeleteBtn = el("button", "secondary-btn danger-btn");
	roomDeleteBtn.type = "button";
	roomDeleteBtn.textContent = "Delete current";
	roomCreateRow.append(roomNewInput, roomCreateBtn);
	roomsDetails.append(roomsList, roomCreateRow, roomDeleteBtn);

	// Sidebar: room config
	const roomCfgDetails = el("details", "sidebar-section");
	roomCfgDetails.appendChild(Object.assign(el("summary"), { textContent: "Room config" }));
	const roomSkillsInput = el("input") as HTMLInputElement;
	roomSkillsInput.placeholder = "skills (comma-separated)";
	const roomRulesInput = el("textarea") as HTMLTextAreaElement;
	roomRulesInput.placeholder = "Room rules (inline)";
	roomRulesInput.rows = 3;
	const roomRolesEnabled = el("input") as HTMLInputElement;
	roomRolesEnabled.type = "checkbox";
	const rolesEnabledLabel = el("label");
	rolesEnabledLabel.append(roomRolesEnabled, document.createTextNode(" Enable roles in this room"));
	const saveRoomCfgBtn = el("button", "secondary-btn");
	saveRoomCfgBtn.type = "button";
	saveRoomCfgBtn.textContent = "Save room config";
	roomCfgDetails.append(roomSkillsInput, roomRulesInput, rolesEnabledLabel, saveRoomCfgBtn);

	// Sidebar: room assigned roles
	const roomRolesDetails = el("details", "sidebar-section");
	roomRolesDetails.open = true;
	roomRolesDetails.appendChild(Object.assign(el("summary"), { textContent: "Room roles" }));
	roomRolesDetails.appendChild(
		Object.assign(el("p", "hint"), {
			textContent: "Add roles from the library (include PM + workers). No duplicates.",
		}),
	);
	const roomAssignedList = el("ul", "room-assigned-list");
	const roomRoleAddRow = el("div", "sidebar-row");
	const roomRoleAddSelect = el("select") as HTMLSelectElement;
	const roomRoleAddBtn = el("button", "secondary-btn");
	roomRoleAddBtn.type = "button";
	roomRoleAddBtn.textContent = "Add role";
	roomRoleAddRow.append(roomRoleAddSelect, roomRoleAddBtn);
	roomRolesDetails.append(roomAssignedList, roomRoleAddRow);

	// Sidebar: global role library
	const rolesDetails = el("details", "sidebar-section");
	rolesDetails.appendChild(Object.assign(el("summary"), { textContent: "Role library" }));
	const roleSelect = el("select") as HTMLSelectElement;
	const roleEditor = el("textarea", "role-editor") as HTMLTextAreaElement;
	roleEditor.rows = 12;
	roleEditor.spellcheck = false;
	const roleMeta = el("div", "role-meta");
	const saveRoleBtn = el("button", "secondary-btn");
	saveRoleBtn.type = "button";
	saveRoleBtn.textContent = "Save role";
	const deleteRoleBtn = el("button", "secondary-btn danger-btn");
	deleteRoleBtn.type = "button";
	deleteRoleBtn.textContent = "Delete role";
	rolesDetails.append(roleSelect, roleMeta, roleEditor, saveRoleBtn, deleteRoleBtn);

	sidebar.append(roomsDetails, roomCfgDetails, roomRolesDetails, rolesDetails);

	const client = new HubClient(cfg.hubUrl, cfg.roomId, cfg.token, cfg.displayName);
	let streamingAssistantEl: HTMLElement | null = null;
	let turnHostName: string | null = null;
	let clientId = "";
	let presenceCount = 0;
	let statusModelSuffix = "loading models…";
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

	function fillModelSelectElement(
		select: HTMLSelectElement,
		models: HubModelInfo[],
		selectedRef?: string,
		includeDefault = false,
	): void {
		select.innerHTML = "";
		if (includeDefault) {
			const empty = el("option") as HTMLOptionElement;
			empty.value = "";
			empty.textContent = "(role file default)";
			select.appendChild(empty);
		}
		for (const m of models) {
			const option = el("option") as HTMLOptionElement;
			option.value = modelOptionValue(m.provider, m.id);
			option.textContent = formatModelLabel(m);
			select.appendChild(option);
		}
		if (selectedRef) {
			const parsed = parseModelOptionValue(selectedRef);
			if (parsed) {
				const value = modelOptionValue(parsed.provider, parsed.modelId);
				if ([...select.options].some((o) => o.value === value)) {
					select.value = value;
				}
			}
		}
	}

	function renderRoleModelSelects(config: HubModelsConfigPayload): void {
		roleModelsForm.innerHTML = "";
		for (const role of config.roles) {
			const row = el("div", "role-model-row");
			const label = el("label", "role-model-label");
			label.textContent = role.name;
			const select = el("select") as HTMLSelectElement;
			label.appendChild(select);
			fillModelSelectElement(select, config.models, role.modelRef, true);
			select.addEventListener("change", () => {
				void (async () => {
					const parsed = parseModelOptionValue(select.value);
					try {
						const updated = await client.setRoleModel(
							role.name,
							parsed?.provider ?? null,
							parsed?.modelId ?? null,
						);
						renderRoleModelSelects(updated);
					} catch (e) {
						showError(e instanceof Error ? e.message : String(e));
					}
				})();
			});
			row.appendChild(label);
			roleModelsForm.appendChild(row);
		}
	}

	async function refreshModelsUi(selected?: { provider: string; id: string }): Promise<void> {
		const config = await client.getModelsConfig();
		availableModels = config.models;
		fillModelSelect(availableModels, selected);
		renderRoleModelSelects(config);
		const current = availableModels.find((m) => selected && m.provider === selected.provider && m.id === selected.id);
		if (current) {
			providerInput.value = current.provider;
			baseUrlInput.value = current.baseUrl;
		}
	}

	async function refreshModelList(selected?: { provider: string; id: string }): Promise<void> {
		await refreshModelsUi(selected);
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

	function assistantMetaLabel(host?: string | null): string | undefined {
		return host ?? turnHostName ?? undefined;
	}

	function formatActivityLabel(msg: HubActivityUpdateMessage): string {
		const host = msg.hostDisplayName ?? "Host";
		switch (msg.phase) {
			case "thinking":
				return `${host} is thinking…`;
			case "tool":
				return msg.detail ? `${host} is using tool: ${msg.detail}` : `${host} is using a tool…`;
			case "compacting":
				return msg.detail ? `${host} · compacting (${msg.detail})` : `${host} is compacting context…`;
			case "replying":
				return `${host} is replying…`;
			default:
				return "";
		}
	}

	function updateActivityBar(msg: HubActivityUpdateMessage): void {
		if (msg.hostDisplayName) {
			turnHostName = msg.hostDisplayName;
		}
		const label = formatActivityLabel(msg);
		if (msg.phase === "idle" || !label) {
			activityBar.classList.add("hidden");
			activityBar.textContent = "";
			return;
		}
		activityBar.textContent = label;
		activityBar.classList.remove("hidden");
	}

	function appendMessage(role: string, text: string, meta?: string, animate = true): HTMLElement {
		const div = el("div", `msg ${role}${animate ? " msg-animate-in" : ""}`);
		const label = meta ?? (role === "assistant" ? assistantMetaLabel() : undefined);
		if (label) {
			const m = el("div", "meta");
			m.textContent = label;
			div.appendChild(m);
		}
		const body = el("div", "msg-body");
		body.textContent = text;
		div.appendChild(body);
		messages.appendChild(div);
		messages.scrollTop = messages.scrollHeight;
		return div;
	}

	function renderHistory(msgs: unknown[]): void {
		messages.innerHTML = "";
		streamingAssistantEl = null;
		for (const msg of msgs) {
			const m = msg as { role?: string; customType?: string };
			if (m.role === "user" || m.role === "assistant") {
				appendMessage(m.role, getMessageText(msg), undefined, false);
			} else if (m.role === "custom") {
				const div = el("div", `msg ${messageRoleClass(m)}`);
				const meta = el("div", "meta");
				meta.textContent = m.customType ?? "role";
				div.appendChild(meta);
				const body = el("div", "msg-body");
				body.textContent = getMessageText(msg);
				div.appendChild(body);
				messages.appendChild(div);
			}
		}
		messages.scrollTop = messages.scrollHeight;
	}

	function lastUserMessageText(): string | null {
		const last = messages.querySelector(".msg.user:last-child .msg-body");
		return last?.textContent ?? null;
	}

	function updateStreamingAssistant(message: unknown, host?: string | null): void {
		if (!streamingAssistantEl) {
			return;
		}
		const meta = streamingAssistantEl.querySelector(".meta");
		const label = assistantMetaLabel(host);
		if (meta) {
			meta.textContent = label;
		} else if (label) {
			const m = el("div", "meta");
			m.textContent = label;
			streamingAssistantEl.prepend(m);
		}
		const body = streamingAssistantEl.querySelector(".msg-body");
		if (body) {
			body.textContent = getMessageText(message);
		}
		messages.scrollTop = messages.scrollHeight;
	}

	function updateQueue(msg: HubServerMessage): void {
		if (msg.type !== "queue_update") return;
		const pending = (msg.pending as unknown[]) ?? [];
		const current = msg.current as { displayName?: string } | null;
		if (current?.displayName) {
			turnHostName = current.displayName;
		}
		if (current) {
			queueBar.textContent = `Running: ${current.displayName ?? "?"} · ${pending.length} queued`;
		} else if (pending.length > 0) {
			queueBar.textContent = `${pending.length} message(s) queued`;
		} else {
			queueBar.textContent = "Queue empty";
		}
	}

	function showRoleGap(uncovered: Array<{ description: string; reason: string }>): void {
		if (uncovered.length === 0) {
			roleGapBar.classList.add("hidden");
			roleGapBar.textContent = "";
			return;
		}
		const lines = uncovered.map((g) => `${g.description} — ${g.reason}`);
		roleGapBar.textContent = `Uncovered work (no matching role): ${lines.join("; ")}`;
		roleGapBar.classList.remove("hidden");
	}

	function showRolePlan(plan: {
		summary: string;
		tasks: Array<{ role: string; task: string; dependsOn?: string[] }>;
	}): void {
		const parts = [`Plan: ${plan.summary}`];
		for (const t of plan.tasks) {
			const deps = t.dependsOn?.length ? ` (after: ${t.dependsOn.join(", ")})` : "";
			parts.push(`• ${t.role}${deps}: ${t.task}`);
		}
		rolePlanPanel.textContent = parts.join("\n");
		rolePlanPanel.classList.remove("hidden");
	}

	function updateRoleProgress(msg: HubServerMessage): void {
		if (msg.type !== "role_progress") return;
		const role = String(msg.role ?? "");
		const phase = String(msg.phase ?? "");
		const preview = msg.preview ? ` — ${String(msg.preview)}` : "";
		roleProgressBar.textContent = `Role ${role}: ${phase}${preview}`;
		roleProgressBar.classList.remove("hidden");
		if (phase === "done" || phase === "failed") {
			setTimeout(() => {
				if (roleProgressBar.textContent?.includes(`${role}: ${phase}`)) {
					roleProgressBar.classList.add("hidden");
				}
			}, 8000);
		}
	}

	function handleRoleOrchestration(msg: HubServerMessage): void {
		if (msg.type === "role_gap") {
			showRoleGap((msg.uncovered as Array<{ description: string; reason: string }>) ?? []);
		}
		if (msg.type === "role_plan") {
			showRolePlan(
				(msg.plan as {
					summary: string;
					tasks: Array<{ role: string; task: string; dependsOn?: string[] }>;
				}) ?? { summary: "", tasks: [] },
			);
		}
		if (msg.type === "role_progress") {
			updateRoleProgress(msg);
		}
	}

	function handleAgentEvent(msg: HubServerMessage): void {
		if (msg.type !== "agent_event") return;
		const hostDisplayName = (msg.hostDisplayName as string | undefined) ?? turnHostName;
		if (hostDisplayName) {
			turnHostName = hostDisplayName;
		}
		const event = msg.event as {
			type: string;
			message?: unknown;
			messages?: unknown[];
			assistantMessageEvent?: { type: string; delta?: string };
			toolName?: string;
		};
		if (event.type === "message_start" && event.message) {
			const m = event.message as { role?: string; customType?: string };
			if (m.role === "assistant") {
				streamingAssistantEl = appendMessage("assistant", "", assistantMetaLabel(hostDisplayName));
			} else if (m.role === "custom") {
				const div = el("div", `msg ${messageRoleClass(m)}`);
				const meta = el("div", "meta");
				meta.textContent = m.customType ?? "role";
				div.appendChild(meta);
				const body = el("div", "msg-body");
				body.textContent = getMessageText(event.message);
				div.appendChild(body);
				messages.appendChild(div);
				messages.scrollTop = messages.scrollHeight;
			}
		}
		if (event.type === "message_update" && event.message) {
			const m = event.message as { role?: string };
			if (m.role === "assistant") {
				if (!streamingAssistantEl) {
					streamingAssistantEl = appendMessage("assistant", "", assistantMetaLabel(hostDisplayName));
				}
				updateStreamingAssistant(event.message, hostDisplayName);
			}
		}
		if (event.type === "message_end" && event.message) {
			const m = event.message as { role?: string };
			if (m.role === "assistant") {
				if (!streamingAssistantEl) {
					streamingAssistantEl = appendMessage("assistant", "", assistantMetaLabel(hostDisplayName));
				}
				updateStreamingAssistant(event.message, hostDisplayName);
				streamingAssistantEl = null;
			} else if (m.role === "user") {
				const text = getMessageText(m);
				if (text && text !== lastUserMessageText()) {
					appendMessage("user", text);
				}
			}
		}
		if (event.type === "agent_end" && Array.isArray(event.messages)) {
			renderHistory(event.messages);
		}
		if (event.type === "tool_execution_start") {
			const host = hostDisplayName ?? turnHostName;
			const prefix = host ? `${host} · ` : "";
			appendMessage("tool", `${prefix}Tool: ${event.toolName ?? "unknown"}`);
		}
	}

	function handleActivityUpdate(msg: HubServerMessage): void {
		if (msg.type !== "activity_update") return;
		updateActivityBar(msg as HubActivityUpdateMessage);
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
				await client.setProviderBaseUrl(provider, baseUrl);
				saveProviderUrlPref(provider, baseUrl);
				const parsed = parseModelOptionValue(modelSelect.value);
				await refreshModelsUi(parsed ? { provider: parsed.provider, id: parsed.modelId } : undefined);
				syncEndpointFieldsFromSelection();
			} catch (e) {
				showError(e instanceof Error ? e.message : String(e));
			}
		})();
	};

	async function refreshRoomsSidebar(): Promise<void> {
		try {
			const rooms = await client.listRooms();
			roomsList.innerHTML = "";
			for (const r of rooms) {
				const li = el("li");
				const btn = el("button", "room-link");
				btn.type = "button";
				btn.textContent = r.roomId;
				if (r.roomId === client.getRoomId()) {
					btn.classList.add("active");
				} else {
					btn.onclick = () => {
						void (async () => {
							try {
								await client.reconnect(r.roomId);
								room.textContent = r.roomId;
								cfg.roomId = r.roomId;
								saveStored(cfg);
								await refreshRoomsSidebar();
								await loadRoomConfigUi();
							} catch (e) {
								showError(e instanceof Error ? e.message : String(e));
							}
						})();
					};
				}
				li.appendChild(btn);
				roomsList.appendChild(li);
			}
		} catch (e) {
			showError(e instanceof Error ? e.message : String(e));
		}
	}

	async function loadRoomConfigUi(): Promise<void> {
		const config = await client.getRoomConfig(client.getRoomId());
		roomSkillsInput.value = (config.skills ?? []).join(", ");
		roomRulesInput.value = config.rules ?? "";
		roomRolesEnabled.checked = config.rolesEnabled === true;
		await refreshRoomAssignedRoles(config.roleNames ?? []);
	}

	async function refreshRoomAssignedRoles(assigned?: string[]): Promise<void> {
		const names = assigned ?? (await client.getRoomConfig(client.getRoomId())).roleNames ?? [];
		roomAssignedList.innerHTML = "";
		for (const name of names) {
			const li = el("li", "room-assigned-item");
			const label = el("span");
			label.textContent = name;
			const removeBtn = el("button", "secondary-btn danger-btn");
			removeBtn.type = "button";
			removeBtn.textContent = "Remove";
			removeBtn.onclick = () => {
				void (async () => {
					try {
						await client.removeRoomRole(name);
						await loadRoomConfigUi();
					} catch (e) {
						showError(e instanceof Error ? e.message : String(e));
					}
				})();
			};
			li.append(label, removeBtn);
			roomAssignedList.appendChild(li);
		}

		const allRoles = await client.listRoles();
		const assignedSet = new Set(names);
		roomRoleAddSelect.innerHTML = "";
		const placeholder = el("option") as HTMLOptionElement;
		placeholder.value = "";
		placeholder.textContent = names.length === allRoles.length ? "(all roles assigned)" : "Select role…";
		placeholder.disabled = names.length === allRoles.length;
		roomRoleAddSelect.appendChild(placeholder);
		for (const r of allRoles) {
			if (assignedSet.has(r.name)) continue;
			const opt = el("option") as HTMLOptionElement;
			opt.value = r.name;
			opt.textContent = `${r.name} (${r.source})`;
			roomRoleAddSelect.appendChild(opt);
		}
		roomRoleAddBtn.disabled = names.length === allRoles.length;
	}

	roomRoleAddBtn.onclick = () => {
		const name = roomRoleAddSelect.value.trim();
		if (!name) return;
		void (async () => {
			try {
				await client.addRoomRole(name);
				await loadRoomConfigUi();
			} catch (e) {
				showError(e instanceof Error ? e.message : String(e));
			}
		})();
	};

	async function refreshRolesSidebar(): Promise<void> {
		const roles = await client.listRoles();
		const prev = roleSelect.value;
		roleSelect.innerHTML = "";
		for (const r of roles) {
			const opt = el("option") as HTMLOptionElement;
			opt.value = r.name;
			opt.textContent = `${r.name} (${r.source})`;
			roleSelect.appendChild(opt);
		}
		if (roles.length > 0) {
			roleSelect.value = roles.some((r) => r.name === prev) ? prev : roles[0]!.name;
			await loadRoleEditor(roleSelect.value);
		}
	}

	async function loadRoleEditor(name: string): Promise<void> {
		const role = await client.getRole(name);
		roleEditor.value = role.content;
		roleMeta.textContent = `${role.source} · ${role.filePath}`;
	}

	roomCreateBtn.onclick = () => {
		void (async () => {
			const id = roomNewInput.value.trim();
			if (!id) return;
			try {
				await client.createRoom(id);
				await client.reconnect(id);
				room.textContent = id;
				cfg.roomId = id;
				saveStored(cfg);
				await refreshRoomsSidebar();
			} catch (e) {
				showError(e instanceof Error ? e.message : String(e));
			}
		})();
	};

	roomDeleteBtn.onclick = () => {
		if (!confirm(`Delete room "${client.getRoomId()}" and all session data?`)) return;
		void (async () => {
			try {
				const id = client.getRoomId();
				await client.deleteRoom(id, true);
				let rooms = await client.listRooms();
				if (rooms.length === 0) {
					await client.createRoom("default");
					rooms = await client.listRooms();
				}
				const nextId = rooms[0]!.roomId;
				await client.reconnect(nextId);
				room.textContent = nextId;
				cfg.roomId = nextId;
				saveStored(cfg);
				await refreshRoomsSidebar();
				await loadRoomConfigUi();
			} catch (e) {
				showError(e instanceof Error ? e.message : String(e));
			}
		})();
	};

	saveRoomCfgBtn.onclick = () => {
		void (async () => {
			try {
				const skills = roomSkillsInput.value
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				await client.setRoomConfig(client.getRoomId(), {
					skills: skills.length > 0 ? skills : undefined,
					rules: roomRulesInput.value.trim() || undefined,
					rolesEnabled: roomRolesEnabled.checked ? true : undefined,
				});
			} catch (e) {
				showError(e instanceof Error ? e.message : String(e));
			}
		})();
	};

	roleSelect.addEventListener("change", () => {
		void loadRoleEditor(roleSelect.value).catch((e) => showError(e instanceof Error ? e.message : String(e)));
	});

	saveRoleBtn.onclick = () => {
		void (async () => {
			try {
				await client.saveRole(roleSelect.value, roleEditor.value);
				await refreshRolesSidebar();
			} catch (e) {
				showError(e instanceof Error ? e.message : String(e));
			}
		})();
	};

	deleteRoleBtn.onclick = () => {
		if (!confirm(`Delete role "${roleSelect.value}"?`)) return;
		void (async () => {
			try {
				await client.deleteRole(roleSelect.value);
				await refreshRolesSidebar();
			} catch (e) {
				showError(e instanceof Error ? e.message : String(e));
			}
		})();
	};

	client.onMessage((msg) => {
		if (msg.type === "room_deleted" && msg.roomId === client.getRoomId()) {
			showError("This room was deleted");
			client.disconnect();
			setTimeout(
				() =>
					transitionView(root, () => renderConnect(root, (c) => transitionView(root, () => renderChat(root, c)))),
				1500,
			);
			return;
		}
		if (msg.type === "joined") {
			setConnectionLive(true);
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
				setConnectionLive(false);
				status.textContent = "Disconnected";
			}
		}
		updateQueue(msg);
		handleActivityUpdate(msg);
		handleRoleOrchestration(msg);
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

	updateHeaderStatus();
	client
		.connect()
		.then(() => {
			void refreshRoomsSidebar();
			void loadRoomConfigUi();
			void refreshRolesSidebar();
			void refreshRoomAssignedRoles();
		})
		.catch((e) => {
			setConnectionLive(false);
			showError(e instanceof Error ? e.message : String(e));
			status.textContent = "Failed";
			setTimeout(
				() =>
					transitionView(root, () => renderConnect(root, (c) => transitionView(root, () => renderChat(root, c)))),
				2000,
			);
		});
}

const app = document.getElementById("app")!;

function tryAutoConnect(): boolean {
	const stored = loadStored();
	if (!stored.token || !stored.hubUrl || !stored.roomId || !stored.displayName) return false;
	renderChat(app, {
		hubUrl: stored.hubUrl,
		roomId: stored.roomId,
		token: stored.token,
		displayName: stored.displayName,
	});
	return true;
}

if (!tryAutoConnect()) {
	renderConnect(app, (cfg) => transitionView(app, () => renderChat(app, cfg)));
}
