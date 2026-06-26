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
    allowedTools: new Set(["Read", "Grep"]),
    deniedTools: new Set(),
    allowReadonly: true,
    askForBash: true,
    askForWrite: true,
    deniedPathPrefixes: [".git", ".git/", ".env", "node_modules", "node_modules/"],
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
