import * as crypto from "node:crypto";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import type { HubExtensionUIRequest, HubExtensionUIResponse } from "./protocol.ts";

export type ExtensionUIBroadcast = (request: HubExtensionUIRequest, targetClientId: string | null) => void;

export class ExtensionUiRouter {
	private readonly pending = new Map<
		string,
		{ resolve: (value: HubExtensionUIResponse) => void; targetClientId: string }
	>();
	private readonly broadcast: ExtensionUIBroadcast;
	private readonly getTurnOriginClientId: () => string | null;

	constructor(broadcast: ExtensionUIBroadcast, getTurnOriginClientId: () => string | null) {
		this.broadcast = broadcast;
		this.getTurnOriginClientId = getTurnOriginClientId;
	}

	createContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) =>
				this.createDialogPromise(
					opts,
					undefined,
					{ method: "select", title, options, timeout: opts?.timeout },
					(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
				),

			confirm: (title, message, opts) =>
				this.createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
					"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
				),

			input: (title, placeholder, opts) =>
				this.createDialogPromise(
					opts,
					undefined,
					{ method: "input", title, placeholder, timeout: opts?.timeout },
					(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
				),

			notify: (message, type) => {
				this.fireAndForget({ method: "notify", message, notifyType: type });
			},

			onTerminalInput: () => () => {},

			setStatus: (key, text) => {
				this.fireAndForget({ method: "setStatus", statusKey: key, statusText: text });
			},

			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: (_options?: WorkingIndicatorOptions) => {},
			setHiddenThinkingLabel: () => {},

			setWidget: (key, content, options?: ExtensionWidgetOptions) => {
				if (content === undefined || Array.isArray(content)) {
					this.fireAndForget({
						method: "setWidget",
						widgetKey: key,
						widgetLines: content as string[] | undefined,
						widgetPlacement: options?.placement,
					});
				}
			},

			setFooter: () => {},
			setHeader: () => {},
			setTitle: (title) => {
				this.fireAndForget({ method: "setTitle", title });
			},

			custom: async () => undefined as never,

			pasteToEditor: (text) => {
				this.fireAndForget({ method: "set_editor_text", text });
			},

			setEditorText: (text) => {
				this.fireAndForget({ method: "set_editor_text", text });
			},

			getEditorText: () => "",

			editor: (title, prefill) =>
				this.createDialogPromise(undefined, undefined, { method: "editor", title, prefill }, (r) =>
					"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
				),

			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			get theme() {
				return undefined as unknown as ExtensionUIContext["theme"];
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "Theme not available in hub" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		} as ExtensionUIContext;
	}

	handleResponse(response: HubExtensionUIResponse): boolean {
		const pending = this.pending.get(response.id);
		if (!pending) {
			return false;
		}
		pending.resolve(response);
		return true;
	}

	private fireAndForget(fields: Record<string, unknown>): void {
		const id = crypto.randomUUID();
		this.broadcast({ type: "extension_ui_request", id, ...fields } as HubExtensionUIRequest, null);
	}

	private createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: HubExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) {
			return Promise.resolve(defaultValue);
		}

		const id = crypto.randomUUID();
		const targetClientId = this.getTurnOriginClientId();
		if (!targetClientId) {
			return Promise.resolve(defaultValue);
		}

		return new Promise((resolve) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				this.pending.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			this.pending.set(id, {
				targetClientId,
				resolve: (response) => {
					cleanup();
					resolve(parseResponse(response));
				},
			});

			this.broadcast({ type: "extension_ui_request", id, ...request } as HubExtensionUIRequest, targetClientId);
		});
	}
}
