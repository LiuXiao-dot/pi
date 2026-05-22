const { contextBridge, ipcRenderer } = require("electron");

export interface ElectronAPI {
	copyToClipboard: (text: string) => void;
	firstRunDone: () => void;
}

const api: ElectronAPI = {
	copyToClipboard: (text: string) => {
		ipcRenderer.send("copy-to-clipboard", text);
	},
	firstRunDone: () => {
		ipcRenderer.send("first-run-done");
	},
};

contextBridge.exposeInMainWorld("electronAPI", api);
