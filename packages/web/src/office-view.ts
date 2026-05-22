/* =============================================================
 * Office view — "Marvis 办公室"
 * -------------------------------------------------------------
 * Renders the room's role roster as an isometric workstation grid
 * with a side panel of conversation stats. Pure SVG, no extra deps.
 * ============================================================= */

import type { HubClient } from "./hub-client.ts";
import type { HubRoleSummaryPayload, HubRoomSummary } from "./protocol.ts";

interface OfficeData {
	roomId: string;
	activeRoles: HubRoleSummaryPayload[];
	availableRoleCount: number;
	roomCount: number;
}

const TOTAL_WORKSTATIONS = 9;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	return node;
}

function svg<K extends keyof SVGElementTagNameMap>(
	tag: K,
	attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
	const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
	for (const [k, v] of Object.entries(attrs)) {
		node.setAttribute(k, String(v));
	}
	return node;
}

/** Color palette for active role badges (cycled). */
const ROLE_COLORS = ["#E94B2B", "#1F8A4C", "#2563EB", "#9333EA", "#D97706", "#0891B2"];

/** Build an isometric office stage SVG. */
function buildOfficeSVG(activeRoles: HubRoleSummaryPayload[]): SVGSVGElement {
	const cols = 3;
	const tileW = 140;
	const tileH = 80;
	const originX = 360;
	const originY = 40;

	const root = svg("svg", {
		viewBox: "0 0 720 460",
		role: "img",
		"aria-label": "Marvis office: room role workstations",
	});

	// Soft floor under the grid
	const floor = svg("rect", {
		x: 0,
		y: 0,
		width: 720,
		height: 460,
		fill: "transparent",
	});
	root.appendChild(floor);

	for (let i = 0; i < TOTAL_WORKSTATIONS; i++) {
		const col = i % cols;
		const row = Math.floor(i / cols);
		// Isometric projection: x = (col - row) * tileW/2, y = (col + row) * tileH/2
		const cx = originX + (col - row) * (tileW / 2);
		const cy = originY + (col + row) * (tileH / 2);
		const role = activeRoles[i];
		const colorIdx = i % ROLE_COLORS.length;
		root.appendChild(buildWorkstation(cx, cy, role, ROLE_COLORS[colorIdx]!));
	}

	return root;
}

function buildWorkstation(
	cx: number,
	cy: number,
	role: HubRoleSummaryPayload | undefined,
	accent: string,
): SVGGElement {
	const g = svg("g", { class: "ws-group", transform: `translate(${cx} ${cy})` });
	const active = !!role;

	// Desk diamond (isometric top)
	const desk = svg("polygon", {
		points: "0,20 60,50 0,80 -60,50",
		fill: active ? "#ffffff" : "#f4f4f5",
		stroke: active ? "rgba(15,15,16,0.10)" : "rgba(15,15,16,0.06)",
		"stroke-width": 1,
	});
	// Soft drop shadow under desk
	const shadow = svg("ellipse", {
		cx: 0,
		cy: 88,
		rx: 56,
		ry: 8,
		fill: "rgba(15,15,16,0.06)",
	});
	g.appendChild(shadow);
	g.appendChild(desk);

	// Monitor (small upright rectangle on the desk)
	const monitor = svg("rect", {
		x: -16,
		y: 8,
		width: 32,
		height: 22,
		rx: 3,
		fill: active ? "#0f0f10" : "#cfcfd4",
	});
	const stand = svg("rect", {
		x: -3,
		y: 30,
		width: 6,
		height: 6,
		fill: active ? "#0f0f10" : "#cfcfd4",
	});
	g.appendChild(monitor);
	g.appendChild(stand);

	if (active && role) {
		// Active role: little capsule character + colored scarf
		const head = svg("circle", { cx: 30, cy: 38, r: 10, fill: "#0f0f10" });
		const scarf = svg("rect", { x: 22, y: 46, width: 16, height: 4, rx: 2, fill: accent });
		const body = svg("rect", { x: 22, y: 49, width: 16, height: 16, rx: 4, fill: "#0f0f10" });
		g.appendChild(head);
		g.appendChild(scarf);
		g.appendChild(body);

		const label = svg("text", { x: 0, y: -2, "text-anchor": "middle", class: "ws-label" });
		label.textContent = role.name;
		g.appendChild(label);

		// Tooltip via <title>
		const title = svg("title");
		const lines = [role.name, role.who, role.can].filter(Boolean) as string[];
		title.textContent = lines.join("\n");
		g.appendChild(title);
	} else {
		// Empty slot label
		const label = svg("text", { x: 0, y: -2, "text-anchor": "middle", class: "ws-label muted" });
		label.textContent = "—";
		g.appendChild(label);
		const title = svg("title");
		title.textContent = "Empty workstation (room for a future role)";
		g.appendChild(title);
	}

	return g;
}

