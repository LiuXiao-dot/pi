import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts", "test/**/*.test.mjs"],
		testTimeout: 120_000,
		pool: "forks",
	},
});
