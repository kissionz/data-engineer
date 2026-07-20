import type { BackgroundCommandManager } from "../runtime/backgroundCommands.js";
import type { ShellExecutor } from "../runtime/shellExecutor.js";
import type { Workspace } from "../runtime/workspace.js";
import { BashTool } from "./bash.js";
import { BashTaskTool } from "./bashTask.js";
import type { ToolRegistry } from "./registry.js";

export function registerBashRuntime(
  tools: ToolRegistry,
  workspace: Workspace,
  executor: ShellExecutor | undefined,
  backgroundTasks: BackgroundCommandManager,
): void {
  if (!executor) {
    return;
  }
  tools.register(new BashTool(workspace, executor, backgroundTasks));
  tools.register(new BashTaskTool(backgroundTasks));
}
