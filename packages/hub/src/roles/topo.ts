import type { TaskPlanTask } from "./types.ts";

export interface ExecutionBatch {
	tasks: TaskPlanTask[];
}

/** Group tasks into batches by dependsOn (role names). Unknown deps are ignored for ordering. */
export function planExecutionBatches(tasks: TaskPlanTask[]): ExecutionBatch[] {
	if (tasks.length === 0) {
		return [];
	}

	const taskByRole = new Map<string, TaskPlanTask>();
	for (const task of tasks) {
		taskByRole.set(task.role, task);
	}

	const remaining = new Set(tasks.map((t) => t.role));
	const completed = new Set<string>();
	const batches: ExecutionBatch[] = [];

	while (remaining.size > 0) {
		const batch: TaskPlanTask[] = [];
		for (const role of remaining) {
			const task = taskByRole.get(role)!;
			const deps = task.dependsOn ?? [];
			const ready = deps.every((dep) => completed.has(dep) || !taskByRole.has(dep));
			if (ready) {
				batch.push(task);
			}
		}

		if (batch.length === 0) {
			// Cycle or missing deps: run all remaining in one batch
			for (const role of remaining) {
				batch.push(taskByRole.get(role)!);
			}
		}

		for (const task of batch) {
			remaining.delete(task.role);
			completed.add(task.role);
		}
		batches.push({ tasks: batch });
	}

	return batches;
}
