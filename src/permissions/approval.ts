import { confirm } from "@inquirer/prompts";
import type { ToolCall } from "../agent/types.js";

export type ApprovalFunction = (
  call: ToolCall,
  reason: string,
) => Promise<boolean>;

export const askUserApproval: ApprovalFunction = async (call, reason) => {
  console.log("\nTool approval required");
  console.log(`Tool: ${call.name}`);
  console.log(`Reason: ${reason}`);
  console.log("Args:");
  console.log(JSON.stringify(call.args, null, 2));

  return confirm({
    message: "Approve this tool call?",
    default: false,
  });
};
