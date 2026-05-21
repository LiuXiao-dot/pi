import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FauxProviderRegistration } from "@earendil-works/pi-ai";
import {
	AuthStorage,
	type CreateAgentSessionResult,
	createAgentSession,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export async function createTestAgentSession(
	tempDir: string,
	faux: FauxProviderRegistration,
): Promise<CreateAgentSessionResult> {
	const agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });

	const model = faux.getModel();
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	authStorage.setRuntimeApiKey(model.provider, "faux-key");

	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((m) => ({
			id: m.id,
			name: m.name,
			api: m.api,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			baseUrl: m.baseUrl,
		})),
	});

	return createAgentSession({
		cwd: tempDir,
		agentDir,
		authStorage,
		modelRegistry,
		sessionManager: SessionManager.inMemory(tempDir),
		settingsManager: SettingsManager.inMemory(),
		model,
		noTools: "all",
	});
}
