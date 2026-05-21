import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { getPiInvocation } from "./pi-invocation.ts";
import type { ResolvedRoleConfig } from "./resolve-config.ts";
import { resolveSkillPaths } from "./resolve-skills.ts";
import type { RoleConfig } from "./types.ts";

export interface RunRoleOptions {
	role: RoleConfig | ResolvedRoleConfig;
	task: string;
	cwd: string;
	agentDir: string;
	/** Injected into the user prompt (e.g. outputs from dependency roles). */
	contextPrefix?: string;
	signal?: AbortSignal;
	roomSkillsDir?: string;
}

export interface RunRoleResult {
	exitCode: number;
	output: string;
	stderr: string;
	errorMessage?: string;
}

function getFinalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") {
					return part.text;
				}
			}
		}
	}
	return "";
}

function writeTempPromptFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = mkdtempSync(path.join(os.tmpdir(), "pi-hub-role-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

function resolveAppendSystemPrompt(role: RoleConfig | ResolvedRoleConfig): string {
	if ("resolvedRulesText" in role && role.resolvedRulesText) {
		return role.resolvedRulesText;
	}
	if (role.rulesPath && existsSync(role.rulesPath)) {
		try {
			return readFileSync(role.rulesPath, "utf-8").trim();
		} catch {
			// fall through
		}
	}
	return role.systemPrompt;
}

export async function runRoleSubprocess(options: RunRoleOptions): Promise<RunRoleResult> {
	const { role, task, cwd, agentDir, contextPrefix, signal, roomSkillsDir } = options;

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (role.model) {
		args.push("--model", role.model);
	}
	if (role.tools && role.tools.length > 0) {
		args.push("--tools", role.tools.join(","));
	}

	const skillNames = "resolvedSkills" in role && role.resolvedSkills ? role.resolvedSkills : role.skills;
	const skillPaths = skillNames ? resolveSkillPaths(cwd, agentDir, skillNames, roomSkillsDir) : [];
	for (const skillPath of skillPaths) {
		args.push("--skill", skillPath);
	}

	const tmpPromptDir: string | null = null;
	const tmpPromptPath: string | null = null;
	let tmpAppendDir: string | null = null;
	let tmpAppendPath: string | null = null;

	const messages: Message[] = [];
	let stderr = "";
	let errorMessage: string | undefined;

	try {
		const appendText = resolveAppendSystemPrompt(role);
		if (appendText) {
			const tmp = writeTempPromptFile(`${role.name}-rules`, appendText);
			tmpAppendDir = tmp.dir;
			tmpAppendPath = tmp.filePath;
			args.push("--append-system-prompt", tmpAppendPath);
		}

		const userTask = contextPrefix ? `${contextPrefix}\n\nTask: ${task}` : `Task: ${task}`;
		args.push(userTask);

		const invocation = getPiInvocation(args);
		const modelLabel = role.model?.trim() || "(session default)";
		console.log(`[pi-hub] Role "${role.name}" subprocess model=${modelLabel}`);

		const exitCode = await new Promise<number>((resolve, reject) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: { type?: string; message?: Message };
				try {
					event = JSON.parse(line) as { type?: string; message?: Message };
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					messages.push(event.message);
					if (event.message.role === "assistant") {
						if (event.message.errorMessage) {
							errorMessage = event.message.errorMessage;
						}
					}
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					processLine(line);
				}
			});

			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					processLine(buffer);
				}
				resolve(code ?? 0);
			});

			proc.on("error", (err) => {
				const detail = err instanceof Error ? err.message : String(err);
				reject(
					new Error(
						`Role "${role.name}" failed to start (model=${modelLabel}): ${detail}. Command: ${invocation.command}`,
					),
				);
			});

			if (signal) {
				const killProc = () => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) {
							proc.kill("SIGKILL");
						}
					}, 5000);
				};
				if (signal.aborted) {
					killProc();
				} else {
					signal.addEventListener("abort", killProc, { once: true });
				}
			}
		});

		const output = getFinalAssistantText(messages) || stderr || "(no output)";
		return {
			exitCode,
			output,
			stderr,
			errorMessage,
		};
	} finally {
		if (tmpAppendPath) {
			try {
				rmSync(tmpAppendPath, { force: true });
			} catch {
				/* ignore */
			}
		}
		if (tmpAppendDir) {
			try {
				rmSync(tmpAppendDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
		if (tmpPromptPath) {
			try {
				rmSync(tmpPromptPath, { force: true });
			} catch {
				/* ignore */
			}
		}
		if (tmpPromptDir) {
			try {
				rmSync(tmpPromptDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}
}
