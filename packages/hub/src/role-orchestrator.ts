import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ResolvedHubRolesConfig } from "./config.ts";
import { formatUserMentionPrefix } from "./mentions.ts";
import { applyRoleModelOverrides } from "./models-config.ts";
import { discoverRoles, formatRoomRosterForPm, getRoleByName } from "./roles/discovery.ts";
import { parseTaskPlan } from "./roles/parse-plan.ts";
import { type ResolvedRoleConfig, resolveRoleForRoom } from "./roles/resolve-config.ts";
import { buildRoomContextPrefix } from "./roles/room-context.ts";
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
import type { RoomConfigFile, RoomRegistry } from "./room-registry.ts";

export type RoleOrchestratorBroadcast = (message: RolePlanEvent | RoleGapEvent | RoleProgressEvent) => void;

export interface RoleOrchestratorRunOptions {
	/** Role names from @mentions in the user message (room-assigned only). */
	mentionedRoles: string[];
	mentionedUsers?: string[];
}

export interface RoleOrchestratorOptions {
	session: AgentSession;
	cwd: string;
	roomId: string;
	registry: RoomRegistry;
	rolesConfig: ResolvedHubRolesConfig;
	getRoomConfig: () => RoomConfigFile;
	onBroadcast: RoleOrchestratorBroadcast;
	agentDir?: string;
	getRoleModelOverrides: () => Record<string, string>;
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

function buildPmPrompt(userMessage: string, roomRoster: string, pmRoleName: string): string {
	return `You are the coordinator role "${pmRoleName}" for this room only.

You do NOT have access to a global role library. The roster below is the complete list of worker roles currently assigned to THIS room. Assign tasks only to those role names using each entry's Who / Can do / When to decide fit.

User request:
${userMessage}

Room worker roster (assign tasks only to these roles):
${roomRoster}

Respond with a single JSON object only (no markdown fences), matching this schema:
{"summary":"...","tasks":[{"role":"roleName","task":"...","dependsOn":["otherRole"]}],"uncovered":[{"description":"...","reason":"..."}]}

Rules:
- Only assign to role names listed in the room roster above (not "${pmRoleName}" unless you are also listed as a worker).
- Match tasks to each role's Can do and When to assign; do not assign work a role cannot or should not handle.
- Put work no roster role can handle in uncovered with a clear reason.
- Use dependsOn only when a task needs another role's output first.`;
}

function buildSynthesisPrompt(userMessage: string, plan: TaskPlan, results: RoleTaskResult[]): string {
	const sections = results.map((r) => {
		const status = r.exitCode === 0 ? "completed" : "failed";
		return `### Role: ${r.role} (${status})\nTask: ${r.task}\n\n${r.output}`;
	});
	return `[Orchestrated multi-role run — respond to the user in one cohesive assistant message.]\n\nOriginal user request:\n${userMessage}\n\nPM summary: ${plan.summary}\n\nRole outputs:\n\n${sections.join("\n\n---\n\n")}`;
}

function combineContextPrefix(...parts: (string | undefined)[]): string | undefined {
	const merged = parts.filter((p) => p && p.trim().length > 0) as string[];
	return merged.length > 0 ? merged.join("\n\n") : undefined;
}

export class RoleOrchestrator {
	private readonly session: AgentSession;
	private readonly cwd: string;
	private readonly roomId: string;
	private readonly registry: RoomRegistry;
	private readonly rolesConfig: ResolvedHubRolesConfig;
	private readonly getRoomConfig: () => RoomConfigFile;
	private readonly onBroadcast: RoleOrchestratorBroadcast;
	private readonly agentDir: string;
	private readonly getRoleModelOverrides: () => Record<string, string>;
	private readonly runRole: typeof runRoleSubprocess;

	constructor(options: RoleOrchestratorOptions) {
		this.session = options.session;
		this.cwd = options.cwd;
		this.roomId = options.roomId;
		this.registry = options.registry;
		this.rolesConfig = options.rolesConfig;
		this.getRoomConfig = options.getRoomConfig;
		this.onBroadcast = options.onBroadcast;
		this.agentDir = options.agentDir ?? getAgentDir();
		this.getRoleModelOverrides = options.getRoleModelOverrides;
		this.runRole = options.runRole ?? runRoleSubprocess;
	}

