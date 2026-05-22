/* =============================================================
 * Office view — "Marvis 办公室"
 * -------------------------------------------------------------
 * Renders an isometric 4x4 grid of rooms. Each room tile shows
 * a small capsule character when the room is currently active
 * (clientCount > 0). Clicking any non-current room closes the
 * modal and switches the main UI to that room.
 *
 * Side panel: three small stats, a daily tip card, and a mascot
 * "今日穿搭" card whose scarf color rotates daily. Clicking the
 * mascot triggers a blink + token+1 float easter egg.
 * ============================================================= */

import type { HubClient } from "./hub-client.ts";
import type { HubRoleSummaryPayload, HubRoomSummary } from "./protocol.ts";

interface OfficeData {
	currentRoomId: string;
	rooms: HubRoomSummary[]; // sorted, sliced to <= 16
	availableRoleCount: number;
	totalRoomCount: number;
	activeRoomCount: number;
}

const MAX_ROOMS = 16;
const GRID_COLS = 4;

const SCARF_COLORS: { hex: string; name: string }[] = [
	{ hex: "#FF4D2E", name: "朝霞红" },
	{ hex: "#F5A623", name: "暖阳橙" },
	{ hex: "#F4D35E", name: "麦穗黄" },
	{ hex: "#2ECC71", name: "苔原绿" },
	{ hex: "#4A90E2", name: "雾湖蓝" },
	{ hex: "#9B59B6", name: "暮山紫" },
	{ hex: "#8C8C90", name: "晨雾灰" },
];

const DAILY_TIPS: string[] = [
	"今天也是 token+1 的一天 ☕",
	"好的提示词，是你与模型的第一次握手",
	"马维斯帮你保存了一杯咖啡的时间",
	"慢即是快——给上下文一点时间",
	"今天的 bug 是明天的 feature",
	"先描述目标，再描述步骤",
	"复杂任务交给房间分工，比塞进一个对话更顺手",
	"看不懂的回答，反问一句往往就清楚了",
	"保存常用提示，明天的自己会感谢你",
	"少说一句废话，多省一个 token",
	"重启对话，是最便宜的调试方法",
	"分而治之：一个房间一个项目",
	"角色不在多，称手最重要",
	"试试把任务拆成三步走",
	"读不完？让马维斯帮你抓重点",
	"今天的灵感，明天可能就忘了——记下来",
	"屏幕外抬头看看，眼睛也需要 break",
	"喝口水再继续，模型不会跑掉",
	"用例子说话，模型听得懂",
	"先跑通，再优化",
	"小步快跑，大步会摔",
	"一次只问一件事",
	"不确定的时候，问马维斯",
	"模型不读心，但读上下文",
	"把今天的任务写下来，再交给马维斯",
	"复制别人的好提示，不丢人",
	"耐心一点，结果会更好",
	"困了？先睡，明天会更聪明",
	"少即是多——除了 token",
	"今天的小进步也是进步",
	"好工具值得花一分钟学会",
	"留点时间给自己 think out loud",
];

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

function dayOfYear(d: Date = new Date()): number {
	const start = new Date(d.getFullYear(), 0, 0);
	return Math.floor((d.getTime() - start.getTime()) / 86400000);
}

function todayTip(): string {
	return DAILY_TIPS[dayOfYear() % DAILY_TIPS.length]!;
}

function todayScarf(): { hex: string; name: string } {
	return SCARF_COLORS[dayOfYear() % SCARF_COLORS.length]!;
}

function isRoomActive(room: HubRoomSummary): boolean {
	return (room.clientCount ?? 0) > 0;
}

function sortRooms(rooms: HubRoomSummary[], currentRoomId: string): HubRoomSummary[] {
	return [...rooms].sort((a, b) => {
		if (a.roomId === currentRoomId) return -1;
		if (b.roomId === currentRoomId) return 1;
		const aA = isRoomActive(a) ? 1 : 0;
		const bA = isRoomActive(b) ? 1 : 0;
		if (aA !== bA) return bA - aA;
		return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
	});
}

/* ---------- Isometric stage ---------- */

function buildOfficeSVG(
	rooms: HubRoomSummary[],
	currentRoomId: string,
	onSelect: (roomId: string) => void,
): SVGSVGElement {
	const cols = GRID_COLS;
	const tileW = 110;
	const tileH = 64;
	const originX = 320;
	const originY = 64;

	const root = svg("svg", {
		viewBox: "0 0 640 400",
		role: "img",
		"aria-label": "Marvis office rooms",
	});

	const total = Math.min(rooms.length, MAX_ROOMS);
	for (let i = 0; i < total; i++) {
		const col = i % cols;
		const row = Math.floor(i / cols);
		const cx = originX + (col - row) * (tileW / 2);
		const cy = originY + (col + row) * (tileH / 2);
		const room = rooms[i]!;
		root.appendChild(buildRoomTile(cx, cy, room, room.roomId === currentRoomId, onSelect));
	}

	return root;
}

