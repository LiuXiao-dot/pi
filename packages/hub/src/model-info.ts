import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { filterModelsByCatalog } from "./models-config.ts";

/** Model metadata exposed to web clients (no secrets). */
export interface HubModelInfo {
	provider: string;
	id: string;
	name: string;
	baseUrl: string;
	api: string;
	hasAuth: boolean;
}

export function toHubModelInfo(model: Model<Api>, registry: ModelRegistry): HubModelInfo {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		baseUrl: model.baseUrl,
		api: model.api,
		hasAuth: registry.hasConfiguredAuth(model),
	};
}

export async function listHubModels(registry: ModelRegistry, catalog: string[] = []): Promise<HubModelInfo[]> {
	const models = await registry.getAvailable();
	const infos = models.map((m) => toHubModelInfo(m, registry));
	return filterModelsByCatalog(infos, catalog);
}
