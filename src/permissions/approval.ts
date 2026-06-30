import { select } from "@inquirer/prompts";
import { AgentCancelledError } from "../agent/cancellation.js";
import type { ToolCall } from "../agent/types.js";
import type { FolderGrantRequest } from "./folderGrants.js";
import {
  summarizeApproval,
  summarizeToolCall,
} from "../ui/toolPresentation.js";

export type ApprovalDecision =
  | "reject"
  | "allow_once"
  | "allow_session"
  | "allow_folder_session"
  | "allow_folder_always";

export type ApprovalFunction = (
  call: ToolCall,
  reason: string,
  signal?: AbortSignal,
  folderGrant?: FolderGrantRequest,
) => Promise<ApprovalDecision>;

export const askUserApproval: ApprovalFunction = async (
  call,
  reason,
  signal,
  folderGrant,
) => {
  console.log("\nTool approval required");
  console.log(`Action: ${summarizeToolCall(call)}`);
  const detail = summarizeApproval(call);

  if (detail) {
    console.log(`Change: ${detail}`);
  }
  console.log(`Reason: ${reason}`);
  const choices: Array<{
    name: string;
    value: ApprovalDecision;
    description: string;
  }> = [
    {
      name: "Allow once",
      value: "allow_once",
      description: "Approve only this tool call.",
    },
    ...(folderGrant
      ? [
          {
            name: "Allow folder for this session",
            value: "allow_folder_session" as const,
            description: folderScopeDescription(folderGrant, false),
          },
          {
            name: "Always allow this folder",
            value: "allow_folder_always" as const,
            description: folderScopeDescription(folderGrant, true),
          },
        ]
      : call.name === "HttpFetch"
      ? []
      : [
          {
            name: "Allow for this session",
            value: "allow_session" as const,
            description: sessionScopeDescription(call),
          },
        ]),
    {
      name: "Reject",
      value: "reject",
      description: "Do not run this tool call.",
    },
  ];

  try {
    return await select(
      {
        message: "Approve this tool call?",
        default: "reject" satisfies ApprovalDecision,
        choices,
      },
      { signal },
    );
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      ["AbortPromptError", "ExitPromptError"].includes(error.name)
    ) {
      throw new AgentCancelledError();
    }

    throw error;
  }
};

export function restoreInputAfterApproval(
  approve: ApprovalFunction,
  resumeInput: () => void,
  pauseInput: () => void = () => undefined,
): ApprovalFunction {
  return async (call, reason, signal, folderGrant) => {
    pauseInput();
    try {
      return folderGrant
        ? await approve(call, reason, signal, folderGrant)
        : await approve(call, reason, signal);
    } finally {
      resumeInput();
    }
  };
}

function folderScopeDescription(
  grant: FolderGrantRequest,
  persistent: boolean,
): string {
  const access =
    grant.access === "read_write" ? "read and write" : "read-only";
  return `${access} access to ${grant.folder} and its subfolders${
    persistent ? " across future sessions" : " until this process exits"
  }.`;
}

function sessionScopeDescription(call: ToolCall): string {
  if (call.name === "Bash") {
    const command = String(call.args.command ?? "");
    const commandFamily = command.trim().split(/\s+/)[0] || "this command type";
    return `Remember approval for ${commandFamily} commands until this process exits.`;
  }

  return `Remember approval for ${call.name} until this process exits.`;
}