function buildRoomTile(
	cx: number,
	cy: number,
	room: HubRoomSummary,
	isCurrent: boolean,
	onSelect: (roomId: string) => void,
): SVGGElement {
	// Outer holds the absolute position via SVG transform attribute so
	// the CSS :hover transform on the inner group can't clobber it.
	const outer = svg("g", { transform: `translate(${cx} ${cy})` });
	const g = svg("g", { class: `room-tile${isCurrent ? " current" : " clickable"}` });
	if (!isCurrent) {
		g.addEventListener("click", () => onSelect(room.roomId));
	}

	const active = isRoomActive(room);

	// Soft drop shadow
	g.appendChild(
		svg("ellipse", {
			cx: 0,
			cy: 76,
			rx: 50,
			ry: 7,
			fill: "rgba(15,15,16,0.06)",
			class: "room-shadow",
		}),
	);

	// Floor diamond
	g.appendChild(
		svg("polygon", {
			points: "0,16 50,46 0,76 -50,46",
			fill: active ? "#ffffff" : "#f4f4f5",
			stroke: isCurrent ? "#0f0f10" : active ? "rgba(15,15,16,0.12)" : "rgba(15,15,16,0.06)",
			"stroke-width": isCurrent ? 1.5 : 1,
			class: "room-floor",
		}),
	);

	// Monitor on the desk
	g.appendChild(
		svg("rect", {
			x: -12,
			y: 14,
			width: 24,
			height: 16,
			rx: 2,
			fill: active ? "#0f0f10" : "#cfcfd4",
		}),
	);
	g.appendChild(
		svg("rect", {
			x: -3,
			y: 30,
			width: 6,
			height: 3,
			fill: active ? "#0f0f10" : "#cfcfd4",
		}),
	);

	// Active room: capsule character standing behind the desk
	if (active) {
		const px = 22;
		// body
		g.appendChild(
			svg("rect", {
				x: px - 7,
				y: 34,
				width: 14,
				height: 16,
				rx: 4,
				fill: "#0f0f10",
			}),
		);
		// scarf
		g.appendChild(
			svg("rect", {
				x: px - 7,
				y: 30,
				width: 14,
				height: 4,
				rx: 2,
				fill: "#E94B2B",
			}),
		);
		// head
		g.appendChild(
			svg("circle", {
				cx: px,
				cy: 22,
				r: 8,
				fill: "#0f0f10",
			}),
		);
	}

	// Room name label above the tile
	const label = svg("text", {
		x: 0,
		y: 4,
		"text-anchor": "middle",
		class: `room-label${isCurrent ? " current" : ""}`,
	});
	const labelText = (room.title?.trim() || room.roomId).slice(0, 18);
	label.textContent = labelText;
	g.appendChild(label);

	// "本房间" badge for the current room
	if (isCurrent) {
		const badge = svg("g", { class: "room-badge", transform: "translate(0 -14)" });
		badge.appendChild(
			svg("rect", {
				x: -20,
				y: -10,
				width: 40,
				height: 14,
				rx: 7,
				fill: "#0f0f10",
			}),
		);
		const t = svg("text", {
			x: 0,
			y: 0,
			"text-anchor": "middle",
			class: "room-badge-text",
		});
		t.textContent = "本房间";
		badge.appendChild(t);
		g.appendChild(badge);
	}

	// Tooltip via <title>
	const title = svg("title");
	const status = active ? "在工作" : "待机";
	const titleStr = room.title?.trim();
	const lines = [
		titleStr ? `${titleStr} (${room.roomId})` : room.roomId,
		status,
		isCurrent ? "本房间" : "点击切换到这个房间",
	];
	title.textContent = lines.join("\n");
	g.appendChild(title);

	outer.appendChild(g);
	return outer;
}

/* ---------- Mascot (今日穿搭) ---------- */

function buildMascotSVG(scarfHex: string): SVGSVGElement {
	const root = svg("svg", {
		viewBox: "-60 -70 120 150",
		class: "mascot-svg",
		role: "img",
		"aria-label": "Marvis mascot",
	});

	// shadow
	root.appendChild(
		svg("ellipse", {
			cx: 0,
			cy: 70,
			rx: 40,
			ry: 6,
			fill: "rgba(15,15,16,0.08)",
		}),
	);
	// body
	root.appendChild(
		svg("rect", {
			x: -22,
			y: 8,
			width: 44,
			height: 58,
			rx: 12,
			fill: "#0f0f10",
		}),
	);
	// scarf
	root.appendChild(
		svg("rect", {
			x: -24,
			y: 0,
			width: 48,
			height: 12,
			rx: 4,
			fill: scarfHex,
			class: "mascot-scarf",
		}),
	);
	// scarf tail
	root.appendChild(
		svg("polygon", {
			points: "16,8 26,8 22,22 14,16",
			fill: scarfHex,
			class: "mascot-scarf",
		}),
	);
	// head
	root.appendChild(
		svg("circle", {
			cx: 0,
			cy: -16,
			r: 24,
			fill: "#0f0f10",
		}),
	);
	// ears
	root.appendChild(
		svg("polygon", {
			points: "-14,-38 -6,-30 -16,-26",
			fill: "#0f0f10",
		}),
	);
	root.appendChild(
		svg("polygon", {
			points: "14,-38 6,-30 16,-26",
			fill: "#0f0f10",
		}),
	);
	// mane spikes
	root.appendChild(
		svg("polygon", {
			points: "-4,-44 2,-32 -10,-32",
			fill: "#0f0f10",
		}),
	);
	root.appendChild(
		svg("polygon", {
			points: "6,-42 12,-30 0,-30",
			fill: "#0f0f10",
		}),
	);
	// eyes
	root.appendChild(
		svg("circle", {
			cx: -7,
			cy: -16,
			r: 2.4,
			fill: "#ffffff",
			class: "mascot-eye",
		}),
	);
	root.appendChild(
		svg("circle", {
			cx: 7,
			cy: -16,
			r: 2.4,
			fill: "#ffffff",
			class: "mascot-eye",
		}),
	);

	return root;
}

