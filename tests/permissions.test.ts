import { describe, expect, it } from "vitest";
import { PermissionGate } from "../src/permissions/gate.js";
import { defaultPolicy } from "../src/permissions/policy.js";

describe("PermissionGate", () => {
  it("allows readonly reads", () => {
    const gate = new PermissionGate(defaultPolicy());

    expect(
      gate.check({ id: "1", name: "Read", args: { file_path: "README.md" } }),
    ).toMatchObject({ decision: "allow" });
  });

  it("asks before editing files", () => {
    const gate = new PermissionGate(defaultPolicy());

    expect(
      gate.check({
        id: "1",
        name: "Edit",
        args: {
          file_path: "README.md",
          old_string: "a",
          new_string: "b",
        },
      }),
    ).toMatchObject({ decision: "ask" });
  });

  it("denies dangerous shell commands", () => {
    const gate = new PermissionGate(defaultPolicy());

    expect(
      gate.check({ id: "1", name: "Bash", args: { command: "rm -rf ." } }),
    ).toMatchObject({ decision: "deny" });
  });

  it("denies policy paths", () => {
    const gate = new PermissionGate(defaultPolicy());

    expect(
      gate.check({ id: "1", name: "Read", args: { file_path: ".git/config" } }),
    ).toMatchObject({ decision: "deny" });
  });
});