async function loadOfficeData(client: HubClient, roomId: string): Promise<OfficeData> {
	const [config, allRoles, rooms] = await Promise.all([
		client.getRoomConfig(roomId).catch(() => ({})),
		client.listRoles().catch(() => [] as HubRoleSummaryPayload[]),
		client.listRooms().catch(() => [] as HubRoomSummary[]),
	]);

	const activeNames = new Set((config.roleNames ?? []).map((n) => n.trim()).filter(Boolean));
	const byName = new Map(allRoles.map((r) => [r.name, r]));
	const activeRoles: HubRoleSummaryPayload[] = [];
	for (const name of activeNames) {
		const found = byName.get(name);
		if (found) activeRoles.push(found);
		else {
			activeRoles.push({ name, description: "", source: "project" });
		}
	}

	return {
		roomId,
		activeRoles,
		availableRoleCount: allRoles.length,
		roomCount: rooms.length,
	};
}

/**
 * Show the Marvis-style "Office" modal for the given room.
 * Closes on backdrop click, Escape, or the Close button.
 */
export async function showOfficeModal(client: HubClient, roomId: string): Promise<void> {
	const backdrop = el("div", "modal-backdrop");
	const modal = el("div", "modal office-modal");
	modal.setAttribute("role", "dialog");
	modal.setAttribute("aria-modal", "true");
	modal.setAttribute("aria-label", "Marvis office");

	const previouslyFocused = document.activeElement as HTMLElement | null;

	function close(): void {
		document.removeEventListener("keydown", onKey);
		backdrop.remove();
		previouslyFocused?.focus?.();
	}

	function onKey(ev: KeyboardEvent): void {
		if (ev.key === "Escape") {
			ev.stopPropagation();
			close();
		}
	}
	document.addEventListener("keydown", onKey);
	backdrop.addEventListener("click", (ev) => {
		if (ev.target === backdrop) close();
	});

	// Header
	const header = el("div", "office-header");
	const title = el("h3", "office-title");
	title.textContent = "Marvis 办公室";
	const roomTag = el("span", "office-room");
	roomTag.textContent = `room: ${roomId}`;
	header.append(title, roomTag);
	modal.appendChild(header);

	// Body (loading placeholder first)
	const body = el("div", "office-body");
	const stage = el("div", "office-stage");
	const stageLoading = el("div");
	stageLoading.textContent = "Loading…";
	stage.appendChild(stageLoading);

	const side = el("div", "office-side");
	body.append(stage, side);
	modal.appendChild(body);

	// Footer
	const actions = el("div", "office-actions");
	const closeBtn = el("button", "secondary-btn");
	closeBtn.type = "button";
	closeBtn.textContent = "Close";
	closeBtn.onclick = () => close();
	actions.appendChild(closeBtn);
	modal.appendChild(actions);

	backdrop.appendChild(modal);
	document.body.appendChild(backdrop);
	closeBtn.focus();

	let data: OfficeData;
	try {
		data = await loadOfficeData(client, roomId);
	} catch (err) {
		stageLoading.textContent = `Failed to load: ${err instanceof Error ? err.message : String(err)}`;
		return;
	}

	// Render stage
	stage.innerHTML = "";
	stage.appendChild(buildOfficeSVG(data.activeRoles));

	// Render side panel
	const stat = (label: string, value: string): HTMLDivElement => {
		const wrap = el("div", "office-stat");
		const lbl = el("p", "office-stat-label");
		lbl.textContent = label;
		const val = el("p", "office-stat-value");
		val.textContent = value;
		wrap.append(lbl, val);
		return wrap;
	};

	const tokenStat = stat("今日消耗 Token", "—");
	tokenStat.title = "Per-room token accounting is not yet plumbed through the hub.";
	const savedStat = stat("今日节省 Token", "—");
	savedStat.title = "Per-room token accounting is not yet plumbed through the hub.";
	side.appendChild(tokenStat);
	side.appendChild(savedStat);

	// Conversation row (in-progress / done / total are not yet tracked; show
	// active-role and available-role counts and room count instead — honest).
	const row = el("div", "office-stat-row");
	const buildSmall = (label: string, value: string) => {
		const w = el("div", "office-stat");
		const l = el("p", "office-stat-label");
		l.textContent = label;
		const v = el("p", "office-stat-value");
		v.textContent = value;
		w.append(l, v);
		return w;
	};
	row.appendChild(buildSmall("Active", String(data.activeRoles.length)));
	row.appendChild(buildSmall("Available", String(data.availableRoleCount)));
	row.appendChild(buildSmall("Rooms", String(data.roomCount)));
	side.appendChild(row);

	// Legend
	const legend = el("div", "office-legend");
	const onDot = el("span");
	const onSwatch = el("span", "office-legend-dot");
	onSwatch.style.background = "#0f0f10";
	onDot.append(onSwatch, document.createTextNode("Active"));
	const offDot = el("span");
	const offSwatch = el("span", "office-legend-dot");
	offSwatch.style.background = "#cfcfd4";
	offDot.append(offSwatch, document.createTextNode("Empty"));
	legend.append(onDot, offDot);
	side.appendChild(legend);
}
