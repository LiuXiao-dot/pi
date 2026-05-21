import { existsSync } from "node:fs";
import * as path from "node:path";

export interface PiInvocation {
	command: string;
	args: string[];
}

/** Walk up from startDir until packages/coding-agent/dist/cli.js exists. */
export function findMonorepoRoot(startDir = process.cwd()): string | undefined {
	let dir = startDir;
	for (let i = 0; i < 10; i++) {
		const piCli = path.join(dir, "packages", "coding-agent", "dist", "cli.js");
		if (existsSync(piCli)) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	return undefined;
}

function monorepoPiCli(startDir = process.cwd()): string | undefined {
	const root = findMonorepoRoot(startDir);
	if (!root) {
		return undefined;
	}
	const piCli = path.join(root, "packages", "coding-agent", "dist", "cli.js");
	return existsSync(piCli) ? piCli : undefined;
}

export function getPiInvocation(roleArgs: string[]): PiInvocation {
	const cliScript = process.env.PI_CLI_SCRIPT?.trim();
	if (cliScript && existsSync(cliScript)) {
		return { command: process.execPath, args: [cliScript, ...roleArgs] };
	}

	const monorepoCli = monorepoPiCli(process.cwd());
	if (monorepoCli) {
		return { command: process.execPath, args: [monorepoCli, ...roleArgs] };
	}

	const envPi = process.env.PI_COMMAND?.trim();
	if (envPi) {
		if (envPi.includes(" ")) {
			console.warn(
				"[pi-hub] PI_COMMAND must be a single executable path; set PI_CLI_SCRIPT to the pi cli.js path instead.",
			);
		} else {
			return { command: envPi, args: roleArgs };
		}
	}

	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...roleArgs] };
	}

	return { command: "pi", args: roleArgs };
}
