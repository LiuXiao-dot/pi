import { defaultWsUrl, HubClient } from "./hub-client.ts";
import type {
	HubActivityUpdateMessage,
	HubModelInfo,
	HubModelsConfigPayload,
	HubRoomSummary,
	HubServerMessage,
	HubSessionState,
} from "./protocol.ts";

interface StoredSession {
	hubUrl: string;
	token: string;
	displayName: string;
}

/** Persisted shape; roomId is last-opened room (legacy), not required to sign in. */
interface StoredConnectFile extends StoredSession {
	roomId?: string;
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

function loadStored(): Partial<StoredConnectFile> {
	try {
		return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<StoredConnectFile>;
	} catch {
		return {};
	}
}

function saveSession(session: StoredSession, lastRoomId?: string): void {
	const payload: StoredConnectFile = { ...session };
	if (lastRoomId) {
		payload.roomId = lastRoomId;
	}
	localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function formatRelativeTime(iso: string): string {
	const date = new Date(iso);
	const diff = Date.now() - date.getTime();
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return date.toLocaleDateString();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	return node;
}

/** Create room in hub registry when missing (join requires create_room first). */
async function ensureRoomRegistered(session: StoredSession, roomId: string, client?: HubClient): Promise<void> {
	const tmp = client ?? new HubClient(session.hubUrl, roomId, session.token, session.displayName);
	const ownsClient = !client;
	try {
		if (ownsClient) {
			await tmp.openSocket();
		}
		const rooms = await tmp.listRooms();
		if (!rooms.some((r) => r.roomId === roomId)) {
			await tmp.createRoom(roomId);
		}
	} finally {
		if (ownsClient) {
			tmp.disconnect();
		}
	}
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

const USER_AVATAR = "U";
const ASSISTANT_AVATAR = "π";

function renderLogin(root: HTMLElement): void {
	const stored = loadStored();
	root.innerHTML = "";
	const shell = el("div", "connect-shell");

	const hero = el("div", "connect-hero");
	const logoSymbol = Object.assign(el("div", "logo-symbol"), { textContent: "π" });
	hero.appendChild(logoSymbol);
	hero.appendChild(Object.assign(el("p", "eyebrow"), { textContent: "LAN workspace" }));
	hero.appendChild(Object.assign(el("h1"), { textContent: "pi Hub" }));
	shell.appendChild(hero);

	const panel = el("div", "connect-panel");
	panel.appendChild(
		Object.assign(el("p", "hint"), {
			textContent:
				"Sign in to the hub. Open from the same host as pi-hub (e.g. http://localhost:3141). Token from .pi/hub.json.",
		}),
	);

	const fields: Array<{ key: keyof StoredSession; label: string; type?: string }> = [
		{ key: "hubUrl", label: "WebSocket URL" },
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
		input.value = (stored[f.key] as string) ?? (f.key === "hubUrl" ? defaultWsUrl() : "");
		inputs[f.key] = input;
		label.appendChild(input);
		panel.appendChild(label);
	}

	const err = el("div", "error-banner hidden");
	panel.appendChild(err);

	const btn = el("button", "btn-primary");
	btn.textContent = "Sign in";
	btn.onclick = () => {
		void (async () => {
			const session: StoredSession = {
				hubUrl: inputs.hubUrl!.value.trim() || defaultWsUrl(),
				token: inputs.token!.value.trim(),
				displayName: inputs.displayName!.value.trim() || "anonymous",
			};
			if (!session.token) {
				err.textContent = "Token is required";
				err.classList.remove("hidden");
				return;
			}
			btn.disabled = true;
			const client = new HubClient(session.hubUrl, "_lobby", session.token, session.displayName);
			try {
				await client.openSocket();
				await client.listRooms();
				err.classList.add("hidden");
				saveSession(session, stored.roomId);
				transitionView(root, () =>
					renderWorkspace(root, session, client, stored.roomId, () => {
						client.disconnect();
						transitionView(root, () => renderLogin(root));
					}),
				);
			} catch (e) {
				client.disconnect();
				err.textContent = e instanceof Error ? e.message : String(e);
				err.classList.remove("hidden");
			} finally {
				btn.disabled = false;
			}
		})();
	};
	panel.appendChild(btn);
	shell.appendChild(panel);
	root.appendChild(shell);
}

function renderWorkspace(
	root: HTMLElement,
	session: StoredSession,
	client: HubClient,
	initialRoomId: string | undefined,
	onSignOut: () => void,
): void {
	root.innerHTML = "";
	const shell = el("div", "workspace-shell");

	const topHeader = el("header", "workspace-header");
	const brand = el("span", "workspace-brand");
	brand.textContent = "pi Hub";

	const rolesBtn = el("button", "secondary-btn");
	rolesBtn.type = "button";
	rolesBtn.textContent = "Roles";
	rolesBtn.onclick = () => showRoleLibraryModal();
	topHeader.appendChild(rolesBtn);

	const user = el("span", "workspace-user");
	user.textContent = session.displayName;
	const signOutBtn = el("button", "secondary-btn");
	signOutBtn.type = "button";
	signOutBtn.textContent = "Sign out";
	signOutBtn.onclick = () => onSignOut();
	topHeader.append(brand, rolesBtn, user, signOutBtn);
	shell.appendChild(topHeader);

	const body = el("div", "workspace-layout");
	const roomRailBackdrop = el("div", "room-rail-backdrop");
	const roomRail = el("aside", "room-rail");
	const chatColumn = el("div", "chat-column");
	body.append(roomRailBackdrop, roomRail, chatColumn);
	shell.appendChild(body);
	root.appendChild(shell);

	const railHeader = el("div", "room-rail-header");
	railHeader.appendChild(Object.assign(el("h2", "room-rail-title"), { textContent: "Rooms" }));

	const roomToolbar = el("div", "room-toolbar");
	const newRoomInput = el("input") as HTMLInputElement;
	newRoomInput.placeholder = "new-room-id";
	const createBtn = el("button", "secondary-btn");
	createBtn.type = "button";
	createBtn.textContent = "Create";
	roomToolbar.append(newRoomInput, createBtn);

	const railErr = el("div", "error-banner hidden");
	const roomList = el("ul", "room-list");
	roomRail.append(railHeader, roomToolbar, railErr, roomList);

	// Reset all open swipes when clicking/tapping the rail background
	roomRail.addEventListener("click", (ev) => {
		const target = ev.target as HTMLElement;
		if (!target.closest(".room-swipe-wrap")) {
			for (const wrap of roomList.querySelectorAll(".room-swipe-wrap")) {
				(wrap as HTMLElement).style.transform = "translateX(0)";
				const da = wrap.querySelector(".room-swipe-delete") as HTMLElement | null;
				if (da) da.style.opacity = "0";
			}
		}
	});

	function closeRoomRail(): void {
		roomRail.classList.remove("open");
		roomRailBackdrop.classList.remove("visible");
	}

	function openRoomRail(): void {
		roomRail.classList.add("open");
		roomRailBackdrop.classList.add("visible");
	}

	roomRailBackdrop.onclick = () => closeRoomRail();

	let selectedRoomId: string | null = initialRoomId ?? null;
	let selectInFlight = false;
	let reconnecting = false;

	function showRailError(message: string): void {
		railErr.textContent = message;
		railErr.classList.remove("hidden");
	}

	function updateRailHighlight(): void {
		for (const row of roomList.querySelectorAll(".room-row")) {
			row.classList.toggle("active", row.getAttribute("data-room-id") === selectedRoomId);
		}
	}

	function renderRoomRows(rooms: HubRoomSummary[]): void {
		roomList.innerHTML = "";
		if (rooms.length === 0) {
			const empty = el("li", "room-list-empty");
			empty.textContent = "No rooms yet. Create one above.";
			roomList.appendChild(empty);
			return;
		}
		for (const r of rooms) {
			const li = el("li");

			// Swipe container: wraps row + hidden delete action
			const swipeWrap = el("div", "room-swipe-wrap");

			const row = el("button", "room-row");
			row.type = "button";
			row.setAttribute("data-room-id", r.roomId);
			if (r.roomId === selectedRoomId) {
				row.classList.add("active");
			}
			const main = el("span", "room-row-title");
			main.textContent = r.title?.trim() ? r.title : r.roomId;
			const meta = el("span", "room-card-meta");
			const online = r.clientCount ?? 0;
			meta.textContent = `${formatRelativeTime(r.updatedAt)} · ${online} online`;
			row.append(main, meta);

			// Delete action (hidden behind the row, revealed on swipe left)
			const deleteAction = el("button", "room-swipe-delete danger-btn");
			deleteAction.type = "button";
			deleteAction.textContent = "Delete";

			const roomId = r.roomId;
			deleteAction.onclick = () => {
				if (!confirm(`Delete room "${roomId}" and all session data?`)) return;
				void (async () => {
					try {
						if (selectedRoomId === roomId && client.isJoined()) {
							await client.leave();
							selectedRoomId = null;
						}
						await client.deleteRoom(roomId, true);
						await refreshRoomList();
					} catch (e) {
						showRailError(e instanceof Error ? e.message : String(e));
					}
				})();
			};

			// Touch swipe logic
			let startX = 0;
			let currentX = 0;
			let isDragging = false;
			const SWIPE_THRESHOLD = 60;

			function updateSwipe(dx: number): void {
				if (dx <= 0) {
					// Swiping left — reveal delete behind
					swipeWrap.style.transform = `translateX(${Math.max(dx, -SWIPE_THRESHOLD)}px)`;
					deleteAction.style.opacity = String(Math.min(1, Math.abs(dx) / SWIPE_THRESHOLD));
				} else {
					// Swiping right — reset
					swipeWrap.style.transform = "translateX(0)";
					deleteAction.style.opacity = "0";
				}
			}

			function commitSwipe(dx: number): void {
				if (dx < -SWIPE_THRESHOLD / 2) {
					// Open delete
					swipeWrap.style.transform = `translateX(-${SWIPE_THRESHOLD}px)`;
					deleteAction.style.opacity = "1";
				} else {
					// Reset
					swipeWrap.style.transform = "translateX(0)";
					deleteAction.style.opacity = "0";
				}
			}

			swipeWrap.addEventListener(
				"touchstart",
				(e) => {
					startX = e.touches[0]!.clientX;
					isDragging = true;
				},
				{ passive: true },
			);

			swipeWrap.addEventListener(
				"touchmove",
				(e) => {
					if (!isDragging) return;
					currentX = e.touches[0]!.clientX;
					const dx = currentX - startX;
					updateSwipe(dx);
				},
				{ passive: true },
			);

			swipeWrap.addEventListener(
				"touchend",
				() => {
					if (!isDragging) return;
					isDragging = false;
					const dx = currentX - startX;
					commitSwipe(dx);
					startX = 0;
					currentX = 0;
				},
				{ passive: true },
			);

			// Click on row still selects the room; close any open swipe first
			row.onclick = () => {
				// Reset any open swipe
				swipeWrap.style.transform = "translateX(0)";
				deleteAction.style.opacity = "0";
				closeRoomRail();
				void selectRoom(roomId);
			};

			// Clicking anywhere else on the rail resets all swipes
			// (handled via a single listener below)

			swipeWrap.append(row, deleteAction);
			li.appendChild(swipeWrap);
			roomList.appendChild(li);
		}
	}

	async function refreshRoomList(): Promise<void> {
		if (!client.isSocketOpen()) {
			await client.openSocket();
		}
		const rooms = await client.listRooms();
		renderRoomRows(rooms);
		railErr.classList.add("hidden");
		return rooms;
	}

	createBtn.onclick = () => {
		const id = newRoomInput.value.trim();
		if (!id) return;
		void (async () => {
			try {
				await client.createRoom(id);
				newRoomInput.value = "";
				await refreshRoomList();
				await selectRoom(id);
			} catch (e) {
				showRailError(e instanceof Error ? e.message : String(e));
			}
		})();
	};

	const layout = el("div", "chat-layout");
	const panel = el("div", "chat-panel");
	layout.appendChild(panel);
	chatColumn.appendChild(layout);

	const header = el("div", "header");
	const headerBrand = el("div", "header-brand");
	const roomsToggle = el("button", "secondary-btn room-rail-toggle");
	roomsToggle.type = "button";
	roomsToggle.setAttribute("aria-label", "Toggle room list");
	roomsToggle.textContent = "Rooms";
	roomsToggle.onclick = () => {
		if (roomRail.classList.contains("open")) closeRoomRail();
		else openRoomRail();
	};
	const roomSettingsBtn = el("button", "secondary-btn");
	roomSettingsBtn.type = "button";
	roomSettingsBtn.textContent = "Settings";
	roomSettingsBtn.onclick = () => {
		if (selectedRoomId) {
			showRoomConfigModal();
		}
	};
	headerBrand.append(roomsToggle);
	const roomLabel = el("span", "room");
	roomLabel.textContent = selectedRoomId ?? "Select a room";
	headerBrand.appendChild(roomLabel);
	headerBrand.appendChild(roomSettingsBtn);

	const statusWrap = el("div", "status-wrap");
	const statusDot = el("span", "status-dot connecting");
	const status = el("span", "status");
	status.textContent = "Connecting…";
	statusWrap.append(statusDot, status);
	header.append(headerBrand, statusWrap);
	panel.appendChild(header);

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

	// Room config modal elements (created once, reused)
	const roomSkillsInput = el("input") as HTMLInputElement;
	roomSkillsInput.placeholder = "skills (comma-separated)";
	const roomRulesInput = el("textarea") as HTMLTextAreaElement;
	roomRulesInput.placeholder = "Room rules (inline)";
	roomRulesInput.rows = 3;
	const roomRolesEnabled = el("input") as HTMLInputElement;
	roomRolesEnabled.type = "checkbox";

	function showRoomConfigModal(): void {
		if (!selectedRoomId) return;

		const backdrop = el("div", "modal-backdrop");
		const modal = el("div", "modal config-modal");

		const title = el("h3");
		title.textContent = `Room settings: ${selectedRoomId}`;
		modal.appendChild(title);

		// Room config fields
		const cfgSection = el("div", "config-section");
		const cfgHeading = el("h4", "config-heading");
		cfgHeading.textContent = "Configuration";
		cfgSection.appendChild(cfgHeading);

		const skillsLabel = el("label", "config-field");
		skillsLabel.textContent = "Skills";
		const skillsClone = roomSkillsInput.cloneNode() as HTMLInputElement;
		skillsClone.value = roomSkillsInput.value;
		skillsClone.placeholder = "skills (comma-separated)";
		skillsLabel.appendChild(skillsClone);
		cfgSection.appendChild(skillsLabel);

		const rulesLabel = el("label", "config-field");
		rulesLabel.textContent = "Rules";
		const rulesClone = roomRulesInput.cloneNode() as HTMLTextAreaElement;
		rulesClone.value = roomRulesInput.value;
		rulesClone.rows = 3;
		rulesClone.placeholder = "Room rules (inline)";
		rulesLabel.appendChild(rulesClone);
		cfgSection.appendChild(rulesLabel);

		const rolesCb = roomRolesEnabled.cloneNode() as HTMLInputElement;
		rolesCb.type = "checkbox";
		rolesCb.checked = roomRolesEnabled.checked;
		const rolesEnabledLabel = el("label", "config-field config-checkbox");
		rolesEnabledLabel.append(rolesCb, document.createTextNode(" Enable roles in this room"));
		cfgSection.appendChild(rolesEnabledLabel);

		modal.appendChild(cfgSection);

		// Room roles section
		const rolesSection = el("div", "config-section");
		const rolesHeading = el("h4", "config-heading");
		rolesHeading.textContent = "Assigned roles";
		rolesSection.appendChild(rolesHeading);
		rolesSection.appendChild(
			Object.assign(el("p", "config-hint"), {
				textContent: "Add roles from the library (include PM + workers). No duplicates.",
			}),
		);

		const assignedListClone = el("ul", "room-assigned-list");
		// Re-render assigned roles with modal-aware remove handler
		void (async () => {
			const names = (await client.getRoomConfig(selectedRoomId!)).roleNames ?? [];
			renderAssignedRoles(assignedListClone, names, () => {
				void loadRoomConfigUi(selectedRoomId!).then(() => {
					renderAssignedRoles(assignedListClone, names, () => {});
				});
			});
		})();
		rolesSection.appendChild(assignedListClone);

		const addRow = el("div", "sidebar-row");
		const addSelect = el("select") as HTMLSelectElement;
		const addBtn = el("button", "secondary-btn");
		addBtn.type = "button";
		addBtn.textContent = "Add role";
		addRow.append(addSelect, addBtn);

		void (async () => {
			const names = (await client.getRoomConfig(selectedRoomId!)).roleNames ?? [];
			const allRoles = await client.listRoles();
			fillRoleAddSelect(addSelect, allRoles, names);
		})();

		addBtn.onclick = () => {
			const name = addSelect.value.trim();
			if (!name || !selectedRoomId) return;
			void (async () => {
				try {
					await client.addRoomRole(name, selectedRoomId!);
					const config = await client.getRoomConfig(selectedRoomId!);
					const names2 = config.roleNames ?? [];
					renderAssignedRoles(assignedListClone, names2, () => {});
					const allRoles2 = await client.listRoles();
					fillRoleAddSelect(addSelect, allRoles2, names2);
				} catch (e) {
					showError(e instanceof Error ? e.message : String(e));
				}
			})();
		};

		rolesSection.appendChild(addRow);
		modal.appendChild(rolesSection);

		// Actions
		const actions = el("div", "modal-actions");
		const saveBtn = el("button", "primary-btn");
		saveBtn.textContent = "Save";
		saveBtn.onclick = () => {
			void (async () => {
				try {
					const skills = skillsClone.value
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean);
					await client.setRoomConfig(selectedRoomId!, {
						skills: skills.length > 0 ? skills : undefined,
						rules: rulesClone.value.trim() || undefined,
						rolesEnabled: rolesCb.checked ? true : undefined,
					});
					// Sync back the static inputs
					roomSkillsInput.value = skillsClone.value;
					roomRulesInput.value = rulesClone.value;
					roomRolesEnabled.checked = rolesCb.checked;
					backdrop.remove();
				} catch (e) {
					showError(e instanceof Error ? e.message : String(e));
				}
			})();
		};
		const cancelBtn = el("button", "secondary-btn");
		cancelBtn.textContent = "Cancel";
		cancelBtn.onclick = () => backdrop.remove();
		actions.append(saveBtn, cancelBtn);
		modal.appendChild(actions);

		backdrop.appendChild(modal);
		document.body.appendChild(backdrop);
	}

	function renderAssignedRoles(list: HTMLUListElement, names: string[], _onChange: () => void): void {
		list.innerHTML = "";
		for (const name of names) {
			const li = el("li", "room-assigned-item");
			const label = el("span");
			label.textContent = name;
			const removeBtn = el("button", "secondary-btn danger-btn");
			removeBtn.type = "button";
			removeBtn.textContent = "Remove";
			removeBtn.onclick = () => {
				if (!selectedRoomId) return;
				void (async () => {
					try {
						await client.removeRoomRole(name, selectedRoomId!);
						const config = await client.getRoomConfig(selectedRoomId!);
						const updated = config.roleNames ?? [];
						renderAssignedRoles(list, updated, _onChange);
						// Re-fill the add select
						const addSelect2 = list.parentElement?.querySelector("select") as HTMLSelectElement | null;
						if (addSelect2) {
							const allRoles = await client.listRoles();
							fillRoleAddSelect(addSelect2, allRoles, updated);
						}
						_onChange();
					} catch (e) {
						showError(e instanceof Error ? e.message : String(e));
					}
				})();
			};
			li.append(label, removeBtn);
			list.appendChild(li);
		}
	}

	function fillRoleAddSelect(
		select: HTMLSelectElement,
		allRoles: Array<{ name: string; source: string }>,
		assigned: string[],
	): void {
		const assignedSet = new Set(assigned);
		select.innerHTML = "";
		const placeholder = el("option") as HTMLOptionElement;
		placeholder.value = "";
		placeholder.textContent = assigned.length === allRoles.length ? "(all roles assigned)" : "Select role…";
		placeholder.disabled = assigned.length === allRoles.length;
		select.appendChild(placeholder);
		for (const r of allRoles) {
			if (assignedSet.has(r.name)) continue;
			const opt = el("option") as HTMLOptionElement;
			opt.value = r.name;
			opt.textContent = `${r.name} (${r.source})`;
			select.appendChild(opt);
		}
	}

	// Role library modal
	function showRoleLibraryModal(): void {
		const backdrop = el("div", "modal-backdrop");
		const modal = el("div", "modal config-modal");

		const title = el("h3");
		title.textContent = "Role library";
		modal.appendChild(title);

		const select = el("select") as HTMLSelectElement;
		const editor = el("textarea", "role-editor") as HTMLTextAreaElement;
		editor.rows = 12;
		editor.spellcheck = false;
		const meta = el("div", "role-meta");

		async function loadRole(name: string): Promise<void> {
			const role = await client.getRole(name);
			editor.value = role.content;
			meta.textContent = `${role.source} · ${role.filePath}`;
		}

		async function refreshSelect(): Promise<void> {
			const roles = await client.listRoles();
			const prev = select.value;
			select.innerHTML = "";
			for (const r of roles) {
				const opt = el("option") as HTMLOptionElement;
				opt.value = r.name;
				opt.textContent = `${r.name} (${r.source})`;
				select.appendChild(opt);
			}
			if (roles.length > 0) {
				select.value = roles.some((r) => r.name === prev) ? prev : roles[0]!.name;
				await loadRole(select.value);
			} else {
				editor.value = "";
				meta.textContent = "";
			}
		}

		modal.appendChild(select);
		modal.appendChild(meta);
		modal.appendChild(editor);

		select.addEventListener("change", () => {
			void loadRole(select.value).catch((e) => showError(e instanceof Error ? e.message : String(e)));
		});

		const actions = el("div", "modal-actions");

		const saveBtn = el("button", "primary-btn");
		saveBtn.textContent = "Save";
		saveBtn.onclick = () => {
			void (async () => {
				try {
					await client.saveRole(select.value, editor.value);
					await refreshSelect();
				} catch (e) {
					showError(e instanceof Error ? e.message : String(e));
				}
			})();
		};

		const deleteBtn = el("button", "secondary-btn danger-btn");
		deleteBtn.textContent = "Delete";
		deleteBtn.onclick = () => {
			if (!confirm(`Delete role "${select.value}"?`)) return;
			void (async () => {
				try {
					await client.deleteRole(select.value);
					await refreshSelect();
				} catch (e) {
					showError(e instanceof Error ? e.message : String(e));
				}
			})();
		};

		const cancelBtn = el("button", "secondary-btn");
		cancelBtn.textContent = "Close";
		cancelBtn.onclick = () => backdrop.remove();

		actions.append(saveBtn, deleteBtn, cancelBtn);
		modal.appendChild(actions);

		backdrop.appendChild(modal);
		document.body.appendChild(backdrop);

		void refreshSelect().catch((e) => showError(e instanceof Error ? e.message : String(e)));
	}

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
		// Add avatar dot for user/assistant messages
		if (role === "user" || role === "assistant") {
			const avatar = el("span", "msg-avatar");
			avatar.textContent = role === "user" ? USER_AVATAR : ASSISTANT_AVATAR;
			avatar.setAttribute("aria-hidden", "true");
			body.prepend(avatar);
		}
		body.append(document.createTextNode(text));
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
			const text = getMessageText(message);
			if (text) {
				body.textContent = text;
			} else {
				body.textContent = "⋯";
			}
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

	function setStreamingVisual(streaming: boolean): void {
		if (streaming) {
			sendBtn.disabled = true;
			sendBtn.textContent = "⋯";
		} else {
			sendBtn.disabled = false;
			sendBtn.textContent = "Send";
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
				setStreamingVisual(true);
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
				setStreamingVisual(false);
			} else if (m.role === "user") {
				const text = getMessageText(m);
				if (text && text !== lastUserMessageText()) {
					appendMessage("user", text);
				}
			}
		}
		if (event.type === "agent_end" && Array.isArray(event.messages)) {
			renderHistory(event.messages);
			setStreamingVisual(false);
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

	async function loadRoomConfigUi(roomId: string): Promise<void> {
		const config = await client.getRoomConfig(roomId);
		roomSkillsInput.value = (config.skills ?? []).join(", ");
		roomRulesInput.value = config.rules ?? "";
		roomRolesEnabled.checked = config.rolesEnabled === true;
	}

	function clearChatPanels(): void {
		messages.innerHTML = "";
		roleGapBar.classList.add("hidden");
		roleGapBar.textContent = "";
		rolePlanPanel.classList.add("hidden");
		rolePlanPanel.textContent = "";
		roleProgressBar.classList.add("hidden");
		roleProgressBar.textContent = "";
		activityBar.classList.add("hidden");
		activityBar.textContent = "";
		queueBar.textContent = "Queue empty";
		streamingAssistantEl = null;
		setStreamingVisual(false);
	}

	async function selectRoom(roomId: string): Promise<void> {
		if (selectInFlight) return;
		if (selectedRoomId === roomId && client.isJoined() && client.getRoomId() === roomId) {
			try {
				await loadRoomConfigUi(roomId);
			} catch (e) {
				showError(e instanceof Error ? e.message : String(e));
			}
			return;
		}

		selectInFlight = true;
		selectedRoomId = roomId;
		updateRailHighlight();
		roomLabel.textContent = roomId;
		saveSession(session, roomId);
		err.classList.add("hidden");
		setConnectionLive(false);
		status.textContent = "Connecting…";
		clearChatPanels();

		try {
			await ensureRoomRegistered(session, roomId, client);
			await client.switchRoom(roomId);
			await loadRoomConfigUi(roomId);
		} catch (e) {
			setConnectionLive(false);
			showError(e instanceof Error ? e.message : String(e));
			status.textContent = "Failed";
		} finally {
			selectInFlight = false;
		}
	}

	async function reconnectHub(): Promise<void> {
		if (!selectedRoomId || reconnecting) return;
		reconnecting = true;
		setConnectionLive(false);
		status.textContent = "Reconnecting…";
		showError("Hub disconnected. Reconnecting…");
		try {
			await client.openSocket();
			await selectRoom(selectedRoomId);
			err.classList.add("hidden");
		} catch (e) {
			showError(e instanceof Error ? e.message : String(e));
			status.textContent = "Disconnected";
		} finally {
			reconnecting = false;
		}
	}

	client.onMessage((msg) => {
		if (msg.type === "connection_lost") {
			void reconnectHub();
			return;
		}
		if (msg.type === "room_deleted") {
			void refreshRoomList();
			if (msg.roomId === selectedRoomId) {
				showError("This room was deleted");
				selectedRoomId = null;
				updateRailHighlight();
				roomLabel.textContent = "Select a room";
				clearChatPanels();
				setConnectionLive(false);
				status.textContent = "Room deleted";
			}
			return;
		}
		if (msg.type === "joined") {
			const joinedRoomId = (msg.roomId as string | undefined) ?? client.getRoomId();
			if (joinedRoomId !== selectedRoomId) {
				return;
			}
			setConnectionLive(true);
			clientId = (msg.clientId as string) ?? "";
			applyStateModel(msg.state as HubSessionState | undefined);
			renderHistory((msg.messages as unknown[]) ?? []);
			void loadRoomConfigUi(joinedRoomId).catch((e) => showError(e instanceof Error ? e.message : String(e)));
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
			if (msg.code === "unauthorized") {
				setConnectionLive(false);
				status.textContent = "Unauthorized";
				client.disconnect();
				onSignOut();
				return;
			}
			if (msg.code === "disconnected" || msg.code === "join_failed") {
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
		if (!text || !selectedRoomId || !client.isJoined()) return;
		input.value = "";
		appendMessage("user", text, session.displayName);
		client.prompt(text);
	};

	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			sendBtn.click();
		}
	});

	updateHeaderStatus();

	void (async () => {
		try {
			const rooms = await refreshRoomList();
			if (initialRoomId && rooms.some((r) => r.roomId === initialRoomId)) {
				await selectRoom(initialRoomId);
			}
		} catch (e) {
			showRailError(e instanceof Error ? e.message : String(e));
		}
	})();
}

const app = document.getElementById("app")!;

function signOut(client: HubClient): void {
	client.disconnect();
	transitionView(app, () => renderLogin(app));
}

function renderConnecting(root: HTMLElement): void {
	root.innerHTML = "";
	const shell = el("div", "connect-shell");
	shell.appendChild(Object.assign(el("p", "hint"), { textContent: "Connecting…" }));
	root.appendChild(shell);
}

function tryAutoSession(): boolean {
	const stored = loadStored();
	if (!stored.token || !stored.hubUrl || !stored.displayName) {
		return false;
	}
	const session: StoredSession = {
		hubUrl: stored.hubUrl,
		token: stored.token,
		displayName: stored.displayName,
	};
	const client = new HubClient(session.hubUrl, "_lobby", session.token, session.displayName);
	renderConnecting(app);
	void (async () => {
		try {
			await client.openSocket();
			transitionView(app, () => renderWorkspace(app, session, client, stored.roomId, () => signOut(client)));
		} catch {
			client.disconnect();
			transitionView(app, () => renderLogin(app));
		}
	})();
	return true;
}

if (!tryAutoSession()) {
	renderLogin(app);
}
