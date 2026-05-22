import type { Tray as TrayType } from "electron";
import electron from "electron";

const { Menu, nativeImage, Tray } = electron;

export interface TrayOptions {
	onShow: () => void;
	onQuit: () => void;
	lanUrl: string;
}

function createTrayIcon() {
	const pngBase64 =
		"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAO0lEQVQ4T2NkYPj/n4EaAONoAUwjHjAaYDQAjeYBAc0wagAIYNQAEAWMehBoHtAPBgAEAAB//wMAiNoUFbXbfMMAAAAASUVORK5CYII=";
	return nativeImage.createFromBuffer(Buffer.from(pngBase64, "base64")).resize({ width: 16, height: 16 });
}

export function createTray(options: TrayOptions) {
	let tray: TrayType | null = null;

	const icon = createTrayIcon();

	const contextMenu = Menu.buildFromTemplate([
		{
			label: "Show pi Hub",
			click: () => options.onShow(),
		},
		{
			label: `LAN: ${options.lanUrl}`,
			enabled: false,
		},
		{ type: "separator" },
		{
			label: "Quit",
			click: () => options.onQuit(),
		},
	]);

	tray = new Tray(icon);
	tray.setToolTip("pi Hub");
	tray.setContextMenu(contextMenu);

	tray.on("double-click", () => {
		options.onShow();
	});

	return {
		destroy: () => {
			tray?.destroy();
			tray = null;
		},
		updateLanUrl: (url: string) => {
			const menu = Menu.buildFromTemplate([
				{
					label: "Show pi Hub",
					click: () => options.onShow(),
				},
				{
					label: `LAN: ${url}`,
					enabled: false,
				},
				{ type: "separator" },
				{
					label: "Quit",
					click: () => options.onQuit(),
				},
			]);
			tray?.setContextMenu(menu);
		},
	};
}
