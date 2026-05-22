import { type MentionTarget, setupMentionComposer } from "./composer-mentions.ts";
import { defaultWsUrl, HubClient } from "./hub-client.ts";
import { resolveImageMimeType } from "./image-mime.ts";
import { showOfficeModal } from "./office-view.ts";
import type {
	HubActivityUpdateMessage,
	HubModelInfo,
	HubModelsConfigPayload,
	HubRoleMemory,
	HubRoleSummaryEntry,
	HubRoomInfo,
	HubRoomSummary,
	HubServerMessage,
	HubSessionState,
	HubSkillSummaryEntry,
	HubSleepPhase,
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

function simplifyProviderError(raw: string): string {
	const mediaType = raw.match(/media_type:[^"'\\]+/);
	if (mediaType) {
		return mediaType[0].replace(/\\"/g, '"');
	}

	let current = raw;
	for (let depth = 0; depth < 5; depth++) {
		try {
			const parsed = JSON.parse(current) as { message?: string; error?: { message?: string } };
			const next = parsed.error?.message ?? parsed.message;
			if (typeof next === "string" && next !== current) {
				current = next;
			}
		} catch {
			break;
		}
	}

	if (current.length > 600) {
		return `${current.slice(0, 600)}…`;
	}
	return current;
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

type AssistantContentPart = { type: string; name?: string; text?: string };

type AssistantMessageMeta = {
	text: string;
	stopReason?: string;
	errorMessage?: string;
	content: AssistantContentPart[];
};

function getAssistantMessageMeta(message: unknown): AssistantMessageMeta {
	const text = getMessageText(message);
	if (!message || typeof message !== "object") {
		return { text, content: [] };
	}
	const m = message as { stopReason?: string; errorMessage?: string; content?: unknown };
	const content = Array.isArray(m.content) ? (m.content as AssistantContentPart[]) : [];
	return { text, stopReason: m.stopReason, errorMessage: m.errorMessage, content };
}

type AssistantDisplay = {
	displayText: string;
	isFailed: boolean;
	bannerMessage?: string;
	// True when this assistant message represents an intermediate step
	// (tool calls / pure thinking) that should not produce a main bubble.
	suppressBubble?: boolean;
};

function formatAssistantDisplay(meta: AssistantMessageMeta): AssistantDisplay {
	const text = meta.text.trim();
	const errMsg = meta.errorMessage?.trim();
	const stop = meta.stopReason;
	const toolCalls = meta.content.filter((c) => c.type === "toolCall");
	const hasThinking = meta.content.some((c) => c.type === "thinking");

	// 1. Real error / abort: keep behavior
	if (stop === "error" || stop === "aborted") {
		const label = stop === "aborted" ? "Aborted" : "Error";
		const detail = errMsg ? simplifyProviderError(errMsg) : "The request ended without a response.";
		const displayText = text || `${label}: ${detail}`;
		return { displayText, isFailed: true, bannerMessage: `${label}: ${detail}` };
	}

	// 2. Tool-use step: model handed off to tools. Not a failure; suppress bubble
	//    when there is no accompanying text (the tool cards / activity row already
	//    convey the state).
	if (stop === "toolUse") {
		if (text) {
			return { displayText: meta.text, isFailed: false };
		}
		const names = toolCalls.map((c) => c.name).filter((n): n is string => !!n);
		return {
			displayText: names.length ? `调用工具：${names.join(", ")}` : "",
			isFailed: false,
			suppressBubble: true,
		};
	}

	// 3. Normal text
	if (text) {
		return { displayText: meta.text, isFailed: false };
	}

	// 4. No text but has tool calls (some providers emit toolUse content with stop==="stop")
	if (toolCalls.length > 0) {
		const names = toolCalls.map((c) => c.name).filter((n): n is string => !!n);
		return {
			displayText: names.length ? `调用工具：${names.join(", ")}` : "",
			isFailed: false,
			suppressBubble: true,
		};
	}

	// 5. Pure thinking with no visible text: suppress bubble; activity row shows it.
	if (hasThinking) {
		return { displayText: "", isFailed: false, suppressBubble: true };
	}

	// 6. Non-fatal provider message (errorMessage but stop !== error/aborted)
	if (errMsg) {
		const detail = simplifyProviderError(errMsg);
		return { displayText: detail, isFailed: true, bannerMessage: detail };
	}

	// 7. Genuine empty response
	const displayText = "(No response from model)";
	return {
		displayText,
		isFailed: true,
		bannerMessage: "The model returned an empty response.",
	};
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

type ReplyKind = "session" | "role";
type ReplyPhase = "running" | "done" | "failed";

interface ReplyEntry {
	id: string;
	roomId: string;
	kind: ReplyKind;
	label: string;
	roleName?: string;
	phase: ReplyPhase;
	detail?: string;
	summary: string;
	messages: unknown[];
	events: unknown[];
	startedAt: number;
	endedAt?: number;
	/**
	 * Original user prompt text for `kind === "session"` entries. Used by
	 * `renderRoomStatusBoard` to interleave the user bubble with its status row
	 * in chronological order, so the prior "all bubbles, then all status rows"
	 * layout no longer separates a turn's question from its result.
	 */
	userText?: string;
	userMeta?: string;
}

function truncateSummary(text: string, max = 80): string {
	const t = text.trim();
	if (t.length <= max) return t;
	return `${t.slice(0, max)}…`;
}

function sessionReplyId(roomId: string, turnId: string): string {
	return `session:${roomId}:${turnId}`;
}

function roleReplyId(taskId: string): string {
	return `role:${taskId}`;
}

function activityPhaseToDetail(phase: string, detail?: string): string | undefined {
	switch (phase) {
		case "thinking":
			return "思考中";
		case "tool":
			return detail ? `调用工具 ${detail}` : "调用工具";
		case "compacting":
			return "整理输出";
		case "replying":
			return undefined;
		default:
			return undefined;
	}
}

function formatStatusLine(entry: ReplyEntry, myDisplayName: string): string {
	const base = `to ${myDisplayName} · ${entry.label}`;
	if (entry.phase === "running") {
		if (entry.detail) return `${base} · ${entry.detail}`;
		return `${base} · 进行中…`;
	}
	if (entry.phase === "done") {
		return entry.summary ? `${base} · 已完成 — ${entry.summary}` : `${base} · 已完成`;
	}
	return entry.summary ? `${base} · 失败 — ${entry.summary}` : `${base} · 失败`;
}

function renderLogin(root: HTMLElement): void {
	hideLoadingScreen();
	const stored = loadStored();
	root.innerHTML = "";
	const shell = el("div", "connect-shell");

	const hero = el("div", "connect-hero");
	const logoWrapper = el("div", "logo-wrapper");
	const logoRing = el("div", "logo-ring");
	const logoSymbol = Object.assign(el("div", "logo-symbol"), { textContent: "π" });
	logoWrapper.append(logoRing, logoSymbol);
	hero.appendChild(logoWrapper);
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

function hideLoadingScreen(): void {
	const ls = document.getElementById("loading-screen");
	if (ls) {
		ls.style.opacity = "0";
		ls.style.transition = "opacity 200ms ease";
		setTimeout(() => ls.remove(), 250);
	}
}

function renderWorkspace(
	root: HTMLElement,
	session: StoredSession,
	client: HubClient,
	initialRoomId: string | undefined,
	onSignOut: () => void,
): void {
	hideLoadingScreen();
	root.innerHTML = "";
	const shell = el("div", "workspace-shell");

	// Gradient accent bar at top
	const accentBar = el("div", "accent-bar");
	shell.appendChild(accentBar);

	const topHeader = el("header", "workspace-header");
	const brand = el("span", "workspace-brand workspace-brand-accent");
	brand.textContent = "pi Hub";

	const rolesBtn = el("button", "secondary-btn");
	rolesBtn.type = "button";
	rolesBtn.textContent = "Roles";
	rolesBtn.onclick = () => showRoleLibraryModal();

	const officeBtn = el("button", "secondary-btn");
	officeBtn.type = "button";
	officeBtn.textContent = "Office";
	officeBtn.title = "Office — view this room's role roster";
	officeBtn.onclick = () => {
		if (!selectedRoomId) return;
		void showOfficeModal(client, selectedRoomId, (targetRoomId) => {
			void selectRoom(targetRoomId);
		});
	};

	// Header keeps brand + Roles + Office only. Sign-out moves into the
	// sidebar account row at the bottom.
	topHeader.append(brand, rolesBtn, officeBtn);
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
	const newRoomIdInput = el("input") as HTMLInputElement;
	newRoomIdInput.placeholder = "new-room-id";
	const browseWsBtn = el("button", "secondary-btn");
	browseWsBtn.type = "button";
	browseWsBtn.textContent = "Browse…";
	const createBtn = el("button", "secondary-btn");
	createBtn.type = "button";
	createBtn.textContent = "Create";
	roomToolbar.append(newRoomIdInput, browseWsBtn, createBtn);

	const railErr = el("div", "error-banner hidden");
	const roomList = el("ul", "room-list");

	const wsPathRow = el("div", "ws-path-row hidden");
	const wsPathLabel = el("span", "ws-path-label");
	wsPathLabel.textContent = "Workspace: ";
	const wsPathValue = el("span", "ws-path-value");
	const wsClearBtn = el("button", "ws-path-clear");
	wsClearBtn.type = "button";
	wsClearBtn.textContent = "×";
	wsPathRow.append(wsPathLabel, wsPathValue, wsClearBtn);

	let selectedWorkspace = "";

	wsClearBtn.onclick = () => {
		selectedWorkspace = "";
		wsPathRow.classList.add("hidden");
	};

	roomRail.append(railHeader, roomToolbar, wsPathRow, railErr, roomList);

	// Account row pinned to the bottom of the sidebar
	const accountRow = el("div", "room-rail-account");
	const accountAvatar = el("span", "room-rail-account-avatar");
	accountAvatar.textContent = (session.displayName || "?").slice(0, 1).toUpperCase();
	const accountName = el("span", "room-rail-account-name");
	accountName.textContent = session.displayName;
	const accountSignOut = el("button", "room-rail-account-signout");
	accountSignOut.type = "button";
	accountSignOut.textContent = "Sign out";
	accountSignOut.onclick = () => onSignOut();
	accountRow.append(accountAvatar, accountName, accountSignOut);
	roomRail.appendChild(accountRow);

	// Reset all open swipes when clicking/tapping the rail background
	roomRail.addEventListener("click", (ev) => {
		const target = ev.target as HTMLElement;
		if (!target.closest(".room-swipe-wrap") && !target.closest(".room-swipe-delete")) {
			for (const wrap of roomList.querySelectorAll(".room-swipe-wrap")) {
				(wrap as HTMLElement).style.transform = "translateX(0)";
				wrap.classList.remove("is-swiped");
				const li = wrap.parentElement;
				if (li) {
					const da = li.querySelector(".room-swipe-delete") as HTMLElement | null;
					if (da) {
						da.style.opacity = "0";
						da.style.pointerEvents = "none";
					}
				}
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
			roomTitleById.set(r.roomId, r.title?.trim() ? r.title : r.roomId);
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
			const deleteAction = el("button", "room-swipe-delete");
			deleteAction.type = "button";
			deleteAction.textContent = "🗑 Delete";

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
						purgeRoomReplies(roomId);
						roomTitleById.delete(roomId);
						await refreshRoomList();
					} catch (e) {
						showRailError(e instanceof Error ? e.message : String(e));
					}
				})();
			};

			// Swipe drag state (shared per-row via closure, but mousemove/up are delegated)
			let startX = 0;
			let currentX = 0;
			let isDragging = false;
			const SWIPE_THRESHOLD = 80;

			function updateSwipe(dx: number): void {
				if (dx <= 0) {
					swipeWrap.style.transform = `translateX(${Math.max(dx, -SWIPE_THRESHOLD)}px)`;
					deleteAction.style.opacity = String(Math.min(1, Math.abs(dx) / SWIPE_THRESHOLD));
					swipeWrap.classList.remove("is-swiped");
				} else {
					swipeWrap.style.transform = "translateX(0)";
					deleteAction.style.opacity = "0";
					swipeWrap.classList.remove("is-swiped");
				}
			}

			function commitSwipe(dx: number): void {
				if (dx < -SWIPE_THRESHOLD / 2) {
					swipeWrap.style.transform = `translateX(-${SWIPE_THRESHOLD}px)`;
					deleteAction.style.opacity = "1";
					deleteAction.style.pointerEvents = "auto";
					swipeWrap.classList.add("is-swiped");
				} else {
					swipeWrap.style.transform = "translateX(0)";
					deleteAction.style.opacity = "0";
					deleteAction.style.pointerEvents = "none";
					swipeWrap.classList.remove("is-swiped");
				}
			}

			// Swipe via pointer events; only capture when actual movement detected.
			let pointerId = -1;

			function onPointerDown(e: PointerEvent): void {
				startX = e.clientX;
				currentX = startX;
				isDragging = false;
				pointerId = e.pointerId;
			}

			function onPointerMove(e: PointerEvent): void {
				if (pointerId < 0) return;
				const dx = e.clientX - startX;
				if (!isDragging) {
					if (Math.abs(dx) < 8) return;
					isDragging = true;
					swipeWrap.setPointerCapture(pointerId);
				}
				currentX = e.clientX;
				updateSwipe(dx);
			}

			function onPointerUp(e: PointerEvent): void {
				if (pointerId < 0) return;
				const wasDragging = isDragging;
				pointerId = -1;
				isDragging = false;
				if (wasDragging) {
					const dx = currentX - startX;
					commitSwipe(dx);
					try {
						swipeWrap.releasePointerCapture(e.pointerId);
					} catch {
						/* ignore */
					}
				}
				startX = 0;
				currentX = 0;
			}

			swipeWrap.addEventListener("pointerdown", onPointerDown);
			swipeWrap.addEventListener("pointermove", onPointerMove);
			swipeWrap.addEventListener("pointerup", onPointerUp);
			swipeWrap.addEventListener("pointercancel", onPointerUp);

			// Click on row still selects the room; close any open swipe first
			row.onclick = () => {
				// Reset any open swipe
				swipeWrap.style.transform = "translateX(0)";
				swipeWrap.classList.remove("is-swiped");
				deleteAction.style.opacity = "0";
				deleteAction.style.pointerEvents = "none";
				closeRoomRail();
				void selectRoom(roomId);
			};

			// Delete action sits behind swipeWrap, revealed when swipeWrap slides left
			li.style.position = "relative";
			li.style.overflow = "hidden";
			deleteAction.style.position = "absolute";
			deleteAction.style.right = "0";
			deleteAction.style.top = "0";
			deleteAction.style.bottom = "0";
			deleteAction.style.pointerEvents = "none";

			swipeWrap.appendChild(row);
			li.append(deleteAction, swipeWrap);

			li.appendChild(buildRoomRepliesEl(roomId));

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
		const id = newRoomIdInput.value.trim();
		if (!id) return;
		void (async () => {
			try {
				const workspace = selectedWorkspace || undefined;
				await client.createRoom(id, undefined, workspace);
				newRoomIdInput.value = "";
				selectedWorkspace = "";
				wsPathRow.classList.add("hidden");
				await refreshRoomList();
				await selectRoom(id);
			} catch (e) {
				showRailError(e instanceof Error ? e.message : String(e));
			}
		})();
	};

	browseWsBtn.onclick = () => {
		showFolderPickerModal(selectedWorkspace || "", (path) => {
			selectedWorkspace = path;
			if (path) {
				wsPathValue.textContent = path;
				wsPathRow.classList.remove("hidden");
			} else {
				wsPathRow.classList.add("hidden");
			}
		});
	};

	function showFolderPickerModal(currentPath: string, onSelect: (path: string) => void): void {
		const backdrop = el("div", "modal-backdrop");
		const modal = el("div", "modal config-modal folder-picker-modal");

		const title = el("h3");
		title.textContent = "Select workspace folder";
		modal.appendChild(title);

		const pathBar = el("div", "folder-picker-path");
		const pathInput = el("input") as HTMLInputElement;
		pathInput.value = currentPath;
		pathInput.placeholder = "Loading…";
		pathBar.appendChild(pathInput);
		modal.appendChild(pathBar);

		const list = el("div", "folder-picker-list");
		modal.appendChild(list);

		function updateSelectLabel(): void {
			const lastSegment = currentPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() || currentPath;
			selectBtn.textContent = `Select "${lastSegment}"`;
		}

		async function loadDir(dirPath: string): Promise<void> {
			list.innerHTML = "<p style='padding:0.5rem;color:var(--muted)'>Loading…</p>";
			pathInput.value = dirPath;
			try {
				const result = await client.listDirectory(dirPath || undefined);
				currentPath = result.path;
				pathInput.value = result.path;
				updateSelectLabel();
				renderEntries(result.path, result.entries);
			} catch (e) {
				list.innerHTML = `<p style='padding:0.5rem;color:var(--error)'>Error: ${e instanceof Error ? e.message : String(e)}</p>`;
			}
		}

		function renderEntries(basePath: string, entries: Array<{ name: string; isDirectory: boolean }>): void {
			list.innerHTML = "";

			// Parent directory entry
			const parentItem = el("button", "folder-picker-item folder-picker-parent");
			parentItem.type = "button";
			const parentLabel = el("span", "folder-picker-item-name");
			parentLabel.textContent = "..";
			parentItem.appendChild(parentLabel);
			parentItem.onclick = () => {
				const parent = resolvePath(basePath, "..");
				void loadDir(parent);
			};
			list.appendChild(parentItem);

			if (entries.length === 0) {
				const empty = el("p", "folder-picker-empty");
				empty.textContent = "No subdirectories found.";
				list.appendChild(empty);
				return;
			}

			for (const entry of entries) {
				const item = el("button", "folder-picker-item");
				item.type = "button";
				const icon = el("span", "folder-picker-item-icon");
				icon.textContent = "📁";
				const name = el("span", "folder-picker-item-name");
				name.textContent = entry.name;
				item.append(icon, name);
				item.onclick = () => {
					void loadDir(resolvePath(basePath, entry.name));
				};
				list.appendChild(item);
			}
		}

		// Helper: resolve a relative segment against a base path (server-side path).
		function resolvePath(base: string, segment: string): string {
			const parts = base.replace(/\\/g, "/").split("/").filter(Boolean);
			if (segment === "..") {
				if (parts.length > 0) parts.pop();
				return `/${parts.join("/")}`;
			}
			parts.push(segment);
			return `/${parts.join("/")}`;
		}

		const actions = el("div", "modal-actions");
		const selectBtn = el("button", "primary-btn");
		selectBtn.textContent = "Select";
		selectBtn.onclick = () => {
			onSelect(currentPath);
			backdrop.remove();
		};
		const cancelBtn = el("button", "secondary-btn");
		cancelBtn.textContent = "Cancel";
		cancelBtn.onclick = () => backdrop.remove();
		actions.append(selectBtn, cancelBtn);
		modal.appendChild(actions);

		backdrop.appendChild(modal);
		document.body.appendChild(backdrop);

		void loadDir(currentPath || ".");
	}

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

	const lifeWrap = el("div", "life-btn-wrap");
	const lifeBtn = el("button", "secondary-btn");
	lifeBtn.type = "button";
	lifeBtn.textContent = "生命";
	const lifePopup = el("div", "life-popup hidden");
	const rebirthItem = el("button", "life-popup-item danger");
	rebirthItem.textContent = "重生";
	rebirthItem.onclick = (e) => {
		e.stopPropagation();
		lifePopup.classList.add("hidden");
		if (!selectedRoomId || !client.isJoined()) return;
		if (!confirm("Clear all messages in this room?")) return;
		void (async () => {
			try {
				const rid = selectedRoomId!;
				await client.clearRoomSession(rid);
				purgeRoomReplies(rid);
				activeReplyId = null;
				currentTurnId = null;
				refreshMessagesPanel();
				updateRoomReplyRows();
			} catch (e) {
				showError(e instanceof Error ? e.message : String(e));
			}
		})();
	};
	let roomBusy = false;
	let rolesBusy = false;
	let isSleeping = false;

	function canSleep(): boolean {
		return !roomBusy && !rolesBusy && !isSleeping;
	}

	function updateSleepButton(): void {
		sleepItem.disabled = !canSleep();
		if (isSleeping) {
			sleepItem.textContent = "Sleeping…";
		} else if (!canSleep()) {
			sleepItem.textContent = "睡觉 (busy)";
		} else {
			sleepItem.textContent = "睡觉";
		}
	}

	const sleepItem = el("button", "life-popup-item");
	sleepItem.textContent = "睡觉";
	sleepItem.disabled = true;
	sleepItem.onclick = (e) => {
		e.stopPropagation();
		lifePopup.classList.add("hidden");
		if (!selectedRoomId || !client.isJoined() || !canSleep()) return;
		if (
			!confirm(
				"Sleep this room?\n\nThis extracts role outputs into long-term memory and then clears the current conversation. The action cannot be undone.",
			)
		)
			return;
		void (async () => {
			try {
				isSleeping = true;
				updateSleepButton();
				await client.sleepRoom(selectedRoomId!);
			} catch (e) {
				showError(e instanceof Error ? e.message : String(e));
			} finally {
				isSleeping = false;
				updateSleepButton();
			}
		})();
	};
	lifePopup.append(rebirthItem, sleepItem);
	lifeBtn.onclick = (e) => {
		e.stopPropagation();
		lifePopup.classList.toggle("hidden");
	};
	document.addEventListener("click", (e) => {
		if (!lifeWrap.contains(e.target as Node)) {
			lifePopup.classList.add("hidden");
		}
	});
	lifeWrap.append(lifeBtn, lifePopup);
	headerBrand.appendChild(lifeWrap);

	const statusWrap = el("div", "status-wrap");
	const statusDot = el("span", "status-dot connecting");
	const status = el("span", "status");
	status.textContent = "Connecting…";
	statusWrap.append(statusDot, status);
	header.append(headerBrand, statusWrap);
	panel.appendChild(header);

	// Room info bar — shows room metadata from joined event
	const roomInfoBar = el("div", "room-info-bar hidden");
	const roomInfoTitle = el("span", "room-info-title");
	const roomInfoBadges = el("span", "room-info-badges");
	const roomInfoModel = el("span", "room-info-badge room-info-model");
	const roomInfoRoles = el("span", "room-info-badge room-info-roles");
	const roomInfoSkills = el("span", "room-info-badge room-info-skills");
	const roomInfoRules = el("span", "room-info-badge room-info-rules");
	roomInfoBadges.append(roomInfoModel, roomInfoRoles, roomInfoSkills, roomInfoRules);
	roomInfoBar.append(roomInfoTitle, roomInfoBadges);
	panel.insertBefore(roomInfoBar, panel.querySelector(".model-bar"));

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

	// Neutral / success banner used for sleep results and similar non-error notices.
	const info = el("div", "info-banner hidden");
	panel.appendChild(info);
	let infoHideTimer: ReturnType<typeof setTimeout> | null = null;

	const messages = el("div", "messages");
	panel.appendChild(messages);

	// Hero panel shown when the conversation is empty.
	const heroEl = el("div", "chat-hero");
	heroEl.innerHTML = "";
	const heroMark = el("div", "chat-hero-mark");
	heroMark.textContent = "π";
	const heroTitle = el("h2", "chat-hero-title");
	heroTitle.textContent = "pi Hub";
	const heroSub = el("p", "chat-hero-sub");
	heroSub.textContent = "交给我来帮你完成 — 输入任务，或从下方选个提示开始。";
	heroEl.append(heroMark, heroTitle, heroSub);

	const heroCards = el("div", "chat-hero-cards");
	const HERO_PROMPTS: Array<{ title: string; body: string; prompt: string }> = [
		{
			title: "介绍这个房间",
			body: "总结当前 room 的角色、技能和最近进展。",
			prompt: "总结当前房间的角色、技能和最近进展。",
		},
		{
			title: "创建任务计划",
			body: "@pm 拆解一个需求，生成可执行的 JSON 计划。",
			prompt: "@pm 请帮我拆解下面这个需求：",
		},
		{
			title: "审查最近变更",
			body: "@reviewer 读最近的代码变更，输出问题清单。",
			prompt: "@reviewer 请读最近的代码变更，输出问题清单。",
		},
		{
			title: "修复 Bug",
			body: "@developer 描述软件问题，让它定位并修复。",
			prompt: "@developer 现象：\n预期：\n复现步骤：",
		},
		{ title: "查看办公室", body: "打开顶部“Office”看看本房间现在有哪些角色在岗。", prompt: "" },
		{ title: "添加新角色", body: "打开顶部“Roles”创建或编辑一个角色。", prompt: "" },
	];
	for (const item of HERO_PROMPTS) {
		const card = el("button", "chat-hero-card") as HTMLButtonElement;
		card.type = "button";
		const t = el("p", "chat-hero-card-title");
		t.textContent = item.title;
		const b = el("p", "chat-hero-card-body");
		b.textContent = item.body;
		const arrow = el("span", "chat-hero-card-arrow");
		arrow.textContent = "→";
		card.append(t, b, arrow);
		card.onclick = () => {
			if (!item.prompt) return;
			const input = panel.querySelector(
				".composer textarea, .composer input, textarea.composer-input, .composer-input",
			) as HTMLTextAreaElement | HTMLInputElement | null;
			if (input) {
				input.value = item.prompt;
				input.focus();
			}
		};
		heroCards.appendChild(card);
	}
	heroEl.appendChild(heroCards);
	messages.appendChild(heroEl);

	function updateHeroVisibility(): void {
		const hasRealMessage = !!messages.querySelector(".msg, .room-status-row, .reply-detail-back-bar");
		heroEl.style.display = hasRealMessage ? "none" : "";
	}
	updateHeroVisibility();

	// Observe message additions/removals to toggle the hero panel automatically.
	new MutationObserver(() => updateHeroVisibility()).observe(messages, { childList: true });

	const roleGapBar = el("div", "role-gap-bar hidden");
	panel.appendChild(roleGapBar);

	const rolePlanPanel = el("div", "role-plan-panel hidden");
	panel.appendChild(rolePlanPanel);

	const roleProgressBar = el("div", "role-progress-bar hidden");
	panel.appendChild(roleProgressBar);

	const activityBar = el("div", "activity-bar hidden");
	panel.appendChild(activityBar);

	// Token stats bar
	const tokenBar = el("div", "token-bar");
	const tokenInput = el("span", "token-stat");
	tokenInput.textContent = "Input: 0";
	const tokenOutput = el("span", "token-stat");
	tokenOutput.textContent = "Output: 0";
	const tokenTotal = el("span", "token-stat");
	tokenTotal.textContent = "Total: 0";
	tokenBar.append(tokenInput, tokenOutput, tokenTotal);
	panel.appendChild(tokenBar);

	/** Calculate token totals from a list of session messages. */
	function updateTokenStats(msgs: unknown[]): void {
		let input = 0;
		let output = 0;
		for (const m of msgs) {
			if (m && typeof m === "object" && (m as Record<string, unknown>).role === "assistant") {
				const usage = (m as Record<string, unknown>).usage as Record<string, number> | undefined;
				if (usage) {
					input += usage.input ?? 0;
					output += usage.output ?? 0;
				}
			}
		}
		const total = input + output;
		tokenInput.textContent = `Input: ${input.toLocaleString()}`;
		tokenOutput.textContent = `Output: ${output.toLocaleString()}`;
		tokenTotal.textContent = `Total: ${total.toLocaleString()}`;
	}

	const queueBar = el("div", "queue-bar");
	queueBar.textContent = "Queue empty";
	panel.appendChild(queueBar);

	// Attachment state
	const attachedFiles: Array<{ name: string; data: string; mimeType: string; isImage: boolean }> = [];

	const composer = el("div", "composer");

	const attachContainer = el("div", "composer-inner");

	const chipsRow = el("div", "composer-chips");

	const mentionMenu = el("div", "mention-menu hidden");

	const inputRow = el("div", "composer-input-row");

	const fileInput = el("input") as HTMLInputElement;
	fileInput.type = "file";
	fileInput.multiple = true;
	fileInput.accept = "image/*,.pdf,.txt,.md,.json,.js,.ts,.py,.html,.css,.csv,.xml,.yaml,.yml,.log,.env";
	fileInput.style.display = "none";

	const attachBtn = el("button", "composer-attach-btn");
	attachBtn.type = "button";
	attachBtn.setAttribute("aria-label", "Attach file");
	attachBtn.textContent = "+";
	attachBtn.onclick = () => fileInput.click();

	const input = el("textarea") as HTMLTextAreaElement;
	input.placeholder = "Message… (@pm, @role, @user)";

	const sendBtn = el("button", "btn-send");
	sendBtn.textContent = "Send";

	inputRow.append(attachBtn, input, sendBtn);
	composer.append(attachContainer);
	attachContainer.append(chipsRow, inputRow, mentionMenu);
	panel.appendChild(composer);
	panel.appendChild(fileInput);

	function renderChips(): void {
		chipsRow.innerHTML = "";
		for (let i = 0; i < attachedFiles.length; i++) {
			const f = attachedFiles[i]!;
			const chip = el("span", "composer-chip");
			const label = el("span", "composer-chip-label");
			label.textContent = f.isImage ? "🖼 " : "📄 ";
			label.append(document.createTextNode(f.name));
			const removeBtn = el("button", "composer-chip-remove");
			removeBtn.type = "button";
			removeBtn.textContent = "×";
			removeBtn.onclick = () => {
				attachedFiles.splice(i, 1);
				renderChips();
			};
			chip.append(label, removeBtn);
			chipsRow.appendChild(chip);
		}
	}

	fileInput.addEventListener("change", () => {
		const files = fileInput.files;
		if (!files) return;
		for (let i = 0; i < files.length; i++) {
			const file = files[i]!;
			const isImage = file.type.startsWith("image/");
			if (isImage) {
				// Read as base64 data URL
				const reader = new FileReader();
				reader.onload = () => {
					const result = reader.result as string;
					// data:image/png;base64,...
					const comma = result.indexOf(",");
					const data = comma >= 0 ? result.slice(comma + 1) : result;
					const mimeType = resolveImageMimeType(file.type, data);
					if (!mimeType) {
						showError(`Unsupported image "${file.name}". Use JPEG, PNG, GIF, or WebP.`);
						return;
					}
					attachedFiles.push({
						name: file.name,
						data,
						mimeType,
						isImage: true,
					});
					renderChips();
				};
				reader.readAsDataURL(file);
			} else {
				// Read as text to embed in message
				const reader = new FileReader();
				reader.onload = () => {
					const text = reader.result as string;
					attachedFiles.push({
						name: file.name,
						data: text,
						mimeType: file.type || "text/plain",
						isImage: false,
					});
					renderChips();
				};
				reader.readAsText(file);
			}
		}
		// Reset so selecting the same file again triggers change
		fileInput.value = "";
	});

	// Paste handler for images (screenshots from clipboard)
	input.addEventListener("paste", (e: ClipboardEvent) => {
		const items = e.clipboardData?.items;
		if (!items) return;
		let hasImage = false;
		for (let i = 0; i < items.length; i++) {
			const item = items[i]!;
			if (item.type.startsWith("image/")) {
				hasImage = true;
				const file = item.getAsFile();
				if (!file) continue;
				// Rename with appropriate extension
				const ext = item.type.split("/")[1] ?? "png";
				const name = `pasted-image-${Date.now()}.${ext}`;
				const reader = new FileReader();
				reader.onload = () => {
					const result = reader.result as string;
					const comma = result.indexOf(",");
					const data = comma >= 0 ? result.slice(comma + 1) : result;
					const mimeType = resolveImageMimeType(item.type, data);
					if (!mimeType) {
						showError("Unsupported pasted image. Use JPEG, PNG, GIF, or WebP.");
						return;
					}
					attachedFiles.push({
						name,
						data,
						mimeType,
						isImage: true,
					});
					renderChips();
				};
				reader.readAsDataURL(file);
			}
		}
		if (hasImage) {
			e.preventDefault();
		}
	});

	// Shared skill picker
	function showSkillPickerModal(onSelect: (names: string[]) => void, current: string[]): void {
		const backdrop = el("div", "modal-backdrop");
		const modal = el("div", "modal config-modal");
		const title = el("h3");
		title.textContent = "Select skills";
		modal.appendChild(title);

		const list = el("div", "skill-picker-list");
		const checked = new Set(current);
		const items: Array<{ name: string; cb: HTMLInputElement }> = [];

		function renderAvailable(): void {
			list.innerHTML = "<p style='padding:0.5rem;color:var(--muted)'>Loading skills...</p>";
			items.length = 0;
			client
				.listSkills(selectedRoomId ?? undefined)
				.then((skills) => {
					list.innerHTML = "";
					if (skills.length === 0) {
						list.textContent = "No skills found in .pi/skills/ or ~/.pi/agent/skills/";
						return;
					}
					for (const s of skills) {
						const label = el("label", "skill-picker-item");
						const cb = el("input") as HTMLInputElement;
						cb.type = "checkbox";
						cb.checked = checked.has(s.name);
						const nameSpan = el("span");
						nameSpan.textContent = s.name;
						const descSpan = el("span", "skill-picker-desc");
						descSpan.textContent = s.description ? ` — ${s.description}` : ` (${s.source})`;
						label.append(cb, nameSpan, descSpan);
						label.addEventListener("change", () => {
							if (cb.checked) checked.add(s.name);
							else checked.delete(s.name);
						});
						list.appendChild(label);
						items.push({ name: s.name, cb });
					}
				})
				.catch((err) => {
					list.innerHTML = `<p style='padding:0.5rem;color:var(--error)'>Error loading skills: ${err instanceof Error ? err.message : String(err)}</p>`;
				});
		}

		modal.appendChild(list);

		const actions = el("div", "modal-actions");
		const confirmBtn = el("button", "primary-btn");
		confirmBtn.textContent = "Confirm";
		confirmBtn.onclick = () => {
			onSelect(Array.from(checked));
			backdrop.remove();
		};
		const cancelBtn = el("button", "secondary-btn");
		cancelBtn.textContent = "Cancel";
		cancelBtn.onclick = () => backdrop.remove();
		actions.append(confirmBtn, cancelBtn);
		modal.appendChild(actions);

		backdrop.appendChild(modal);
		document.body.appendChild(backdrop);
		renderAvailable();
	}

	function renderSkillChips(container: HTMLElement, names: string[], onRemove: (name: string) => void): void {
		container.innerHTML = "";
		for (const name of names) {
			const chip = el("span", "skill-chip");
			chip.textContent = name;
			const removeBtn = el("button", "skill-chip-remove");
			removeBtn.textContent = "×";
			removeBtn.onclick = () => onRemove(name);
			chip.appendChild(removeBtn);
			container.appendChild(chip);
		}
	}

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

		// Skills section: chips + browse button
		const skillsLabel = el("label", "config-field");
		skillsLabel.textContent = "Skills";
		const skillsChips = el("div", "skill-chips");
		const skillsBrowseRow = el("div", "sidebar-row");
		const browseSkillsBtn = el("button", "secondary-btn");
		browseSkillsBtn.type = "button";
		browseSkillsBtn.textContent = "Browse";
		skillsBrowseRow.appendChild(browseSkillsBtn);
		let selectedSkills: string[] = [];

		function renderRoomSkillChips(): void {
			renderSkillChips(skillsChips, selectedSkills, (name) => {
				selectedSkills = selectedSkills.filter((s) => s !== name);
				renderRoomSkillChips();
			});
		}

		function loadRoomSkills(): void {
			void (async () => {
				const config = await client.getRoomConfig(selectedRoomId!);
				selectedSkills = config.skills ?? [];
				renderRoomSkillChips();
				wsInput.value = config.workspace ?? "";
			})();
		}

		browseSkillsBtn.onclick = () => {
			showSkillPickerModal((names) => {
				selectedSkills = names;
				renderRoomSkillChips();
			}, selectedSkills);
		};

		loadRoomSkills();
		skillsLabel.append(skillsChips, skillsBrowseRow);
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

		// Workspace (read-only)
		const wsLabel = el("label", "config-field");
		wsLabel.textContent = "Workspace";
		const wsInput = el("input") as HTMLInputElement;
		wsInput.readOnly = true;
		wsInput.placeholder = "(default — same as hub cwd)";
		wsLabel.appendChild(wsInput);
		cfgSection.appendChild(wsLabel);

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
					// Fetch current config to preserve roleNames (added/removed via add_room_role)
					const currentConfig = await client.getRoomConfig(selectedRoomId!);
					await client.setRoomConfig(selectedRoomId!, {
						roleNames: currentConfig.roleNames,
						skills: selectedSkills.length > 0 ? selectedSkills : undefined,
						rules: rulesClone.value.trim() || undefined,
						rolesEnabled: rolesCb.checked ? true : undefined,
					});
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

		// Tab bar
		const tabBar = el("div", "role-lib-tabs");
		const editorTab = el("button", "role-lib-tab active");
		editorTab.textContent = "Editor";
		editorTab.type = "button";
		const memoryTab = el("button", "role-lib-tab");
		memoryTab.textContent = "Memory";
		memoryTab.type = "button";
		tabBar.append(editorTab, memoryTab);
		modal.appendChild(tabBar);

		// Editor panel wrapper
		const editorPanel = el("div", "role-lib-panel");

		// Select existing role + New button
		const nameRow = el("div", "sidebar-row");
		const select = el("select") as HTMLSelectElement;
		const newBtn = el("button", "secondary-btn");
		newBtn.type = "button";
		newBtn.textContent = "New";
		nameRow.append(select, newBtn);
		editorPanel.appendChild(nameRow);

		// New role name input (shown when New is clicked)
		const newNameInput = el("input") as HTMLInputElement;
		newNameInput.placeholder = "role-name (press Enter to create)";
		newNameInput.style.display = "none";
		const newNameRow = el("div", "sidebar-row");
		newNameRow.appendChild(newNameInput);
		editorPanel.appendChild(newNameRow);

		const meta = el("div", "role-meta");
		editorPanel.appendChild(meta);

		const editor = el("textarea", "role-editor") as HTMLTextAreaElement;
		editor.rows = 12;
		editor.spellcheck = false;
		editorPanel.appendChild(editor);

		// Skills section in role editor
		const roleSkillsLabel = el("label", "config-field");
		roleSkillsLabel.textContent = "Skills";
		const roleSkillsChips = el("div", "skill-chips");
		const roleSkillsBtn = el("button", "secondary-btn");
		roleSkillsBtn.type = "button";
		roleSkillsBtn.textContent = "Browse skills";
		let roleSelectedSkills: string[] = [];

		function renderRoleSkillChips(): void {
			renderSkillChips(roleSkillsChips, roleSelectedSkills, (name) => {
				roleSelectedSkills = roleSelectedSkills.filter((s) => s !== name);
				updateRoleSkillsYaml();
			});
		}

		function reloadRoleSkills(): void {
			const match = editor.value.match(/^skills:\s*(.+)$/m);
			if (match) {
				roleSelectedSkills = match[1]!
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
			} else {
				roleSelectedSkills = [];
			}
			renderRoleSkillChips();
		}

		function updateRoleSkillsYaml(): void {
			const yaml = roleSelectedSkills.length > 0 ? `skills: ${roleSelectedSkills.join(", ")}` : "skills: ";
			if (/^skills:/m.test(editor.value)) {
				editor.value = editor.value.replace(/^skills:.*$/m, yaml);
			} else {
				editor.value = editor.value.replace(/^---\n/, `---\n${yaml}\n`);
			}
			renderRoleSkillChips();
		}

		roleSkillsBtn.onclick = () => {
			showSkillPickerModal((names) => {
				roleSelectedSkills = names;
				updateRoleSkillsYaml();
			}, roleSelectedSkills);
		};

		roleSkillsLabel.append(roleSkillsChips, roleSkillsBtn);
		editorPanel.appendChild(roleSkillsLabel);
		modal.appendChild(editorPanel);

		// Memory panel
		const memoryPanel = el("div", "role-lib-panel hidden");
		const memoryLoading = el("p", "role-memory-loading");
		memoryLoading.textContent = "Select a role to view memories.";
		memoryPanel.appendChild(memoryLoading);
		const memoryList = el("div", "role-memory-list");
		memoryPanel.appendChild(memoryList);
		modal.appendChild(memoryPanel);

		async function loadMemories(roleName: string): Promise<void> {
			memoryList.innerHTML = "";
			memoryLoading.textContent = "Loading memories…";
			memoryLoading.style.display = "";
			try {
				const memories = await client.getRoleMemory(roleName);
				renderMemories(memories);
			} catch (e) {
				memoryLoading.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
			}
		}

		function renderMemories(memories: HubRoleMemory[]): void {
			memoryList.innerHTML = "";
			if (memories.length === 0) {
				memoryLoading.textContent = "No memories stored for this role.";
				memoryLoading.style.display = "";
				return;
			}
			memoryLoading.style.display = "none";

			// Clear all button
			const clearAllRow = el("div", "memory-clear-row");
			const clearAllBtn = el("button", "secondary-btn danger-btn");
			clearAllBtn.type = "button";
			clearAllBtn.textContent = `Clear all (${memories.length})`;
			clearAllRow.appendChild(clearAllBtn);
			memoryList.appendChild(clearAllRow);

			for (const mem of memories) {
				const card = el("div", "memory-card");
				const header = el("div", "memory-card-header");
				const ts = el("span", "memory-card-ts");
				ts.textContent = formatRelativeTime(mem.ts);
				const roomTag = el("span", "memory-card-room");
				roomTag.textContent = mem.room;
				const delBtn = el("button", "memory-card-delete");
				delBtn.type = "button";
				delBtn.textContent = "×";
				delBtn.onclick = () => {
					void (async () => {
						try {
							await client.deleteRoleMemory(select.value, mem.seq);
							await loadMemories(select.value);
						} catch (e) {
							showError(e instanceof Error ? e.message : String(e));
						}
					})();
				};
				header.append(ts, roomTag, delBtn);
				const goalP = el("p", "memory-card-goal");
				goalP.textContent = `Goal: ${mem.goal}`;
				const resultP = el("p", "memory-card-result");
				resultP.textContent = `Result: ${mem.result}`;
				card.append(header, goalP, resultP);
				memoryList.appendChild(card);
			}

			clearAllBtn.onclick = () => {
				if (!confirm(`Delete all ${memories.length} memories for "${select.value}"?`)) return;
				void (async () => {
					try {
						await client.clearRoleMemory(select.value);
						await loadMemories(select.value);
					} catch (e) {
						showError(e instanceof Error ? e.message : String(e));
					}
				})();
			};
		}

		// Tab switching
		editorTab.onclick = () => {
			editorTab.classList.add("active");
			memoryTab.classList.remove("active");
			editorPanel.classList.remove("hidden");
			memoryPanel.classList.add("hidden");
			newNameInput.style.display = "none";
		};
		memoryTab.onclick = () => {
			memoryTab.classList.add("active");
			editorTab.classList.remove("active");
			editorPanel.classList.add("hidden");
			memoryPanel.classList.remove("hidden");
			const name = select.value;
			if (name) void loadMemories(name);
		};

		async function loadRole(name: string): Promise<void> {
			const role = await client.getRole(name);
			editor.value = role.content;
			meta.textContent = `${role.source} · ${role.filePath}`;
			reloadRoleSkills();
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

		newBtn.onclick = () => {
			newNameInput.style.display = "";
			newNameInput.value = "";
			newNameInput.focus();
			editor.value = `---\nname: \ndescription: \nwho: \ncan: \nwhen: \nmodel: \ntools: \n---\n\n`;
			meta.textContent = "Enter a name above and press Enter to create the role.";
			select.value = "";
			reloadRoleSkills();
		};

		newNameInput.addEventListener("keydown", (e) => {
			if (e.key !== "Enter") return;
			e.preventDefault();
			const name = newNameInput.value.trim();
			if (!name) return;
			void (async () => {
				try {
					await client.saveRole(name, editor.value);
					await refreshSelect();
					select.value = name;
					await loadRole(name);
					newNameInput.style.display = "none";
					newNameInput.value = "";
				} catch (e) {
					showError(e instanceof Error ? e.message : String(e));
				}
			})();
		});

		select.addEventListener("change", () => {
			newNameInput.style.display = "none";
			void loadRole(select.value).catch((e) => showError(e instanceof Error ? e.message : String(e)));
		});

		const actions = el("div", "modal-actions");

		const saveBtn = el("button", "primary-btn");
		saveBtn.textContent = "Save";
		saveBtn.onclick = () => {
			const name = select.value;
			if (!name) return;
			void (async () => {
				try {
					await client.saveRole(name, editor.value);
					await refreshSelect();
				} catch (e) {
					showError(e instanceof Error ? e.message : String(e));
				}
			})();
		};

		const deleteBtn = el("button", "secondary-btn danger-btn");
		deleteBtn.textContent = "Delete";
		deleteBtn.onclick = () => {
			const name = select.value;
			if (!name) return;
			if (!confirm(`Delete role "${name}"?`)) return;
			void (async () => {
				try {
					await client.deleteRole(name);
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
	let streamingAssistantHost: string | null = null;
	let toolMsgMap = new Map<
		string,
		{ div: HTMLElement; detailWrap: HTMLElement; argsPre: HTMLElement; toolName: string; args: unknown }
	>();
	let lastMetaHost: string | null = null;
	let turnHostName: string | null = null;
	let clientId = "";
	let presenceCount = 0;
	let presenceMembers: Array<{ displayName: string }> = [];
	let roomAssignedRoles: string[] = [];
	const replyStore = new Map<string, ReplyEntry>();
	const roomReplies = new Map<string, string[]>();
	const roomTitleById = new Map<string, string>();
	let activeReplyId: string | null = null;
	let currentTurnId: string | null = null;

	function getRoomDisplayLabel(roomId: string): string {
		return roomTitleById.get(roomId) ?? roomId;
	}

	function appendReplyId(roomId: string, replyId: string): void {
		const list = roomReplies.get(roomId) ?? [];
		if (!list.includes(replyId)) {
			list.push(replyId);
			roomReplies.set(roomId, list);
		}
	}

	function purgeRoomReplies(roomId: string): void {
		const ids = roomReplies.get(roomId) ?? [];
		for (const id of ids) {
			replyStore.delete(id);
		}
		roomReplies.delete(roomId);
		const active = activeReplyId ? replyStore.get(activeReplyId) : undefined;
		if (active?.roomId === roomId) {
			activeReplyId = null;
		}
	}

	function rolesBusyForRoom(roomId: string): boolean {
		const ids = roomReplies.get(roomId) ?? [];
		for (const id of ids) {
			const entry = replyStore.get(id);
			if (entry?.kind === "role" && entry.phase === "running") {
				return true;
			}
		}
		return false;
	}

	function syncRolesBusy(): void {
		rolesBusy = selectedRoomId ? rolesBusyForRoom(selectedRoomId) : false;
		updateSleepButton();
	}

	function currentSessionReply(): ReplyEntry | undefined {
		if (!selectedRoomId || !currentTurnId) return undefined;
		return replyStore.get(sessionReplyId(selectedRoomId, currentTurnId));
	}

	function selectReply(replyId: string): void {
		const reply = replyStore.get(replyId);
		if (!reply) return;
		activeReplyId = replyId;
		const showDetail = (): void => {
			refreshMessagesPanel();
			updateRoomReplyRows();
		};
		if (selectedRoomId !== reply.roomId) {
			void selectRoom(reply.roomId).then(showDetail);
		} else {
			showDetail();
		}
	}

	function renderReplyDetail(replyId: string): void {
		const reply = replyStore.get(replyId);
		if (!reply) return;
		messages.style.overflow = "hidden";
		messages.innerHTML = "";
		streamingAssistantEl = null;
		streamingAssistantHost = null;
		lastMetaHost = null;
		toolMsgMap = new Map();

		const backBar = el("button", "reply-detail-back-bar");
		backBar.type = "button";
		backBar.textContent = "← 返回房间状态";
		backBar.onclick = () => {
			activeReplyId = null;
			refreshMessagesPanel();
			updateRoomReplyRows();
		};
		messages.appendChild(backBar);

		for (const msg of reply.messages) {
			const m = msg as {
				role?: string;
				customType?: string;
				content?: unknown;
				display?: boolean;
				summary?: string;
				tokensBefore?: number;
				toolName?: string;
				isError?: boolean;
			};
			// Skip internal/system messages marked as non-displayable
			if (m.display === false) continue;
			if (m.role === "compactionSummary") {
				const banner = el("div", "msg compaction-banner");
				const meta = el("div", "meta");
				const tokens = typeof m.tokensBefore === "number" ? ` · ${m.tokensBefore} tokens before` : "";
				meta.textContent = `上下文已压缩${tokens}`;
				banner.appendChild(meta);
				if (m.summary) {
					const body = el("div", "msg-body");
					body.textContent = m.summary;
					banner.appendChild(body);
				}
				messages.appendChild(banner);
			} else if (m.role === "user") {
				appendMessage("user", getMessageText(msg), undefined, false);
			} else if (m.role === "assistant") {
				const assistant = formatAssistantDisplay(getAssistantMessageMeta(msg));
				if (!assistant.suppressBubble) {
					appendCollapsibleAssistantMsg(assistant.displayText, false, undefined, false, assistant.isFailed);
				}
				// Render embedded toolCall items so historical tool invocations are
				// visible inline (live flow uses tool_execution_start events; on
				// cold join those events do not replay, so we walk the assistant
				// message content array instead).
				if (Array.isArray(m.content)) {
					for (const part of m.content as Array<{ type?: string; name?: string; arguments?: unknown }>) {
						if (part.type !== "toolCall") continue;
						const toolDiv = el("div", "msg tool tool-collapsible");
						const headerLine = el("div", "tool-header");
						const indicator = el("span", "tool-toggle");
						indicator.textContent = "▶";
						const nameSpan = el("span", "tool-name");
						nameSpan.textContent = part.name ?? "tool";
						headerLine.append(indicator, nameSpan);
						toolDiv.appendChild(headerLine);
						const detailWrap = el("div", "tool-detail hidden");
						const argsPre = el("pre", "tool-code");
						argsPre.textContent =
							part.arguments !== undefined ? JSON.stringify(part.arguments, null, 2) : "(no arguments)";
						detailWrap.appendChild(argsPre);
						toolDiv.appendChild(detailWrap);
						let expanded = false;
						toolDiv.addEventListener("click", () => {
							expanded = !expanded;
							detailWrap.classList.toggle("hidden", !expanded);
							indicator.textContent = expanded ? "▼" : "▶";
						});
						messages.appendChild(toolDiv);
					}
				}
			} else if (m.role === "toolResult") {
				const toolDiv = el("div", `msg tool tool-collapsible${m.isError ? " tool-error" : ""}`);
				const headerLine = el("div", "tool-header");
				const indicator = el("span", "tool-toggle");
				indicator.textContent = "▶";
				const nameSpan = el("span", "tool-name");
				nameSpan.textContent = `${m.toolName ?? "tool"} → ${m.isError ? "error" : "result"}`;
				headerLine.append(indicator, nameSpan);
				toolDiv.appendChild(headerLine);
				const detailWrap = el("div", "tool-detail hidden");
				const pre = el("pre", "tool-code");
				pre.textContent = getMessageText(msg) || "(empty result)";
				detailWrap.appendChild(pre);
				toolDiv.appendChild(detailWrap);
				let expanded = false;
				toolDiv.addEventListener("click", () => {
					expanded = !expanded;
					detailWrap.classList.toggle("hidden", !expanded);
					indicator.textContent = expanded ? "▼" : "▶";
				});
				messages.appendChild(toolDiv);
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
		messages.scrollTop = 0;
		requestAnimationFrame(() => {
			messages.style.overflow = "";
		});
	}

	function updateStatusRowElement(entry: ReplyEntry): void {
		const row = messages.querySelector(`[data-status-reply-id="${entry.id}"]`);
		if (!row) return;
		const textEl = row.querySelector(".room-status-text");
		if (textEl) {
			textEl.textContent = formatStatusLine(entry, session.displayName);
		}
		row.classList.remove("running", "done", "failed");
		row.classList.add(entry.phase);
	}

	function renderRoomStatusBoard(): void {
		if (!selectedRoomId) return;
		messages.style.overflow = "hidden";
		messages.innerHTML = "";
		streamingAssistantEl = null;
		streamingAssistantHost = null;
		lastMetaHost = null;
		toolMsgMap = new Map();

		// Walk reply entries in chronological order (by startedAt). For each
		// `kind: "session"` entry that carries the original user prompt, render
		// the user bubble immediately above its status row so a turn's question
		// and the resulting status sit next to each other instead of being split
		// into a top "all user bubbles" block and a bottom "all status rows"
		// block.
		const rids = roomReplies.get(selectedRoomId) ?? [];
		const entries = rids
			.map((rid) => replyStore.get(rid))
			.filter((e): e is ReplyEntry => !!e)
			.slice()
			.sort((a, b) => a.startedAt - b.startedAt);

		for (const entry of entries) {
			if (entry.kind === "session" && entry.userText) {
				appendMessage("user", entry.userText, entry.userMeta ?? session.displayName, false);
			}
			const row = el("button", `room-status-row ${entry.phase}`);
			row.type = "button";
			row.setAttribute("data-status-reply-id", entry.id);
			const textEl = el("span", "room-status-text");
			textEl.textContent = formatStatusLine(entry, session.displayName);
			row.appendChild(textEl);
			row.onclick = () => selectReply(entry.id);
			messages.appendChild(row);
		}

		messages.scrollTop = messages.scrollHeight;
		requestAnimationFrame(() => {
			messages.style.overflow = "";
		});
	}

	function refreshMessagesPanel(): void {
		if (activeReplyId) {
			renderReplyDetail(activeReplyId);
		} else {
			renderRoomStatusBoard();
		}
	}

	function attachReplySwipeCancel(wrap: HTMLElement, entry: ReplyEntry): void {
		const cancelBtn = el("button", "reply-swipe-cancel");
		cancelBtn.type = "button";
		cancelBtn.textContent = "Cancel";
		cancelBtn.style.cssText =
			"position:absolute;right:0;top:0;bottom:0;width:64px;display:flex;align-items:center;justify-content:center;background:var(--error);color:#fff;border:none;border-radius:0 var(--radius-sm) var(--radius-sm) 0;font-size:0.65rem;font-weight:500;cursor:pointer;opacity:0;pointer-events:none;transition:opacity var(--duration-fast) ease;z-index:1";

		cancelBtn.onclick = (e) => {
			e.stopPropagation();
			if (!client.isJoined()) return;
			if (entry.kind === "session") {
				client.abort();
				roomBusy = false;
				updateSleepButton();
			} else if (entry.kind === "role") {
				const taskId = entry.id.startsWith("role:") ? entry.id.slice("role:".length) : "";
				if (taskId) client.abortTask(taskId);
			}
			wrap.style.transform = "translateX(0)";
			cancelBtn.style.opacity = "0";
			cancelBtn.style.pointerEvents = "none";
		};

		let sStartX = 0;
		let sCurrentX = 0;
		let sPointerId = -1;
		let sDragging = false;
		const S_THRESH = 64;

		wrap.addEventListener("pointerdown", (ev) => {
			sStartX = ev.clientX;
			sCurrentX = sStartX;
			sDragging = false;
			sPointerId = ev.pointerId;
		});
		wrap.addEventListener("pointermove", (ev) => {
			if (sPointerId < 0) return;
			const dx = ev.clientX - sStartX;
			if (!sDragging && Math.abs(dx) < 8) return;
			if (!sDragging) {
				sDragging = true;
				wrap.setPointerCapture(sPointerId);
			}
			sCurrentX = ev.clientX;
			if (dx <= 0) {
				wrap.style.transform = `translateX(${Math.max(dx, -S_THRESH)}px)`;
				cancelBtn.style.opacity = String(Math.min(1, Math.abs(dx) / S_THRESH));
			} else {
				wrap.style.transform = "translateX(0)";
				cancelBtn.style.opacity = "0";
			}
		});
		wrap.addEventListener("pointerup", (ev) => {
			if (sPointerId < 0) return;
			sPointerId = -1;
			if (sDragging) {
				const dx = sCurrentX - sStartX;
				if (dx < -S_THRESH / 2) {
					wrap.style.transform = `translateX(-${S_THRESH}px)`;
					cancelBtn.style.opacity = "1";
					cancelBtn.style.pointerEvents = "auto";
				} else {
					wrap.style.transform = "translateX(0)";
					cancelBtn.style.opacity = "0";
					cancelBtn.style.pointerEvents = "none";
				}
				try {
					wrap.releasePointerCapture(ev.pointerId);
				} catch {
					/* ignore */
				}
			}
			sStartX = 0;
			sCurrentX = 0;
		});
		wrap.addEventListener("pointercancel", () => {
			sPointerId = -1;
			sDragging = false;
		});

		wrap.appendChild(cancelBtn);
	}

	function buildRoomRepliesEl(roomId: string): HTMLElement {
		const container = el("div", "room-replies");
		const rids = roomReplies.get(roomId) ?? [];
		for (const rid of rids) {
			const entry = replyStore.get(rid);
			if (!entry) continue;
			const wrap = el("div", "reply-swipe-wrap");
			const replyRow = el("button", "room-reply-row");
			replyRow.type = "button";
			replyRow.setAttribute("data-reply-id", rid);
			if (rid === activeReplyId) replyRow.classList.add("active");
			const dot = el("span", `role-sub-dot ${entry.phase}`);
			const label = el("span", "room-reply-label");
			label.textContent = entry.label;
			replyRow.append(dot, label);
			replyRow.onclick = (ev) => {
				ev.stopPropagation();
				selectReply(rid);
			};
			wrap.appendChild(replyRow);
			if (entry.phase === "running") {
				attachReplySwipeCancel(wrap, entry);
			}
			container.appendChild(wrap);
		}
		return container;
	}

	function updateRoomReplyRows(): void {
		for (const li of roomList.querySelectorAll("li")) {
			const row = li.querySelector(".room-row");
			if (!row) continue;
			const roomId = row.getAttribute("data-room-id");
			if (!roomId) continue;
			const existing = li.querySelector(".room-replies");
			if (existing) existing.remove();
			li.appendChild(buildRoomRepliesEl(roomId));
		}
	}

	function upsertSessionReplyPartialText(entry: ReplyEntry, text: string): void {
		const trimmed = text.trim();
		if (trimmed) {
			entry.summary = truncateSummary(trimmed);
		}
		const idx = entry.messages.findIndex((m) => (m as { role?: string }).role === "assistant");
		const msg = { role: "assistant", content: text };
		if (idx >= 0) {
			entry.messages[idx] = msg;
		} else {
			entry.messages.push(msg);
		}
	}

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

	function updateRoomInfo(msg: { [key: string]: unknown }): void {
		const roomTitle = typeof msg.roomTitle === "string" ? msg.roomTitle : undefined;
		const roomModel = typeof msg.roomModel === "string" ? msg.roomModel : undefined;
		const roomRoles = Array.isArray(msg.roomRoles) ? (msg.roomRoles as HubRoleSummaryEntry[]) : [];
		const roomSkills = Array.isArray(msg.roomSkills) ? (msg.roomSkills as HubSkillSummaryEntry[]) : [];
		const roomRules = typeof msg.roomRules === "string" && msg.roomRules.trim() ? msg.roomRules : undefined;

		const hasInfo = roomTitle || roomModel || roomRoles.length > 0 || roomSkills.length > 0 || roomRules;
		if (!hasInfo) {
			roomInfoBar.classList.add("hidden");
			return;
		}

		roomInfoBar.classList.remove("hidden");
		roomInfoTitle.textContent = roomTitle && roomTitle !== selectedRoomId ? roomTitle : "";

		// Model badge
		if (roomModel) {
			roomInfoModel.textContent = roomModel;
			roomInfoModel.classList.remove("hidden");
		} else {
			roomInfoModel.classList.add("hidden");
		}

		// Roles badge
		if (roomRoles.length > 0) {
			roomInfoRoles.textContent = `${roomRoles.length} role${roomRoles.length !== 1 ? "s" : ""}`;
			roomInfoRoles.title = roomRoles.map((r) => `${r.name}: ${r.description}`).join("\n");
			roomInfoRoles.classList.remove("hidden");
		} else {
			roomInfoRoles.classList.add("hidden");
		}

		// Skills badge
		if (roomSkills.length > 0) {
			roomInfoSkills.textContent = `${roomSkills.length} skill${roomSkills.length !== 1 ? "s" : ""}`;
			roomInfoSkills.title = roomSkills
				.map((s) => `${s.name}${s.description ? `: ${s.description}` : ""}`)
				.join("\n");
			roomInfoSkills.classList.remove("hidden");
		} else {
			roomInfoSkills.classList.add("hidden");
		}

		// Rules badge
		if (roomRules) {
			roomInfoRules.textContent = "Rules";
			roomInfoRules.title = roomRules;
			roomInfoRules.classList.remove("hidden");
		} else {
			roomInfoRules.classList.add("hidden");
		}
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

	function showInfo(message: string, durationMs = 5000): void {
		info.textContent = message;
		info.classList.remove("hidden");
		if (infoHideTimer) clearTimeout(infoHideTimer);
		if (durationMs > 0) {
			infoHideTimer = setTimeout(() => {
				info.classList.add("hidden");
				infoHideTimer = null;
			}, durationMs);
		}
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
			case "sleeping":
				return msg.detail ? `Sleeping: ${msg.detail}` : "Sleeping…";
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
		} else {
			activityBar.textContent = label;
			activityBar.classList.remove("hidden");
		}
		const sessionEntry = currentSessionReply();
		if (sessionEntry && msg.phase !== "idle") {
			const detail = activityPhaseToDetail(msg.phase, msg.detail);
			if (detail) {
				sessionEntry.detail = detail;
				if (activeReplyId === null) {
					updateStatusRowElement(sessionEntry);
				}
			}
		}
	}

	function appendMessage(role: string, text: string, meta?: string, animate = true): HTMLElement {
		const div = el("div", `msg ${role}${animate ? " msg-animate-in" : ""}`);
		const label = meta ?? (role === "assistant" ? assistantMetaLabel() : undefined);
		// Only show meta label when the responder changes since last assistant message
		let showMeta = false;
		if (label) {
			if (label !== lastMetaHost) {
				showMeta = true;
				lastMetaHost = label;
			}
		}
		if (showMeta) {
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
		scrollMessagesToBottom();
		return div;
	}

	function appendCollapsibleAssistantMsg(
		text: string,
		isStreaming: boolean,
		meta?: string,
		animate = true,
		isFailed = false,
	): HTMLElement {
		const div = el("div", `msg assistant${isFailed ? " msg-failed" : ""}${animate ? " msg-animate-in" : ""}`);
		const header = el("div", "msg-collapse-header");
		const toggle = el("span", "msg-collapse-toggle");
		toggle.textContent = "\u25b6";
		const avatar = el("span", "msg-avatar");
		avatar.textContent = ASSISTANT_AVATAR;
		avatar.setAttribute("aria-hidden", "true");
		const label = el("span", "msg-collapse-label");
		label.textContent = isStreaming ? "Replying\u2026" : "Response";
		header.append(toggle, avatar, label);
		if (meta) {
			const metaDiv = el("div", "meta");
			metaDiv.textContent = meta;
			header.appendChild(metaDiv);
		}
		const body = el("div", "msg-collapse-body hidden");
		body.textContent = text;
		const conclusion = el("div", "msg-collapse-conclusion");
		let expanded = false;
		header.addEventListener("click", () => {
			expanded = !expanded;
			body.classList.toggle("hidden", !expanded);
			toggle.textContent = expanded ? "\u25bc" : "\u25b6";
		});
		div.append(header, body, conclusion);
		messages.appendChild(div);
		if (!isStreaming) {
			finalizeCollapsibleAssistantMsg(div);
		}
		scrollMessagesToBottom();
		return div;
	}

	function finalizeCollapsibleAssistantMsg(el: HTMLElement): void {
		const body = el.querySelector(".msg-collapse-body") as HTMLElement | null;
		const header = el.querySelector(".msg-collapse-header") as HTMLElement | null;
		const conclusion = el.querySelector(".msg-collapse-conclusion") as HTMLElement | null;
		const label = el.querySelector(".msg-collapse-label") as HTMLElement | null;
		if (!body || !conclusion) return;

		const fullText = body.textContent ?? "";
		const trimmed = fullText.trim();
		// Empty or dot-only reply (e.g. just "..." or "…"): show an explicit notice
		// so the user understands the model returned no usable content.
		if (!trimmed || /^[.\u2026\s]+$/.test(trimmed)) {
			if (header) header.style.display = "none";
			body.classList.add("hidden");
			el.classList.add("msg-empty");
			conclusion.innerHTML = "";
			const icon = document.createElement("span");
			icon.className = "msg-empty-icon";
			icon.textContent = "⚠";
			const note = document.createElement("span");
			note.textContent = "助手未返回正文内容（模型仅输出了省略号 / 空响应）。如需重试，可重发上一条消息或切换模型。";
			conclusion.append(icon, note);
			return;
		}

		const lastBreak = fullText.lastIndexOf("\n\n");

		if (lastBreak <= 0) {
			// Single paragraph: hide collapsible, show text in conclusion
			if (header) header.style.display = "none";
			body.classList.add("hidden");
			conclusion.textContent = fullText;
			if (el.classList.contains("msg-failed")) {
				conclusion.classList.add("msg-failed-text");
			}
			return;
		}

		const beforeConclusion = fullText.slice(0, lastBreak);
		const conclusionText = fullText.slice(lastBreak + 2);

		body.textContent = beforeConclusion;
		conclusion.textContent = conclusionText;
		if (label) {
			label.textContent = "Response";
		}
	}

	function updateStreamingAssistant(message: unknown, host?: string | null): void {
		if (!streamingAssistantEl) {
			return;
		}
		const assistant = formatAssistantDisplay(getAssistantMessageMeta(message));
		const body = streamingAssistantEl.querySelector(".msg-collapse-body") as HTMLElement | null;
		if (body) {
			body.textContent = assistant.displayText;
		}
		streamingAssistantEl.classList.toggle("msg-failed", assistant.isFailed);
		if (host) {
			const meta = streamingAssistantEl.querySelector(".meta");
			const label = assistantMetaLabel(host);
			if (meta && label) {
				meta.textContent = label;
			} else if (label) {
				const m = el("div", "meta");
				m.textContent = label;
				const header = streamingAssistantEl.querySelector(".msg-collapse-header");
				if (header) header.appendChild(m);
			}
		}
		scrollMessagesToBottom();
	}

	function updateQueue(msg: HubServerMessage): void {
		if (msg.type !== "queue_update") return;
		const pending = (msg.pending as unknown[]) ?? [];
		const current = msg.current as { displayName?: string } | null;
		if (current?.displayName) {
			turnHostName = current.displayName;
		}
		roomBusy = current !== null || pending.length > 0;
		updateSleepButton();
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
		const roleName = String(msg.role ?? "");
		const phase = String(msg.phase ?? "");
		const taskId = String(msg.taskId ?? "");
		const roomId = selectedRoomId ?? "";
		const preview = typeof msg.preview === "string" ? msg.preview : "";
		const fullOutput = typeof msg.fullOutput === "string" ? msg.fullOutput : preview;

		roleProgressBar.textContent = `Role ${roleName}: ${phase}${preview ? ` — ${preview}` : ""}`;
		roleProgressBar.classList.remove("hidden");

		const rid = roleReplyId(taskId);
		let entry = replyStore.get(rid);

		if (phase === "started") {
			if (!entry) {
				entry = {
					id: rid,
					roomId,
					kind: "role",
					label: roleName,
					roleName,
					phase: "running",
					summary: "",
					messages: [],
					events: [],
					startedAt: Date.now(),
				};
				replyStore.set(rid, entry);
				appendReplyId(roomId, rid);
			} else {
				entry.phase = "running";
				entry.detail = undefined;
			}
			updateRoomReplyRows();
			if (activeReplyId === null) {
				renderRoomStatusBoard();
			}
		} else if (phase === "done" || phase === "failed") {
			if (!entry) {
				entry = {
					id: rid,
					roomId,
					kind: "role",
					label: roleName,
					roleName,
					phase: phase === "done" ? "done" : "failed",
					summary: truncateSummary(preview || fullOutput),
					messages: [
						{
							role: "custom",
							customType: "hub_role_output",
							content: fullOutput,
						},
					],
					events: [msg],
					startedAt: Date.now(),
					endedAt: Date.now(),
				};
				replyStore.set(rid, entry);
				appendReplyId(roomId, rid);
			} else {
				entry.phase = phase === "done" ? "done" : "failed";
				entry.summary = truncateSummary(preview || fullOutput);
				entry.messages = [
					{
						role: "custom",
						customType: "hub_role_output",
						content: fullOutput,
					},
				];
				entry.endedAt = Date.now();
				entry.detail = undefined;
			}
			updateRoomReplyRows();
			if (activeReplyId === null) {
				renderRoomStatusBoard();
			} else if (activeReplyId === rid) {
				renderReplyDetail(rid);
			}
		}

		syncRolesBusy();
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

	function sessionDetailActive(): boolean {
		if (!selectedRoomId || !currentTurnId) return false;
		return activeReplyId === sessionReplyId(selectedRoomId, currentTurnId);
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
		const sessionEntry = currentSessionReply();
		const detailActive = sessionDetailActive();
		const statusView = activeReplyId === null;

		if (sessionEntry) {
			sessionEntry.events.push(msg);
		}

		if (event.type === "message_start" && event.message) {
			const m = event.message as { role?: string; customType?: string; display?: boolean };
			// Skip internal/system messages
			if (m.display === false) {
				/* skip */
			} else if (m.role === "assistant") {
				streamingAssistantEl = null;
				streamingAssistantHost = hostDisplayName;
				setStreamingVisual(true);
				if (sessionEntry && statusView) {
					updateStatusRowElement(sessionEntry);
				}
			} else if (m.role === "custom" && detailActive) {
				const div = el("div", `msg ${messageRoleClass(m)}`);
				const meta = el("div", "meta");
				meta.textContent = m.customType ?? "role";
				div.appendChild(meta);
				const body = el("div", "msg-body");
				body.textContent = getMessageText(event.message);
				div.appendChild(body);
				messages.appendChild(div);
				scrollMessagesToBottom();
			}
		}
		if (event.type === "message_update" && event.message) {
			const m = event.message as { role?: string };
			if (m.role === "assistant") {
				const assistant = formatAssistantDisplay(getAssistantMessageMeta(event.message));
				// P2: do not pollute session summary with intermediate (tool/thinking) steps
				if (sessionEntry && !assistant.suppressBubble) {
					upsertSessionReplyPartialText(sessionEntry, assistant.displayText);
					if (statusView) {
						updateStatusRowElement(sessionEntry);
					}
				}
				if (detailActive && !assistant.suppressBubble) {
					if (!streamingAssistantEl && assistant.displayText.trim()) {
						streamingAssistantEl = appendCollapsibleAssistantMsg(
							assistant.displayText,
							true,
							assistantMetaLabel(streamingAssistantHost),
							true,
							assistant.isFailed,
						);
					} else if (streamingAssistantEl) {
						updateStreamingAssistant(event.message, hostDisplayName);
					}
				}
			}
		}
		if (event.type === "message_end" && event.message) {
			const m = event.message as { role?: string };
			if (m.role === "assistant") {
				const assistant = formatAssistantDisplay(getAssistantMessageMeta(event.message));
				// P2: only user-visible final assistant messages mutate session summary/phase.
				if (sessionEntry && !assistant.suppressBubble) {
					upsertSessionReplyPartialText(sessionEntry, assistant.displayText);
					if (assistant.isFailed) {
						sessionEntry.phase = "failed";
						sessionEntry.summary = truncateSummary(assistant.displayText);
					}
					if (statusView) {
						updateStatusRowElement(sessionEntry);
					}
				}
				// P1: tool-call / pure-thinking steps must not create a main bubble
				// nor flash a red error banner.
				if (assistant.suppressBubble) {
					if (streamingAssistantEl) {
						finalizeCollapsibleAssistantMsg(streamingAssistantEl);
					}
				} else if (detailActive) {
					if (!streamingAssistantEl) {
						streamingAssistantEl = appendCollapsibleAssistantMsg(
							assistant.displayText,
							false,
							assistantMetaLabel(streamingAssistantHost),
							true,
							assistant.isFailed,
						);
					} else {
						updateStreamingAssistant(event.message, hostDisplayName);
					}
					if (assistant.bannerMessage && assistant.isFailed) {
						showError(assistant.bannerMessage);
					}
					if (streamingAssistantEl) {
						finalizeCollapsibleAssistantMsg(streamingAssistantEl);
					}
				} else if (assistant.bannerMessage && assistant.isFailed) {
					showError(assistant.bannerMessage);
				}
				streamingAssistantEl = null;
				streamingAssistantHost = null;
				setStreamingVisual(false);
			}
		}
		if (event.type === "agent_end" && Array.isArray(event.messages)) {
			updateTokenStats(event.messages);
			if (sessionEntry) {
				// P2: pick last assistant with non-empty visible text; skip pure tool/thinking steps.
				const lastAssistant = [...event.messages]
					.reverse()
					.find((m) => (m as { role?: string }).role === "assistant" && getMessageText(m).trim().length > 0);
				sessionEntry.phase = "done";
				sessionEntry.messages = event.messages;
				sessionEntry.summary = truncateSummary(getMessageText(lastAssistant ?? {}));
				sessionEntry.endedAt = Date.now();
				sessionEntry.detail = undefined;
				updateRoomReplyRows();
				if (detailActive) {
					renderReplyDetail(sessionEntry.id);
				} else if (statusView) {
					renderRoomStatusBoard();
				}
			}
			setStreamingVisual(false);
		}

		if (event.type === "tool_execution_start") {
			const toolCallId = (event as Record<string, unknown>).toolCallId as string;
			const toolName = (event as Record<string, unknown>).toolName as string;
			const args = (event as Record<string, unknown>).args;
			if (sessionEntry) {
				sessionEntry.detail = toolName ? `调用工具 ${toolName}` : "调用工具";
				if (statusView) {
					updateStatusRowElement(sessionEntry);
				}
			}
			if (!detailActive) return;

			const host = hostDisplayName ?? turnHostName;
			const div = el("div", "msg tool tool-collapsible");
			const headerLine = el("div", "tool-header");
			const indicator = el("span", "tool-toggle");
			indicator.textContent = "▶";
			const nameSpan = el("span", "tool-name");
			const hostPrefix = host ? `${host} · ` : "";
			nameSpan.textContent = `${hostPrefix}${toolName}`;
			headerLine.append(indicator, nameSpan);
			div.appendChild(headerLine);

			const detailWrap = el("div", "tool-detail hidden");
			const argsPre = el("pre", "tool-code");
			argsPre.textContent = args ? JSON.stringify(args, null, 2) : "(no arguments)";
			detailWrap.appendChild(argsPre);
			div.appendChild(detailWrap);

			let expanded = false;
			div.addEventListener("click", () => {
				expanded = !expanded;
				detailWrap.classList.toggle("hidden", !expanded);
				indicator.textContent = expanded ? "▼" : "▶";
			});

			messages.appendChild(div);
			scrollMessagesToBottom();

			if (toolCallId) {
				toolMsgMap.set(toolCallId, { div, detailWrap, argsPre, toolName, args });
			}
		}
		if (
			event.type === "tool_execution_update" &&
			detailActive &&
			toolMsgMap.has((event as Record<string, unknown>).toolCallId as string)
		) {
			const entry = toolMsgMap.get((event as Record<string, unknown>).toolCallId as string)!;
			const partialResult = (event as Record<string, unknown>).partialResult;
			if (partialResult !== undefined) {
				entry.argsPre.textContent += `\n→ ${String(partialResult).slice(0, 500)}`;
			}
		}
		if (
			event.type === "tool_execution_end" &&
			detailActive &&
			toolMsgMap.has((event as Record<string, unknown>).toolCallId as string)
		) {
			const entry = toolMsgMap.get((event as Record<string, unknown>).toolCallId as string)!;
			const result = (event as Record<string, unknown>).result;
			const isError = (event as Record<string, unknown>).isError as boolean;
			if (result !== undefined) {
				entry.argsPre.textContent = `→ Result: ${JSON.stringify(result, null, 2)}`;
				if (isError) {
					entry.div.classList.add("tool-error");
				}
			} else {
				entry.argsPre.textContent = "→ (no result)";
			}
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
		roomAssignedRoles = config.roleNames ?? [];
	}

	function getMentionTargets(): MentionTarget[] {
		const targets: MentionTarget[] = [];
		for (const name of roomAssignedRoles) {
			targets.push({
				kind: "role",
				name,
				label: name,
				hint: "Room role",
			});
		}
		for (const member of presenceMembers) {
			if (member.displayName === session.displayName) {
				continue;
			}
			targets.push({
				kind: "user",
				name: member.displayName,
				label: member.displayName,
				hint: "Online",
			});
		}
		return targets;
	}

	setupMentionComposer({
		input,
		menu: mentionMenu,
		getTargets: getMentionTargets,
	});

	const SCROLL_NEAR_BOTTOM_THRESHOLD = 120;

	function isNearBottom(): boolean {
		return messages.scrollHeight - messages.scrollTop - messages.clientHeight < SCROLL_NEAR_BOTTOM_THRESHOLD;
	}

	/** Scroll messages to bottom. If force is true, always scroll (history load / room switch). Otherwise only if user is already near bottom. */
	function scrollMessagesToBottom(force = false): void {
		if (force || isNearBottom()) {
			messages.scrollTo({ top: messages.scrollHeight, behavior: "auto" });
		}
	}

	function clearChatPanels(): void {
		messages.innerHTML = "";
		messages.appendChild(heroEl);
		roleGapBar.classList.add("hidden");
		roleGapBar.textContent = "";
		rolePlanPanel.classList.add("hidden");
		rolePlanPanel.textContent = "";
		roleProgressBar.classList.add("hidden");
		roleProgressBar.textContent = "";
		activityBar.classList.add("hidden");
		activityBar.textContent = "";
		queueBar.textContent = "Queue empty";
		tokenInput.textContent = "Input: 0";
		tokenOutput.textContent = "Output: 0";
		tokenTotal.textContent = "Total: 0";
		streamingAssistantEl = null;
		streamingAssistantHost = null;
		lastMetaHost = null;
		toolMsgMap = new Map();
		currentTurnId = null;
		setStreamingVisual(false);
		updateHeroVisibility();
	}

	function ingestJoinHistory(roomId: string, msgs: unknown[]): void {
		// Drop any reply entries we previously synthesized from history; live
		// (event-driven) entries keep their ids and are preserved.
		const HIST_PREFIX_SESSION = `session:${roomId}:hist-`;
		const HIST_PREFIX_ROLE = "role:hist-";
		const existingIds = roomReplies.get(roomId) ?? [];
		for (const id of existingIds) {
			if (id.startsWith(HIST_PREFIX_SESSION) || id.startsWith(HIST_PREFIX_ROLE)) {
				replyStore.delete(id);
			}
		}
		const preserved = existingIds.filter(
			(id) => !id.startsWith(HIST_PREFIX_SESSION) && !id.startsWith(HIST_PREFIX_ROLE),
		);

		// Group history into reply rows so the user can see prior turns after a
		// cold join (restart + rejoin). We bucket messages chronologically:
		//   - compactionSummary       -> standalone "Context compacted" row
		//   - custom hub_role_*       -> one role row per (roleName, taskId)
		//   - user                    -> opens a new session row
		//   - assistant / toolResult  -> appended to the open session row
		// (assistant/toolResult arriving with no preceding user open a synthetic
		//  session row, which is what happens for post-compaction tails.)
		type HistGroup =
			| { kind: "session"; messages: unknown[]; userText: string; ts: number }
			| { kind: "role"; roleName: string; taskId: string; messages: unknown[]; ts: number }
			| { kind: "compaction"; messages: unknown[]; ts: number };

		const groups: HistGroup[] = [];
		let openSession: (HistGroup & { kind: "session" }) | null = null;
		const roleGroupByKey = new Map<string, HistGroup & { kind: "role" }>();

		const tsOf = (msg: unknown): number => {
			const t = (msg as { timestamp?: unknown }).timestamp;
			if (typeof t === "number") return t;
			if (typeof t === "string") {
				const n = Date.parse(t);
				return Number.isFinite(n) ? n : 0;
			}
			return 0;
		};

		for (const msg of msgs) {
			const m = msg as {
				role?: string;
				customType?: string;
				display?: boolean;
				details?: Record<string, unknown>;
			};
			// Skip internal/system messages marked as non-displayable
			if (m.display === false) continue;
			const ts = tsOf(msg);

			if (m.role === "compactionSummary") {
				groups.push({ kind: "compaction", messages: [msg], ts });
				openSession = null;
				continue;
			}

			if (m.role === "custom" && typeof m.customType === "string" && m.customType.startsWith("hub_role_")) {
				const roleName = (m.details?.role as string | undefined) ?? "role";
				const taskId = (m.details?.taskId as string | undefined) ?? "";
				const key = `${roleName}::${taskId || `solo-${groups.length}`}`;
				let g = roleGroupByKey.get(key);
				if (!g) {
					g = { kind: "role", roleName, taskId, messages: [], ts };
					groups.push(g);
					roleGroupByKey.set(key, g);
				}
				g.messages.push(msg);
				continue;
			}

			if (m.role === "user") {
				openSession = { kind: "session", messages: [msg], userText: getMessageText(msg), ts };
				groups.push(openSession);
				continue;
			}

			if (m.role === "assistant" || m.role === "toolResult") {
				if (!openSession) {
					openSession = { kind: "session", messages: [], userText: "", ts };
					groups.push(openSession);
				}
				openSession.messages.push(msg);
			}
			// Unknown roles are silently dropped from reply rows; they are still
			// present in the underlying session on the server.
		}

		// Note: each session-kind entry now carries `userText` directly so that
		// `renderRoomStatusBoard` can interleave the user bubble with its status
		// row in chronological order; no separate user-bubble registry is needed.

		// Synthesize ReplyEntry objects for each group.
		const histIds: string[] = [];
		let sessionIdx = 0;
		let roleIdx = 0;
		let compactionIdx = 0;
		for (const g of groups) {
			if (g.kind === "session") {
				const rid = `${HIST_PREFIX_SESSION}${sessionIdx++}`;
				const label = g.userText ? truncateSummary(g.userText, 40) : "对话";
				const lastAssistantText = (() => {
					for (let i = g.messages.length - 1; i >= 0; i--) {
						const mm = g.messages[i] as { role?: string };
						if (mm.role === "assistant") {
							const t = getMessageText(mm).trim();
							if (t) return t;
						}
					}
					return "";
				})();
				replyStore.set(rid, {
					id: rid,
					roomId,
					kind: "session",
					label,
					phase: "done",
					summary: lastAssistantText ? truncateSummary(lastAssistantText) : "",
					messages: g.messages,
					events: [],
					startedAt: g.ts,
					endedAt: g.ts,
					userText: g.userText || undefined,
					userMeta: g.userText ? session.displayName : undefined,
				});
				histIds.push(rid);
			} else if (g.kind === "role") {
				const rid = `${HIST_PREFIX_ROLE}${roleIdx++}`;
				const lastOutput = (() => {
					for (let i = g.messages.length - 1; i >= 0; i--) {
						const mm = g.messages[i] as { customType?: string };
						if (mm.customType === "hub_role_output") return getMessageText(mm).trim();
					}
					return getMessageText(g.messages[g.messages.length - 1] ?? {}).trim();
				})();
				replyStore.set(rid, {
					id: rid,
					roomId,
					kind: "role",
					label: g.roleName,
					roleName: g.roleName,
					phase: "done",
					summary: lastOutput ? truncateSummary(lastOutput) : "",
					messages: g.messages,
					events: [],
					startedAt: g.ts,
					endedAt: g.ts,
				});
				histIds.push(rid);
			} else {
				const rid = `${HIST_PREFIX_SESSION}compaction-${compactionIdx++}`;
				const sm = g.messages[0] as { summary?: string; tokensBefore?: number };
				const summary = sm?.summary ?? "";
				replyStore.set(rid, {
					id: rid,
					roomId,
					kind: "session",
					label: "上下文已压缩",
					phase: "done",
					summary: summary ? truncateSummary(summary) : "",
					messages: g.messages,
					events: [],
					startedAt: g.ts,
					endedAt: g.ts,
				});
				histIds.push(rid);
			}
		}

		roomReplies.set(roomId, [...histIds, ...preserved]);
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
		activeReplyId = null;
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
			const deletedId = msg.roomId as string;
			purgeRoomReplies(deletedId);
			roomTitleById.delete(deletedId);
			void refreshRoomList();
			if (deletedId === selectedRoomId) {
				showError("This room was deleted");
				selectedRoomId = null;
				activeReplyId = null;
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
			const historyMsgs = (msg.messages as unknown[]) ?? [];
			ingestJoinHistory(joinedRoomId, historyMsgs);
			updateTokenStats(historyMsgs);
			refreshMessagesPanel();
			void loadRoomConfigUi(joinedRoomId).catch((e) => showError(e instanceof Error ? e.message : String(e)));
			void refreshModelList(
				(msg.state as HubSessionState | undefined)?.model?.provider && (msg.state as HubSessionState).model?.id
					? {
							provider: (msg.state as HubSessionState).model!.provider!,
							id: (msg.state as HubSessionState).model!.id!,
						}
					: undefined,
			).catch((e) => showError(e instanceof Error ? e.message : String(e)));
			updateRoomInfo(msg);
		}
		if (msg.type === "state_update") {
			applyStateModel(msg.state as HubSessionState | undefined);
		}
		if (msg.type === "presence") {
			const members = (msg.members as Array<{ displayName: string }> | undefined) ?? [];
			presenceMembers = members;
			presenceCount = members.length;
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
		if (msg.type === "sleep_progress") {
			const phase = msg.phase as HubSleepPhase | undefined;
			if (phase) {
				sleepItem.textContent =
					phase === "extracting" ? "Extracting…" : phase === "storing" ? "Storing…" : "Clearing…";
				sleepItem.disabled = true;
			}
		}
		if (msg.type === "sleep_done") {
			isSleeping = false;
			updateSleepButton();
			const payload = msg as { success?: boolean; error?: string; memories?: HubRoleMemory[] };
			const memories = payload.memories ?? [];
			const success = payload.success !== false; // default true for backwards compat with older servers
			if (!success) {
				showError(payload.error ? `Sleep failed: ${payload.error}` : "Sleep failed.");
			} else if (memories.length > 0) {
				const roles = [...new Set(memories.map((m) => m.roleName))];
				showInfo(`Stored ${memories.length} memories for roles: ${roles.join(", ")}`);
			} else {
				showInfo("No memories extracted from this session.");
			}
			// Messages are cleared server-side; clients will receive joined + room_session_cleared.
		}
		if (msg.type === "mention_warning") {
			const payload = msg as {
				roomId?: string;
				unknown?: string[];
				resolvedRoles?: string[];
				fromDisplayName?: string;
			};
			const rid = payload.roomId;
			if (rid && rid !== selectedRoomId) {
				// Different room; ignore.
			} else {
				const unknown = payload.unknown ?? [];
				if (unknown.length > 0) {
					const tokens = unknown.map((t) => `@${t}`).join(", ");
					const who = payload.fromDisplayName ? `${payload.fromDisplayName}: ` : "";
					const tail =
						payload.resolvedRoles && payload.resolvedRoles.length > 0
							? `（已识别角色: ${payload.resolvedRoles.join(", ")}）`
							: "（无角色被触发，已按默认 agent 处理）";
					showInfo(`${who}未识别的提及 ${tokens}${tail}`);
				}
			}
		}
		if (msg.type === "room_session_cleared") {
			const rid = (msg as { roomId?: string }).roomId;
			if (rid) {
				purgeRoomReplies(rid);
				if (rid === selectedRoomId) {
					activeReplyId = null;
					currentTurnId = null;
					refreshMessagesPanel();
					updateRoomReplyRows();
				}
			}
		}
		if (msg.type === "room_info") {
			if ((msg as { roomId?: string }).roomId === selectedRoomId) {
				updateRoomInfo(msg as HubRoomInfo);
			}
		}
		if (msg.type === "extension_ui_request") {
			showExtensionModal(msg);
		}
	});

	sendBtn.onclick = () => {
		const text = input.value.trim();
		if (!text || !selectedRoomId || !client.isJoined()) return;
		input.value = "";

		// Build display text with file references
		let displayText = text;
		const images: Array<{ type: "image"; data: string; mimeType: string }> = [];

		for (const f of attachedFiles) {
			if (f.isImage) {
				images.push({ type: "image", data: f.data, mimeType: f.mimeType });
				displayText += `\n[Image: ${f.name}]`;
			} else {
				displayText += `\n\n--- ${f.name} ---\n${f.data}`;
			}
		}

		attachedFiles.length = 0;
		renderChips();

		const roomId = selectedRoomId;
		currentTurnId = String(Date.now());
		const turnId = currentTurnId;
		const sid = sessionReplyId(roomId, turnId);
		const label = getRoomDisplayLabel(roomId);
		replyStore.set(sid, {
			id: sid,
			roomId,
			kind: "session",
			label,
			phase: "running",
			summary: "",
			messages: [],
			events: [],
			startedAt: Date.now(),
			userText: displayText,
			userMeta: session.displayName,
		});
		appendReplyId(roomId, sid);

		activeReplyId = null;
		refreshMessagesPanel();
		updateRoomReplyRows();

		client.prompt(text, images.length > 0 ? { images } : undefined);
	};

	input.addEventListener("keydown", (e) => {
		if (e.defaultPrevented) return;
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
	const logoWrapper = el("div", "logo-wrapper");
	const logoRing = el("div", "logo-ring");
	const logoSymbol = Object.assign(el("div", "logo-symbol"), { textContent: "π" });
	logoSymbol.style.animation = "pulse-dot 1.5s ease-in-out infinite";
	logoWrapper.append(logoRing, logoSymbol);
	shell.appendChild(logoWrapper);
	shell.appendChild(
		Object.assign(el("p", "hint"), { textContent: "Connecting…", style: "position:relative;z-index:1" }),
	);
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
