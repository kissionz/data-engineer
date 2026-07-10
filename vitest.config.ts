import { defineConfig } from "vitest/config";

const coverageThresholds = process.platform === "win32"
  ? {
      // Windows skips Unix-only permission, symlink, and process tests. Keep a
      // dedicated floor so those intentional skips do not make CI fail.
      statements: 75,
      branches: 66,
      functions: 81,
      lines: 75,
    }
  : {
      statements: 76,
      branches: 67,
      functions: 81,
      lines: 77,
    };

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
      thresholds: coverageThresholds,
    },
  },
});
