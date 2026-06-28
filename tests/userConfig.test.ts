import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultUserConfigPath,
  loadUserConfig,
} from "../src/config/userConfig.js";

describe("user config", () => {
  it("returns safe defaults when the file is absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-config-"));

    await expect(loadUserConfig(path.join(root, "missing.json"))).resolves.toEqual({
      version: 1,
      mcpServers: [],
    });
    expect(defaultUserConfigPath(root)).toBe(
      path.join(root, ".harness", "config.json"),
    );
  });

  it("loads strict model, budget, memory, and MCP settings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-config-"));
    const configPath = path.join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        model: {
          provider: "openai",
          name: "production-model",
          baseUrl: "https://gateway.example/v1",
          pricing: {
            inputPerMillionTokens: 1.5,
            outputPerMillionTokens: 6,
            cacheReadPerMillionTokens: 0.75,
          },
        },
        budget: {
          maxTurns: 25,
          maxToolCalls: 40,
          maxEstimatedCostUsd: 2,
        },
        memory: { enabled: false },
        mcpServers: [
          {
            id: "local_docs",
            transport: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
              envAllowlist: ["DOCS_TOKEN"],
            },
          },
          {
            id: "remote",
            transport: {
              type: "http",
              url: "https://mcp.example/api",
              allowedHosts: ["mcp.example"],
              tokenEnv: "MCP_TOKEN",
            },
          },
        ],
      }),
      "utf8",
    );

    await expect(loadUserConfig(configPath)).resolves.toMatchObject({
      model: {
        name: "production-model",
        pricing: { inputPerMillionTokens: 1.5 },
      },
      budget: {
        maxTurns: 25,
        maxToolCalls: 40,
        maxEstimatedCostUsd: 2,
      },
      memory: { enabled: false },
      mcpServers: [
        {
          id: "local_docs",
          enabled: true,
          timeoutMs: 30_000,
          maxTools: 64,
        },
        { id: "remote" },
      ],
    });
  });

  it.each([
    [{ extra: true }, "Unrecognized key"],
    [
      {
        budget: { maxEstimatedCostUsd: 1 },
      },
      "requires non-zero model pricing",
    ],
    [
      {
        mcpServers: [
          {
            id: "../escape",
            transport: { type: "stdio", command: "node" },
          },
        ],
      },
      "mcpServers",
    ],
    [
      {
        mcpServers: [
          {
            id: "remote",
            transport: {
              type: "http",
              url: "https://mcp.example",
              allowedHosts: [],
            },
          },
        ],
      },
      "allowedHosts",
    ],
    [
      {
        mcpServers: [
          {
            id: "insecure",
            transport: {
              type: "http",
              url: "http://mcp.example",
              allowedHosts: ["mcp.example"],
            },
          },
        ],
      },
      "must use HTTPS",
    ],
    [
      {
        mcpServers: [
          {
            id: "redirect",
            transport: {
              type: "http",
              url: "https://mcp.example",
              allowedHosts: ["other.example"],
            },
          },
        ],
      },
      "exact allowedHosts",
    ],
    [
      {
        mcpServers: [
          {
            id: "relative",
            transport: {
              type: "stdio",
              command: "node",
              cwd: "./project",
            },
          },
        ],
      },
      "cwd must be absolute",
    ],
  ])("rejects unsafe or unknown config %#", async (config, expected) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-config-"));
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify(config), "utf8");

    await expect(loadUserConfig(configPath)).rejects.toThrow(expected);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked config",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "harness-config-"));
      const target = path.join(root, "target.json");
      const linked = path.join(root, "linked.json");
      await writeFile(target, "{}", "utf8");
      await symlink(target, linked);

      await expect(loadUserConfig(linked)).rejects.toThrow("symbolic link");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a config writable by group or others",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "harness-config-"));
      const configPath = path.join(root, "config.json");
      await writeFile(configPath, "{}", "utf8");
      await chmod(configPath, 0o666);

      await expect(loadUserConfig(configPath)).rejects.toThrow(
        "must not be writable",
      );
    },
  );
});
