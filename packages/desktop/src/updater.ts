import electron from "electron";

const { dialog } = electron;

import { autoUpdater } from "electron-updater";

export function setupUpdater(): void {
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = true;

	autoUpdater.on("update-available", async () => {
		const result = await dialog.showMessageBox({
			type: "info",
			title: "Update Available",
			message: "A new version of pi Hub is available. Download now?",
			buttons: ["Download", "Later"],
			defaultId: 0,
		});
		if (result.response === 0) {
			void autoUpdater.downloadUpdate();
		}
	});

	autoUpdater.on("update-downloaded", async () => {
		const result = await dialog.showMessageBox({
			type: "info",
			title: "Update Ready",
			message: "Update downloaded. Restart now to install?",
			buttons: ["Restart", "Later"],
			defaultId: 0,
		});
		if (result.response === 0) {
			autoUpdater.quitAndInstall();
		}
	});

	autoUpdater.on("error", (error) => {
		console.error("[pi-desktop] Update error:", error.message);
	});

	void autoUpdater.checkForUpdates();
}
