import {
  mkdir,
  mkdtemp,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_SUBAGENT_SPEC_BYTES,
  SubagentSpecLoader,
} from "../src/subagents/loader.js";

describe("SubagentSpecLoader", () => {
  it("keeps the built-in reviewer when no project specs exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-agents-"));
    expect(new SubagentSpecLoader(root).loadAll().map(({ name }) => name))
      .toEqual(["code-reviewer"]);
  });

  it("loads a strict bounded read-only agent spec", async () => {
    const root = await makeAgentsRoot();
    await writeFile(
      path.join(root, ".harness", "agents", "test-analyst.yaml"),
      validSpec(),
      "utf8",
    );

    expect(new SubagentSpecLoader(root).loadAll()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "test-analyst",
          tools: ["Read", "Grep"],
          maxTurns: 4,
          maxResultChars: 3_000,
        }),
      ]),
    );
  });

  it("rejects forbidden tools, unknown fields, excessive limits, and aliases", async () => {
    const invalidCases = [
      validSpec().replace("  - Grep", "  - Bash"),
      `${validSpec()}unknownField: true\n`,
      validSpec().replace("maxTurns: 4", "maxTurns: 21"),
      validSpec().replace(
        "description: Analyze tests.",
        "description: &description Analyze tests.",
      ).replace(
        "systemPrompt: Find missing test coverage.",
        "systemPrompt: *description",
      ),
    ];

    for (const [index, source] of invalidCases.entries()) {
      const root = await makeAgentsRoot();
      await writeFile(
        path.join(root, ".harness", "agents", `agent-${index}.yaml`),
        source.replace("name: test-analyst", `name: agent-${index}`),
        "utf8",
      );
      expect(() => new SubagentSpecLoader(root).loadAll()).toThrow();
    }
  });

  it("rejects filename/name mismatches and the reserved fallback name", async () => {
    const root = await makeAgentsRoot();
    await writeFile(
      path.join(root, ".harness", "agents", "different.yaml"),
      validSpec(),
      "utf8",
    );
    expect(() => new SubagentSpecLoader(root).loadAll()).toThrow(
      /match its filename/,
    );

    const otherRoot = await makeAgentsRoot();
    await writeFile(
      path.join(otherRoot, ".harness", "agents", "code-reviewer.yaml"),
      validSpec().replace("name: test-analyst", "name: code-reviewer"),
      "utf8",
    );
    expect(() => new SubagentSpecLoader(otherRoot).loadAll()).toThrow(
      /reserved/,
    );
  });

  it("rejects symlinked directories, symlinked files, and oversized specs", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "harness-agents-out-"));
    const linkedRoot = await mkdtemp(path.join(os.tmpdir(), "harness-agents-"));
    await mkdir(path.join(linkedRoot, ".harness"), { recursive: true });
    await symlink(outside, path.join(linkedRoot, ".harness", "agents"));
    expect(() => new SubagentSpecLoader(linkedRoot).loadAll()).toThrow(
      /real directory/,
    );

    const fileRoot = await makeAgentsRoot();
    const target = path.join(fileRoot, "outside.yaml");
    await writeFile(target, validSpec(), "utf8");
    await symlink(
      target,
      path.join(fileRoot, ".harness", "agents", "linked.yaml"),
    );
    expect(() => new SubagentSpecLoader(fileRoot).loadAll()).toThrow(
      /regular file/,
    );

    const largeRoot = await makeAgentsRoot();
    await writeFile(
      path.join(largeRoot, ".harness", "agents", "large.yaml"),
      Buffer.alloc(MAX_SUBAGENT_SPEC_BYTES + 1, 0x61),
    );
    expect(() => new SubagentSpecLoader(largeRoot).loadAll()).toThrow(
      /exceeds/,
    );
  });
});

function validSpec(): string {
  return [
    "name: test-analyst",
    "description: Analyze tests.",
    "systemPrompt: Find missing test coverage.",
    "tools:",
    "  - Read",
    "  - Grep",
    "maxTurns: 4",
    "maxResultChars: 3000",
    "",
  ].join("\n");
}

async function makeAgentsRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-agents-"));
  await mkdir(path.join(root, ".harness", "agents"), { recursive: true });
  return root;
}
