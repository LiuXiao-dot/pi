import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ResolvedHubRolesConfig } from "./config.ts";
import { applyRoleModelOverrides } from "./models-config.ts";
import { discoverRoles, formatRoleCatalog, getRoleByName } from "./roles/discovery.ts";
import { parseTaskPlan } from "./roles/parse-plan.ts";
import { runRoleSubprocess } from "./roles/runner.ts";
import { planExecutionBatches } from "./roles/topo.ts";
import type {
	RoleGapEvent,
	RolePlanEvent,
	RoleProgressEvent,
	RoleTaskResult,
	TaskPlan,
	TaskPlanGap,
} from "./roles/types.ts";

export type RoleOrchestratorBroadcast = (message: RolePlanEvent | RoleGapEvent | RoleProgressEvent) => void;

export interface RoleOrchestratorOptions {
	session: AgentSession;
	cwd: string;
	rolesConfig: ResolvedHubRolesConfig;
	onBroadcast: RoleOrchestratorBroadcast;
	agentDir?: string;
	/** Hub.json + runtime overrides for role subprocess models. */
	getRoleModelOverrides: () => Record<string, string>;
	/** Test hook: replace subprocess runner. */
	runRole?: typeof runRoleSubprocess;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) {
		return [];
	}
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) {
				return;
			}
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

function buildPmPrompt(userMessage: string, catalog: string): string {
	return `User request:\n${userMessage}\n\nAvailable roles (do not assign work outside these roles):\n${catalog}\n\nRespond with a single JSON object only (no markdown), matching this schema:\n{"summary":"...","tasks":[{"role":"roleName","task":"...","dependsOn":["otherRole"]}],"uncovered":[{"description":"...","reason":"..."}]}\n\nPut work that no role can handle in uncovered. Use dependsOn only when a task needs another role's output first.`;
}

function buildSynthesisPrompt(userMessage: string, plan: TaskPlan, results: RoleTaskResult[]): string {
	const sections = results.map((r) => {
		const status = r.exitCode === 0 ? "completed" : "failed";
		return `### Role: ${r.role} (${status})\nTask: ${r.task}\n\n${r.output}`;
	});
	return `[Orchestrated multi-role run — respond to the user in one cohesive assistant message.]\n\nOriginal user request:\n${userMessage}\n\nPM summary: ${plan.summary}\n\nRole outputs:\n\n${sections.join("\n\n---\n\n")}`;
}

export class RoleOrchestrator {
	private readonly session: AgentSession;
	private readonly cwd: string;
	private readonly rolesConfig: ResolvedHubRolesConfig;
	private readonly onBroadcast: RoleOrchestratorBroadcast;
	private readonly agentDir: string;
	private readonly getRoleModelOverrides: () => Record<string, string>;
	private readonly runRole: typeof runRoleSubprocess;

	constructor(options: RoleOrchestratorOptions) {
		this.session = options.session;
		this.cwd = options.cwd;
		this.rolesConfig = options.rolesConfig;
		this.onBroadcast = options.onBroadcast;
		this.agentDir = options.agentDir ?? getAgentDir();
		this.getRoleModelOverrides = options.getRoleModelOverrides;
		this.runRole = options.runRole ?? runRoleSubprocess;
	}

	private discoverConfiguredRoles() {
		const discovery = discoverRoles({
			cwd: this.cwd,
			rolesDir: this.rolesConfig.rolesDir,
			agentDir: this.agentDir,
		});
		return {
			...discovery,
			roles: applyRoleModelOverrides(discovery.roles, this.getRoleModelOverrides()),
		};
	}

	/** Returns false when roles are misconfigured and caller should use direct prompt. */
	isReady(): boolean {
		const discovery = this.discoverConfiguredRoles();
		const pm = getRoleByName(discovery.roles, this.rolesConfig.pmRole);
		if (!pm) {
			console.warn(
				`[pi-hub] roles.enabled but PM role "${this.rolesConfig.pmRole}" not found; falling back to direct prompt`,
			);
			return false;
		}
		const workers = discovery.roles.filter((r) => r.name !== this.rolesConfig.pmRole);
		if (workers.length === 0) {
			console.warn("[pi-hub] roles.enabled but no worker roles found; falling back to direct prompt");
			return false;
		}
		return true;
	}

