import type { ModelClient } from "../model/base.js";
import type { ApprovalDecision, ApprovalFunction } from "../permissions/approval.js";
import { askUserApproval } from "../permissions/approval.js";
import type { PermissionGate } from "../permissions/gate.js";
import type { ToolExecutionResult } from "../tools/base.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ContextBuilder } from "./context.js";
import type { SessionStore } from "./session.js";

export class AgentLoop {
  private readonly sessionApprovals = new Set<string>();

  constructor(
    private readonly model: ModelClient,
    private readonly tools: ToolRegistry,
    private readonly permissions: PermissionGate,
    private readonly context: ContextBuilder,
    private readonly session: SessionStore,
    private readonly maxTurns = 50,
    private readonly approve: ApprovalFunction = askUserApproval,
  ) {}

  async run(userTask: string): Promise<string> {
    await this.session.append({
      type: "user_message",
      text: userTask,
    });

    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      const events = await this.session.load();
      const messages = await this.context.build(events);

      const response = await this.model.complete({
        messages,
        tools: this.tools.schemas(),
      });

      if (response.finalText) {
        await this.session.append({
          type: "assistant_final",
          text: response.finalText,
        });

        return response.finalText;
      }

      const toolCalls = response.toolCalls ?? [];

      if (toolCalls.length === 0) {
        const text = "Model returned neither final text nor tool calls.";
        await this.session.append({ type: "assistant_final", text });
        return text;
      }

      await this.session.append({
        type: "assistant_tool_calls",
        toolCalls,
      });

      for (const call of toolCalls) {
        const check = this.permissions.check(call);
        let result: ToolExecutionResult;

        if (check.decision === "deny") {
          result = {
            ok: false,
            content: `Permission denied: ${check.reason}`,
            data: { reason: check.reason },
          };
        } else if (check.decision === "ask" && !this.hasSessionApproval(call)) {
          const approval = await this.approve(call, check.reason);

          result = await this.executeApprovedTool(call.name, call.args, approval, call);
        } else {
          result = await this.executeTool(call.name, call.args);
        }

        await this.session.append({
          type: "tool_result",
          toolCallId: call.id,
          name: call.name,
          ok: result.ok,
          content: result.content,
          data: result.data,
        });
      }
    }

    const text = "Stopped: max turns reached.";
    await this.session.append({ type: "assistant_final", text });
    return text;
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    try {
      return await this.tools.execute(name, args);
    } catch (error: unknown) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async executeApprovedTool(
    name: string,
    args: Record<string, unknown>,
    approval: ApprovalDecision,
    call: { name: string; args: Record<string, unknown> },
  ): Promise<ToolExecutionResult> {
    if (approval === "reject") {
      return {
        ok: false,
        content: "User rejected tool call.",
        data: { reason: "user_rejected" },
      };
    }

    if (approval === "allow_session") {
      this.sessionApprovals.add(sessionApprovalKey(call));
    }

    return this.executeTool(name, args);
  }

  private hasSessionApproval(call: {
    name: string;
    args: Record<string, unknown>;
  }): boolean {
    return this.sessionApprovals.has(sessionApprovalKey(call));
  }
}

function sessionApprovalKey(call: {
  name: string;
  args: Record<string, unknown>;
}): string {
  if (call.name === "Bash") {
    const command = String(call.args.command ?? "").trim();
    const commandFamily = command.split(/\s+/)[0] || "unknown";
    return `Bash:${commandFamily}`;
  }

  return call.name;
}
