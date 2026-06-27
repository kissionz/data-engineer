import type { CommandExecutor } from "./commandExecutor.js";
import type { SandboxConfig } from "./sandboxConfig.js";

export type DockerAvailability =
  | { available: true }
  | { available: false; reason: string };

interface DockerVersion {
  Server?: {
    Os?: string;
  } | null;
}

export class DockerAvailabilityChecker {
  constructor(private readonly executor: CommandExecutor) {}

  async check(
    workspaceRoot: string,
    config: SandboxConfig,
  ): Promise<DockerAvailability> {
    const version = await this.executor.run({
      command: "docker",
      args: ["version", "--format", "{{json .}}"],
      cwd: workspaceRoot,
      timeoutMs: 5_000,
      maxOutputChars: 20_000,
    });

    if (!version.ok) {
      return unavailable(
        `Docker daemon is unavailable: ${diagnostic(version.stderr, version.stdout)}`,
      );
    }

    let versionInfo: DockerVersion;

    try {
      versionInfo = JSON.parse(version.stdout) as DockerVersion;
    } catch {
      return unavailable("Docker returned an invalid version response.");
    }

    if (!versionInfo.Server) {
      return unavailable("Docker client is installed but no daemon is available.");
    }

    if (versionInfo.Server.Os !== "linux") {
      return unavailable("Docker must be configured for Linux containers.");
    }

    const context = await this.executor.run({
      command: "docker",
      args: [
        "context",
        "inspect",
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ],
      cwd: workspaceRoot,
      timeoutMs: 5_000,
      maxOutputChars: 2_000,
    });

    if (!context.ok) {
      return unavailable(`Unable to inspect Docker context: ${context.stderr}`);
    }

    const endpoint = parseJsonString(context.stdout.trim());

    if (!endpoint) {
      return unavailable("Docker context did not expose a local endpoint.");
    }

    if (/^(?:ssh|tcp):\/\//i.test(endpoint)) {
      return unavailable("Remote Docker contexts are not supported for workspace mounts.");
    }

    const imageAvailable = await this.ensureImage(
      workspaceRoot,
      config.image,
      config.pull,
    );

    if (!imageAvailable.available) {
      return imageAvailable;
    }

    if (workspaceRoot.includes(",")) {
      return unavailable("Workspace paths containing commas are not supported by Docker mounts.");
    }

    const probe = await this.executor.run({
      command: "docker",
      args: [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--mount",
        `type=bind,src=${workspaceRoot},dst=/workspace,readonly`,
        config.image,
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-lc",
        'test -r /workspace && printf "ready"',
      ],
      cwd: workspaceRoot,
      timeoutMs: 20_000,
      maxOutputChars: 20_000,
    });

    if (!probe.ok || probe.stdout !== "ready") {
      return unavailable(
        `Docker cannot mount the workspace or run Bash: ${diagnostic(
          probe.stderr,
          probe.stdout,
        )}`,
      );
    }

    return { available: true };
  }

  private async ensureImage(
    cwd: string,
    image: string,
    pullPolicy: SandboxConfig["pull"],
  ): Promise<DockerAvailability> {
    const inspect = await this.executor.run({
      command: "docker",
      args: ["image", "inspect", image],
      cwd,
      timeoutMs: 10_000,
      maxOutputChars: 5_000,
    });

    if (inspect.ok) {
      return { available: true };
    }

    if (pullPolicy === "never") {
      return unavailable(
        `Sandbox image is not available locally: ${image}. Use --sandbox-pull missing to fetch it.`,
      );
    }

    const pull = await this.executor.run({
      command: "docker",
      args: ["pull", image],
      cwd,
      timeoutMs: 10 * 60_000,
      maxOutputChars: 20_000,
    });

    return pull.ok
      ? { available: true }
      : unavailable(`Unable to pull sandbox image ${image}: ${pull.stderr}`);
  }
}

function unavailable(reason: string): DockerAvailability {
  return { available: false, reason };
}

function parseJsonString(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function diagnostic(primary: string, secondary: string): string {
  return (primary || secondary || "no diagnostic output").trim();
}