	private roomSkillsDir(): string {
		return this.registry.getRoomSkillsDir(this.roomId);
	}

	private discoverConfiguredRoles(): { roles: ResolvedRoleConfig[] } {
		const roomConfig = this.getRoomConfig();
		const assigned = roomConfig.roleNames ?? [];
		if (assigned.length === 0) {
			return { roles: [] };
		}
		const assignedSet = new Set(assigned);
		const discovery = discoverRoles({
			cwd: this.cwd,
			rolesDir: this.rolesConfig.rolesDir,
			agentDir: this.agentDir,
		});
		const filtered = discovery.roles.filter((r) => assignedSet.has(r.name));
		const withModels = applyRoleModelOverrides(filtered, this.getRoleModelOverrides());
		return {
			roles: withModels.map((r) => resolveRoleForRoom(r, roomConfig, this.cwd)),
		};
	}

	isReady(): boolean {
		const roomConfig = this.getRoomConfig();
		const assigned = roomConfig.roleNames ?? [];
		if (assigned.length === 0) {
			return false;
		}
		const discovery = this.discoverConfiguredRoles();
		const pmRoleName = this.rolesConfig.pmRole;
		const hasWorker = discovery.roles.some((r) => r.name !== pmRoleName);
		return discovery.roles.length > 0 && hasWorker;
	}