function playMascotEasterEgg(host: HTMLElement): void {
	host.classList.remove("blink");
	// force reflow so re-adding the class restarts the animation
	void host.offsetWidth;
	host.classList.add("blink");

	const float = document.createElement("span");
	float.className = "mascot-token-float";
	float.textContent = "token+1";
	// slight horizontal jitter
	const dx = Math.floor(Math.random() * 30 - 15);
	float.style.setProperty("--dx", `${dx}px`);
	host.appendChild(float);
	window.setTimeout(() => float.remove(), 900);
}

/* ---------- Data loading ---------- */

async function loadOfficeData(client: HubClient, currentRoomId: string): Promise<OfficeData> {
	const [allRoles, rooms] = await Promise.all([
		client.listRoles().catch(() => [] as HubRoleSummaryPayload[]),
		client.listRooms().catch(() => [] as HubRoomSummary[]),
	]);

	const sorted = sortRooms(rooms, currentRoomId);
	const visible = sorted.slice(0, MAX_ROOMS);
	const activeRoomCount = rooms.filter(isRoomActive).length;

	return {
		currentRoomId,
		rooms: visible,
		availableRoleCount: allRoles.length,
		totalRoomCount: rooms.length,
		activeRoomCount,
	};
}

/* ---------- Public entry ---------- */

/**
 * Show the Marvis-style "Office" modal for the given room.
 *
 * @param client          Hub client.
 * @param roomId          The currently-selected room id.
 * @param onSelectRoom    Called when the user clicks another room tile. The
 *                        modal closes first; the caller is responsible for
 *                        actually switching the main UI to that room.
 */
export async function showOfficeModal(
	client: HubClient,
	roomId: string,
	onSelectRoom?: (roomId: string) => void,
): Promise<void> {
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
	const stageLoading = el("div", "office-loading");
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
	stage.appendChild(
		buildOfficeSVG(data.rooms, data.currentRoomId, (targetRoomId) => {
			close();
			onSelectRoom?.(targetRoomId);
		}),
	);

	/* Side panel */

	// Top stats row
	const row = el("div", "office-stat-row");
	const buildSmall = (label: string, value: string): HTMLDivElement => {
		const w = el("div", "office-stat");
		const l = el("p", "office-stat-label");
		l.textContent = label;
		const v = el("p", "office-stat-value");
		v.textContent = value;
		w.append(l, v);
		return w;
	};
	row.appendChild(buildSmall("Active", String(data.activeRoomCount)));
	row.appendChild(buildSmall("Available", String(data.availableRoleCount)));
	row.appendChild(buildSmall("Rooms", String(data.totalRoomCount)));
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
	offDot.append(offSwatch, document.createTextNode("Idle"));
	legend.append(onDot, offDot);
	side.appendChild(legend);

	// Daily tip card
	const tipCard = el("div", "office-tip");
	const tipLabel = el("p", "office-tip-label");
	tipLabel.textContent = "每日 tip";
	const tipBody = el("p", "office-tip-body");
	tipBody.textContent = todayTip();
	tipCard.append(tipLabel, tipBody);
	side.appendChild(tipCard);

	// Mascot card (今日穿搭)
	const scarf = todayScarf();
	const mascotCard = el("div", "office-mascot");
	const mascotLabel = el("p", "office-mascot-label");
	mascotLabel.textContent = "今日穿搭";
	const mascotStage = el("button", "office-mascot-stage");
	mascotStage.type = "button";
	mascotStage.setAttribute("aria-label", `Marvis mascot, scarf: ${scarf.name}. Click for surprise.`);
	mascotStage.appendChild(buildMascotSVG(scarf.hex));
	mascotStage.addEventListener("click", () => playMascotEasterEgg(mascotStage));
	const mascotCaption = el("p", "office-mascot-caption");
	const swatch = el("span", "office-mascot-swatch");
	swatch.style.background = scarf.hex;
	mascotCaption.append(swatch, document.createTextNode(`今日：${scarf.name}`));
	mascotCard.append(mascotLabel, mascotStage, mascotCaption);
	side.appendChild(mascotCard);
}
