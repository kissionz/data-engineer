import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectDoctorReport } from "../src/cli/doctor.js";
import type {
  CommandExecutor,
  CommandOptions,
  CommandResult,
} from "../src/runtime/commandExecutor.js";

describe("Montane doctor", () => {
  it("reports a ready development environment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "montane-doctor-"));
    const executor = scriptedExecutor((options) => {
      if (options.command === "git" && options.args[0] === "--version") {
        return success("git version 2.50.0\n");
      }
      if (options.command === "git") {
        return success("true\n");
      }
      if (options.command === "rg") {
        return success("ripgrep 14.1.0\n");
      }
      if (options.args[0] === "version") {
        return success("linux\n");
      }
      return success("[]\n");
    });

    const report = await collectDoctorReport(root, executor);

    expect(report).toMatchObject({ product: "Montane Code", ready: true });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Git", status: "pass" }),
        expect.objectContaining({ name: "Docker sandbox", status: "pass" }),
      ]),
    );
  });

  it("keeps optional tooling failures as actionable warnings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "montane-doctor-"));
    const report = await collectDoctorReport(
      root,
      scriptedExecutor(() => failure("not installed")),
    );

    expect(report.ready).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Git", status: "warn" }),
        expect.objectContaining({ name: "Docker sandbox", status: "warn" }),
      ]),
    );
  });

  it("fails clearly when the workspace does not exist", async () => {
    const report = await collectDoctorReport(
      path.join(os.tmpdir(), "missing-montane-workspace"),
      scriptedExecutor(() => success("unused")),
    );

    expect(report.ready).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Workspace", status: "fail" }),
      ]),
    );
  });
});

function scriptedExecutor(
  run: (options: CommandOptions) => CommandResult,
): CommandExecutor {
  return { run: async (options) => run(options) };
}

function success(stdout: string): CommandResult {
  return {
    ok: true,
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
    cancelled: false,
  };
}

function failure(stderr: string): CommandResult {
  return {
    ok: false,
    exitCode: 1,
    stdout: "",
    stderr,
    timedOut: false,
    cancelled: false,
  };
}