	private async recordRoleMessage(
		customType: string,
		content: string,
		details?: Record<string, unknown>,
	): Promise<void> {
		await this.session.sendCustomMessage(
			{
				customType,
				content,
				display: true,
				details,
			},
			{ triggerTurn: false },
		);
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

	async run(userMessage: string, signal?: AbortSignal, options?: RoleOrchestratorRunOptions): Promise<void> {
		const mentionedRoles = options?.mentionedRoles ?? [];
		const userPrefix = formatUserMentionPrefix(options?.mentionedUsers ?? []);
		const persistedText = userPrefix ? `${userPrefix}${userMessage}` : userMessage;
		this.persistUserMessage(persistedText);

		const discovery = this.discoverConfiguredRoles();
		const roomContext = buildRoomContextPrefix(this.session);

		const mentionedSet = new Set(mentionedRoles);
		const pmRoleName = this.rolesConfig.pmRole;
		const pmRole = getRoleByName(discovery.roles, pmRoleName);
		const allWorkerRoles = discovery.roles.filter((r) => r.name !== pmRoleName);
		const mentionedWorkers = allWorkerRoles.filter((r) => mentionedSet.has(r.name));
		const invokePm = mentionedSet.has(pmRoleName) && pmRole !== undefined;

		if (invokePm && pmRole) {
			// === PM mode: PM plans, workers execute (roster scoped to @mentioned workers when any) ===
			const rosterWorkers = mentionedWorkers.length > 0 ? mentionedWorkers : allWorkerRoles;
			const roomRoster = formatRoomRosterForPm(rosterWorkers);
			const allowedWorkers = new Set(rosterWorkers.map((r) => r.name));

			const pmResult = await this.runRole({
				role: pmRole,
				task: buildPmPrompt(userMessage, roomRoster, this.rolesConfig.pmRole),
				cwd: this.cwd,
				agentDir: this.agentDir,
				contextPrefix: roomContext,
				signal,
				roomSkillsDir: this.roomSkillsDir(),
			});

			if (pmResult.exitCode !== 0) {
				const detail = pmResult.errorMessage ?? pmResult.stderr ?? pmResult.output;
				throw new Error(`PM subprocess failed (exit ${pmResult.exitCode}): ${detail}`);
			}

			const plan = parseTaskPlan(pmResult.output);
			this.onBroadcast({ type: "role_plan", plan });

			const planSummary = `PM plan: ${plan.summary}\nTasks: ${plan.tasks.map((t) => `${t.role}: ${t.task}`).join("; ")}`;
			await this.recordRoleMessage("hub_role_plan", planSummary, { plan });

			const allGaps: TaskPlanGap[] = [...plan.uncovered];
			const roleMap = new Map(rosterWorkers.map((r) => [r.name, r]));

			const executableTasks = [];
			for (const task of plan.tasks) {
				if (task.role === pmRoleName) continue;
				if (!roleMap.has(task.role)) {
					allGaps.push({ description: task.task, reason: `No role named "${task.role}"` });
					continue;
				}
				if (!allowedWorkers.has(task.role)) {
					allGaps.push({
						description: task.task,
						reason: `Role "${task.role}" was not @mentioned in the request`,
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
				const batchResults = await mapWithConcurrencyLimit(
					batch.tasks,
					this.rolesConfig.maxParallel,
					async (task) => {
						const taskId = crypto.randomUUID();
						const role = roleMap.get(task.role)!;

						this.onBroadcast({ type: "role_progress", role: task.role, taskId, phase: "started" });

						const contextParts: string[] = [];
						if (roomContext) contextParts.push(roomContext);
						for (const dep of task.dependsOn ?? []) {
							const prior = outputsByRole.get(dep);
							if (prior) contextParts.push(`Output from role "${dep}":\n${prior}`);
						}
						const contextPrefix = combineContextPrefix(...contextParts);

						const runResult = await this.runRole({
							role,
							task: task.task,
							cwd: this.cwd,
							agentDir: this.agentDir,
							contextPrefix,
							signal,
							roomSkillsDir: this.roomSkillsDir(),
						});

						const failed = runResult.exitCode !== 0;
						const preview =
							runResult.output.length > 200 ? `${runResult.output.slice(0, 200)}...` : runResult.output;

						this.onBroadcast({
							type: "role_progress",
							role: task.role,
							taskId,
							phase: failed ? "failed" : "done",
							preview,
							fullOutput: runResult.output,
						});

						const statusLabel = failed ? "failed" : "completed";
						await this.recordRoleMessage(
							"hub_role_output",
							`[${role.name}] (${statusLabel})\nTask: ${task.task}\n\n${runResult.output}`,
							{ role: role.name, taskId, task: task.task, exitCode: runResult.exitCode },
						);

						if (!failed) outputsByRole.set(task.role, runResult.output);

						return {
							role: task.role,
							task: task.task,
							taskId,
							exitCode: runResult.exitCode,
							output: runResult.output,
							errorMessage: runResult.errorMessage,
						} satisfies RoleTaskResult;
					},
				);
				results.push(...batchResults);
			}

			const synthesisMessage = buildSynthesisPrompt(persistedText, plan, results);
			await this.session.prompt(synthesisMessage, { source: "rpc" });
		} else if (mentionedWorkers.length > 0) {
			// === Direct mode: each @mentioned worker role runs independently ===
			const results: RoleTaskResult[] = [];

			for (const role of mentionedWorkers) {
				const taskId = crypto.randomUUID();

				this.onBroadcast({ type: "role_progress", role: role.name, taskId, phase: "started" });

				const runResult = await this.runRole({
					role,
					task: userMessage,
					cwd: this.cwd,
					agentDir: this.agentDir,
					contextPrefix: roomContext,
					signal,
					roomSkillsDir: this.roomSkillsDir(),
				});

				const failed = runResult.exitCode !== 0;
				const preview = runResult.output.length > 200 ? `${runResult.output.slice(0, 200)}...` : runResult.output;

				this.onBroadcast({
					type: "role_progress",
					role: role.name,
					taskId,
					phase: failed ? "failed" : "done",
					preview,
					fullOutput: runResult.output,
				});

				const statusLabel = failed ? "failed" : "completed";
				await this.recordRoleMessage("hub_role_output", `[${role.name}] (${statusLabel})\n\n${runResult.output}`, {
					role: role.name,
					taskId,
					exitCode: runResult.exitCode,
				});

				results.push({
					role: role.name,
					task: userMessage,
					taskId,
					exitCode: runResult.exitCode,
					output: runResult.output,
					errorMessage: runResult.errorMessage,
				} satisfies RoleTaskResult);
			}

			if (results.length === 1) {
				const r = results[0]!;
				if (r.exitCode === 0) {
					await this.session.prompt(r.output, { source: "rpc" });
				}
			} else {
				const sections = results.map(
					(r) => `### Role: ${r.role} (${r.exitCode === 0 ? "completed" : "failed"})\n\n${r.output}`,
				);
				const combined = `[Multi-role direct responses]\n\nOriginal request:\n${persistedText}\n\n${sections.join("\n\n---\n\n")}`;
				await this.session.prompt(combined, { source: "rpc" });
			}
		}
	}
}
