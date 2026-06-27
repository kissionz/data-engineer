import { describe, expect, it, vi } from "vitest";
import {
  restoreInputAfterApproval,
  type ApprovalFunction,
} from "../src/permissions/approval.js";

const call = {
  id: "call-1",
  name: "Edit",
  args: { path: "notes.txt", content: "done" },
};

describe("restoreInputAfterApproval", () => {
  it("restores interactive input after approval completes", async () => {
    const approve: ApprovalFunction = vi.fn().mockResolvedValue("allow_once");
    const resumeInput = vi.fn();

    const result = await restoreInputAfterApproval(approve, resumeInput)(
      call,
      "File modification requires approval.",
    );

    expect(result).toBe("allow_once");
    expect(resumeInput).toHaveBeenCalledOnce();
  });

  it("restores interactive input when approval fails", async () => {
    const approve: ApprovalFunction = vi
      .fn()
      .mockRejectedValue(new Error("prompt failed"));
    const resumeInput = vi.fn();

    await expect(
      restoreInputAfterApproval(approve, resumeInput)(
        call,
        "File modification requires approval.",
      ),
    ).rejects.toThrow("prompt failed");

    expect(resumeInput).toHaveBeenCalledOnce();
  });

  it("passes cancellation through the approval wrapper", async () => {
    const controller = new AbortController();
    const approve: ApprovalFunction = vi.fn().mockResolvedValue("reject");
    const resumeInput = vi.fn();
    const pauseInput = vi.fn();
    const wrapped = restoreInputAfterApproval(
      approve,
      resumeInput,
      pauseInput,
    );

    await wrapped(
      call,
      "File modification requires approval.",
      controller.signal,
    );

    expect(approve).toHaveBeenCalledWith(
      call,
      "File modification requires approval.",
      controller.signal,
    );
    expect(pauseInput).toHaveBeenCalledOnce();
    expect(resumeInput).toHaveBeenCalledOnce();
    expect(pauseInput.mock.invocationCallOrder[0]).toBeLessThan(
      (approve as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? 0,
    );
  });
});
