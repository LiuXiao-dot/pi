import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const smokeScript = join(hubRoot, "dist", "run-ws-smoke.js");

describe("hub websocket collaboration", () => {
	it("serializes prompts from two clients", () => {
		if (!existsSync(smokeScript)) {
			const build = spawnSync("npm", ["run", "build"], {
				cwd: hubRoot,
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			expect(build.status).toBe(0);
		}

		const result = spawnSync(process.execPath, [smokeScript], {
			cwd: hubRoot,
			stdio: "inherit",
			env: process.env,
		});
		expect(result.status).toBe(0);
	}, 180_000);
});
