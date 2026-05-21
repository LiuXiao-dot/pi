import type { TaskPlan } from "./types.ts";

function isTaskPlan(value: unknown): value is TaskPlan {
	if (!value || typeof value !== "object") return false;
	const plan = value as TaskPlan;
	return typeof plan.summary === "string" && Array.isArray(plan.tasks) && Array.isArray(plan.uncovered);
}

/** Extract and parse TaskPlan JSON from PM subprocess output. */
export function parseTaskPlan(text: string): TaskPlan {
	const trimmed = text.trim();
	if (!trimmed) {
		throw new Error("PM returned empty output");
	}

	const attempts: string[] = [trimmed];

	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) {
		attempts.push(fenced[1].trim());
	}

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		attempts.push(trimmed.slice(firstBrace, lastBrace + 1));
	}

	for (const candidate of attempts) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			if (isTaskPlan(parsed)) {
				return {
					summary: parsed.summary,
					tasks: parsed.tasks.map((t) => ({
						role: String(t.role),
						task: String(t.task),
						dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : undefined,
					})),
					uncovered: parsed.uncovered.map((g) => ({
						description: String(g.description),
						reason: String(g.reason),
					})),
				};
			}
		} catch {
			// try next
		}
	}

	throw new Error("PM output did not contain valid TaskPlan JSON");
}
