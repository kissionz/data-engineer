import {
  mkdtemp,
  mkdir,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMcpConfigCommand } from "../src/cli/mcpConfig.js";
import { loadUserConfig } from "../src/config/userConfig.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP config CLI", () => {
  it("adds, lists, and removes the MaxCompute preset", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-mcp-cli-"));
    const configPath = path.join(root, ".harness", "config.json");
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
      output.push(values.map(String).join(" "));
    });

    await expect(
      runMcpConfigCommand([
        "mcp",
        "add",
        "maxcompute",
        "--yes",
        "--config",
        configPath,
      ]),
    ).resolves.toBe(true);
    await expect(loadUserConfig(configPath)).resolves.toMatchObject({
      mcpServers: [
        {
          id: "maxcompute",
          enabled: true,
          transport: {
            type: "http",
            url: "https://mcp.cn-hangzhou.maxcompute.aliyun.com/mcp",
            auth: { type: "oauth", redirectMode: "browser" },
          },
        },
      ],
    });
    if (process.platform !== "win32") {
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    }

    await runMcpConfigCommand([
      "mcp",
      "list",
      "--config",
      configPath,
    ]);
    expect(output.join("\n")).toContain("maxcompute\tenabled\toauth");
    expect(output.join("\n")).toContain(`Config: ${configPath}`);

    await runMcpConfigCommand([
      "mcp",
      "remove",
      "maxcompute",
      "--yes",
      "--config",
      configPath,
    ]);
    await expect(loadUserConfig(configPath)).resolves.toMatchObject({
      mcpServers: [],
    });
  });

  it("adds the VPC-only MaxCompute preset without a CIDR list", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-mcp-cli-"));
    const configPath = path.join(root, "config.json");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runMcpConfigCommand([
      "mcp",
      "add",
      "maxcompute",
      "--vpc",
      "--yes",
      "--config",
      configPath,
    ]);

    await expect(loadUserConfig(configPath)).resolves.toMatchObject({
      mcpServers: [
        {
          id: "maxcompute",
          transport: {
            url: "https://mcp.cn-hangzhou-vpc.maxcompute.aliyun-inc.com/mcp",
            allowedHosts: [
              "mcp.cn-hangzhou-vpc.maxcompute.aliyun-inc.com",
            ],
            network: { mode: "vpc" },
          },
        },
      ],
    });
  });

  it("adds a local MaxCompute stdio preset for a regional VPC endpoint", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-mcp-cli-"));
    const configPath = path.join(root, "config.json");
    const localServer = path.join(root, "maxcompute-mcp");
    await mkdir(localServer);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runMcpConfigCommand([
      "mcp",
      "add",
      "maxcompute-local",
      "--directory",
      localServer,
      "--yes",
      "--config",
      configPath,
    ]);

    await expect(loadUserConfig(configPath)).resolves.toMatchObject({
      mcpServers: [
        {
          id: "maxcompute",
          timeoutMs: 60_000,
          transport: {
            type: "stdio",
            command: "uv",
            args: [
              "--directory",
              localServer,
              "run",
              "alibabacloud-maxcompute-mcp-server",
            ],
            cwd: localServer,
            envAllowlist: expect.arrayContaining([
              "MAXCOMPUTE_CATALOG_CONFIG",
              "MAXCOMPUTE_ENDPOINT",
              "MAXCOMPUTE_DEFAULT_PROJECT",
              "ALIBABA_CLOUD_ACCESS_KEY_ID",
              "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
              "ALIBABA_CLOUD_CREDENTIALS_URI",
            ]),
          },
        },
      ],
    });
  });

  it("adds a non-interactive custom bearer MCP server", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-mcp-cli-"));
    const configPath = path.join(root, "config.json");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runMcpConfigCommand([
      "mcp",
      "add",
      "custom",
      "--yes",
      "--id",
      "docs",
      "--url",
      "https://mcp.example.com/mcp",
      "--auth",
      "bearer",
      "--token-env",
      "DOCS_MCP_TOKEN",
      "--config",
      configPath,
    ]);

    await expect(loadUserConfig(configPath)).resolves.toMatchObject({
      mcpServers: [
        {
          id: "docs",
          transport: {
            allowedHosts: ["mcp.example.com"],
            auth: {
              type: "bearer",
              tokenEnv: "DOCS_MCP_TOKEN",
            },
          },
        },
      ],
    });

    await expect(
      runMcpConfigCommand([
        "mcp",
        "add",
        "custom",
        "--yes",
        "--id",
        "docs",
        "--url",
        "https://replacement.example.com/mcp",
        "--auth",
        "none",
        "--config",
        configPath,
      ]),
    ).rejects.toThrow("already exists");

    await runMcpConfigCommand([
      "mcp",
      "add",
      "custom",
      "--yes",
      "--force",
      "--id",
      "docs",
      "--url",
      "https://replacement.example.com/mcp",
      "--auth",
      "none",
      "--config",
      configPath,
    ]);
    await expect(loadUserConfig(configPath)).resolves.toMatchObject({
      mcpServers: [
        {
          id: "docs",
          transport: {
            allowedHosts: ["replacement.example.com"],
            auth: { type: "none" },
          },
        },
      ],
    });
  });

  it("adds a custom OAuth server with explicit callback settings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-mcp-cli-"));
    const configPath = path.join(root, "config.json");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runMcpConfigCommand([
      "mcp",
      "add",
      "custom",
      "--yes",
      "--id",
      "warehouse",
      "--url",
      "https://warehouse.example.com/mcp",
      "--auth",
      "oauth",
      "--callback-port",
      "34567",
      "--manual",
      "--config",
      configPath,
    ]);

    await expect(loadUserConfig(configPath)).resolves.toMatchObject({
      mcpServers: [
        {
          id: "warehouse",
          transport: {
            auth: {
              type: "oauth",
              redirectMode: "manual",
              callbackPort: 34_567,
            },
          },
        },
      ],
    });
  });

  it("lists an empty config and reports missing removals", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-mcp-cli-"));
    const configPath = path.join(root, "missing.json");
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
      output.push(values.map(String).join(" "));
    });

    await runMcpConfigCommand(["mcp", "list", "--config", configPath]);
    expect(output).toContain("[No MCP servers configured]");
    await expect(
      runMcpConfigCommand([
        "mcp",
        "remove",
        "missing",
        "--yes",
        "--config",
        configPath,
      ]),
    ).rejects.toThrow("MCP server not found");
  });

  it("ignores ordinary harness arguments", async () => {
    await expect(
      runMcpConfigCommand(["--task", "hello"]),
    ).resolves.toBe(false);
  });
});
