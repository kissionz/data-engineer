export interface PermissionPolicy {
  allowedTools: Set<string>;
  deniedTools: Set<string>;
  allowReadonly: boolean;
  askForBash: boolean;
  askForWrite: boolean;
  deniedPathPrefixes: string[];
  deniedCommandFragments: string[];
}

export function defaultPolicy(): PermissionPolicy {
  return {
    allowedTools: new Set([
      "Read",
      "ListDirectory",
      "Grep",
      "Glob",
      "Write",
      "GitStatus",
      "GitDiff",
      "TodoRead",
      "TodoWrite",
      "SkillList",
      "SkillLoad",
      "MemorySearch",
      "Task",
      "EphemeralTask",
    ]),
    deniedTools: new Set(),
    allowReadonly: true,
    askForBash: true,
    askForWrite: true,
    deniedPathPrefixes: [
      ".git",
      ".env",
      "node_modules",
      ".harness/permissions",
    ],
    deniedCommandFragments: [
      "rm -rf /",
      "rm -rf ~",
      "rm -rf .",
      "sudo ",
      "chmod -R 777",
      "curl | sh",
      "wget | sh",
      "cat ~/.ssh",
      "cat ~/.aws",
    ],
  };
}