	private persistUserMessage(text: string): void {
		this.session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		});
		const sessionContext = this.session.sessionManager.buildSessionContext();
		this.session.agent.state.messages = sessionContext.messages;
	}

	async run(userMessage: string, signal?: AbortSignal): Promise<void> {
		this.persistUserMessage(userMessage);

		const discovery = this.discoverConfiguredRoles();

		const pmRole = getRoleByName(discovery.roles, this.rolesConfig.pmRole);
		if (!pmRole) {
			throw new Error(`PM role "${this.rolesConfig.pmRole}" not found`);
		}

		const workerRoles = discovery.roles.filter((r) => r.name !== this.rolesConfig.pmRole);
		const catalog = formatRoleCatalog(workerRoles);

		const pmResult = await this.runRole({
			role: pmRole,
			task: buildPmPrompt(userMessage, catalog),
			cwd: this.cwd,
			agentDir: this.agentDir,
			signal,
		});

		if (pmResult.exitCode !== 0) {
			const detail = pmResult.errorMessage ?? pmResult.stderr ?? pmResult.output;
			throw new Error(`PM subprocess failed (exit ${pmResult.exitCode}): ${detail}`);
		}

		const plan = parseTaskPlan(pmResult.output);
		this.onBroadcast({ type: "role_plan", plan });

		const allGaps: TaskPlanGap[] = [...plan.uncovered];
		const roleMap = new Map(workerRoles.map((r) => [r.name, r]));

		const executableTasks = [];
		for (const task of plan.tasks) {
			if (task.role === this.rolesConfig.pmRole) {
				continue;
			}
			if (!roleMap.has(task.role)) {
				allGaps.push({
					description: task.task,
					reason: `No role named "${task.role}"`,
				});
				continue;
			}
			executableTasks.push(task);
		}

		if (allGaps.length > 0) {
			this.onBroadcast({ type: "role_gap", uncovered: allGaps });
		}

		const batches = planExecutionBatches(executableTasks);
		const results: RoleTaskResult[] = [];
		const outputsByRole = new Map<string, string>();

		for (const batch of batches) {
			const batchResults = await mapWithConcurrencyLimit(batch.tasks, this.rolesConfig.maxParallel, async (task) => {
				const taskId = crypto.randomUUID();
				const role = roleMap.get(task.role)!;

				this.onBroadcast({
					type: "role_progress",
					role: task.role,
					taskId,
					phase: "started",
				});

				const contextParts: string[] = [];
				for (const dep of task.dependsOn ?? []) {
					const prior = outputsByRole.get(dep);
					if (prior) {
						contextParts.push(`Output from role "${dep}":\n${prior}`);
					}
				}
				const contextPrefix = contextParts.length > 0 ? contextParts.join("\n\n") : undefined;

				const runResult = await this.runRole({
					role,
					task: task.task,
					cwd: this.cwd,
					agentDir: this.agentDir,
					contextPrefix,
					signal,
				});

				const failed = runResult.exitCode !== 0;
				const preview = runResult.output.length > 200 ? `${runResult.output.slice(0, 200)}...` : runResult.output;

				this.onBroadcast({
					type: "role_progress",
					role: task.role,
					taskId,
					phase: failed ? "failed" : "done",
					preview,
				});

				if (!failed) {
					outputsByRole.set(task.role, runResult.output);
				}

				return {
					role: task.role,
					task: task.task,
					taskId,
					exitCode: runResult.exitCode,
					output: runResult.output,
					errorMessage: runResult.errorMessage,
				} satisfies RoleTaskResult;
			});
			results.push(...batchResults);
		}

		const synthesisMessage = buildSynthesisPrompt(userMessage, plan, results);
		await this.session.prompt(synthesisMessage, { source: "rpc" });
	}
}
