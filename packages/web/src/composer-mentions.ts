export type MentionKind = "role" | "user";

export interface MentionTarget {
	kind: MentionKind;
	name: string;
	label: string;
	hint?: string;
}

export interface MentionComposerOptions {
	input: HTMLTextAreaElement;
	menu: HTMLElement;
	getTargets: () => MentionTarget[];
}

interface ActiveMentionQuery {
	start: number;
	query: string;
}

function getActiveMentionQuery(input: HTMLTextAreaElement): ActiveMentionQuery | null {
	const cursor = input.selectionStart ?? input.value.length;
	const before = input.value.slice(0, cursor);
	const at = before.lastIndexOf("@");
	if (at < 0) {
		return null;
	}
	const between = before.slice(at + 1);
	if (between.includes(" ") || between.includes("\n")) {
		return null;
	}
	return { start: at, query: between.toLowerCase() };
}

function filterTargets(targets: MentionTarget[], query: string): MentionTarget[] {
	if (!query) {
		return targets;
	}
	return targets.filter(
		(t) =>
			t.name.toLowerCase().includes(query) ||
			t.label.toLowerCase().includes(query) ||
			(t.hint?.toLowerCase().includes(query) ?? false),
	);
}

export function setupMentionComposer(options: MentionComposerOptions): () => void {
	const { input, menu, getTargets } = options;
	let activeIndex = 0;
	let visibleItems: MentionTarget[] = [];

	function hideMenu(): void {
		menu.classList.add("hidden");
		menu.innerHTML = "";
		visibleItems = [];
		activeIndex = 0;
	}

	function renderMenu(items: MentionTarget[]): void {
		menu.innerHTML = "";
		if (items.length === 0) {
			hideMenu();
			return;
		}
		visibleItems = items;
		for (let i = 0; i < items.length; i++) {
			const item = items[i]!;
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "mention-menu-item";
			if (i === activeIndex) {
				btn.classList.add("mention-menu-item-active");
			}
			const kind = document.createElement("span");
			kind.className = `mention-menu-kind mention-menu-kind-${item.kind}`;
			kind.textContent = item.kind === "role" ? "role" : "user";
			const label = document.createElement("span");
			label.className = "mention-menu-label";
			label.textContent = item.label;
			btn.append(kind, label);
			if (item.hint) {
				const hint = document.createElement("span");
				hint.className = "mention-menu-hint";
				hint.textContent = item.hint;
				btn.appendChild(hint);
			}
			btn.addEventListener("mousedown", (e) => {
				e.preventDefault();
				applyMention(item.name);
			});
			menu.appendChild(btn);
		}
		menu.classList.remove("hidden");
	}

	function applyMention(name: string): void {
		const query = getActiveMentionQuery(input);
		if (!query) {
			hideMenu();
			return;
		}
		const cursor = input.selectionStart ?? input.value.length;
		const before = input.value.slice(0, query.start);
		const after = input.value.slice(cursor);
		const insert = `@${name} `;
		input.value = `${before}${insert}${after}`;
		const nextCursor = before.length + insert.length;
		input.setSelectionRange(nextCursor, nextCursor);
		input.focus();
		hideMenu();
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}

	function refreshMenu(): void {
		const query = getActiveMentionQuery(input);
		if (!query) {
			hideMenu();
			return;
		}
		activeIndex = 0;
		renderMenu(filterTargets(getTargets(), query.query));
	}

	function onKeyDown(e: KeyboardEvent): void {
		if (menu.classList.contains("hidden") || visibleItems.length === 0) {
			return;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			activeIndex = (activeIndex + 1) % visibleItems.length;
			renderMenu(visibleItems);
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			activeIndex = (activeIndex - 1 + visibleItems.length) % visibleItems.length;
			renderMenu(visibleItems);
			return;
		}
		if (e.key === "Enter" || e.key === "Tab") {
			const picked = visibleItems[activeIndex];
			if (picked) {
				e.preventDefault();
				applyMention(picked.name);
			}
			return;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			hideMenu();
		}
	}

	input.addEventListener("input", refreshMenu);
	input.addEventListener("click", refreshMenu);
	input.addEventListener("keydown", onKeyDown);
	document.addEventListener("click", (e) => {
		if (e.target === input || menu.contains(e.target as Node)) {
			return;
		}
		hideMenu();
	});

	return hideMenu;
}
