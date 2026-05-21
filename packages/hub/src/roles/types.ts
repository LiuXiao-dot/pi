/** Role definition loaded from markdown frontmatter. */
export interface RoleConfig {
	name: string;
	/** Short summary (required). */
	description: string;
	/** Who this role is (optional; shown to PM for assignment). */
	who?: string;
	/** What this role can do (optional). */
	can?: string;
	/** When the PM should assign work to this role (optional). */
	when?: string;
	model?: string;
	tools?: string[];
	skills?: string[];
	/** Path to rules file (relative to cwd) or undefined to use markdown body. */
	rulesPath?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface TaskPlanTask {
	role: string;
	task: string;
	dependsOn?: string[];
}

export interface TaskPlanGap {
	description: string;
	reason: string;
}

export interface TaskPlan {
	summary: string;
	tasks: TaskPlanTask[];
	uncovered: TaskPlanGap[];
}

export interface RoleTaskResult {
	role: string;
	task: string;
	taskId: string;
	exitCode: number;
	output: string;
	errorMessage?: string;
}

export type RoleProgressPhase = "started" | "done" | "failed";

export interface RoleProgressEvent {
	type: "role_progress";
	role: string;
	taskId: string;
	phase: RoleProgressPhase;
	preview?: string;
	fullOutput?: string;
}

export interface RolePlanEvent {
	type: "role_plan";
	plan: TaskPlan;
}

export interface RoleGapEvent {
	type: "role_gap";
	uncovered: TaskPlanGap[];
}
