import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/cli/interactiveSession.ts",
        "src/cli/telemetryReport.ts",
        "src/cli/worktreeReport.ts",
        "src/eval/liveCli.ts",
      ],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 76,
        branches: 67,
        functions: 81,
        lines: 77,
      },
    },
  },
});
