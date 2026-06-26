import { select } from "@inquirer/prompts";
import type { ToolCall } from "../agent/types.js";
import {
  summarizeApproval,
  summarizeToolCall,
} from "../ui/toolPresentation.js";

export type ApprovalDecision = "reject" | "allow_once" | "allow_session";

export type ApprovalFunction = (
  call: ToolCall,
  reason: string,
) => Promise<ApprovalDecision>;

export const askUserApproval: ApprovalFunction = async (call, reason) => {
  console.log("\nTool approval required");
  console.log(`Action: ${summarizeToolCall(call)}`);
  const detail = summarizeApproval(call);

  if (detail) {
    console.log(`Change: ${detail}`);
  }
  console.log(`Reason: ${reason}`);

  return select({
    message: "Approve this tool call?",
    default: "reject" satisfies ApprovalDecision,
    choices: [
      {
        name: "Allow once",
        value: "allow_once" satisfies ApprovalDecision,
        description: "Approve only this tool call.",
      },
      {
        name: "Allow for this session",
        value: "allow_session" satisfies ApprovalDecision,
        description: sessionScopeDescription(call),
      },
      {
        name: "Reject",
        value: "reject" satisfies ApprovalDecision,
        description: "Do not run this tool call.",
      },
    ],
  });
};

export function restoreInputAfterApproval(
  approve: ApprovalFunction,
  resumeInput: () => void,
): ApprovalFunction {
  return async (call, reason) => {
    try {
      return await approve(call, reason);
    } finally {
      resumeInput();
    }
  };
}

function sessionScopeDescription(call: ToolCall): string {
  if (call.name === "Bash") {
    const command = String(call.args.command ?? "");
    const commandFamily = command.trim().split(/\s+/)[0] || "this command type";
    return `Remember approval for ${commandFamily} commands until this process exits.`;
  }

  return `Remember approval for ${call.name} until this process exits.`;
}
