import {
  isCancellationError,
} from "../agent/cancellation.js";
import type { CommandExecutor } from "../runtime/commandExecutor.js";
import {
  FileOperationError,
  readTextFileSnapshot,
} from "../runtime/textFile.js";
import type { Workspace } from "../runtime/workspace.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./base.js";
import { walkSearchFiles } from "./fileSearch.js";

const MAX_NATIVE_SEARCH_FILES = 20_000;
const MAX_NATIVE_FILE_BYTES = 2 * 1024 * 1024;

export class GrepTool implements Tool {
  name = "Grep";
  description =
    "Search text recursively, using ripgrep acceleration when available. Absolute paths outside the workspace may be requested and will use the folder approval flow.";

  inputSchema = {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
    },
    required: ["pattern"],
    additionalProperties: false,
  };

  constructor(
    private readonly workspace: Workspace,
    private readonly executor: CommandExecutor,
    private readonly maxOutputChars = 12_000,
    private readonly useRipgrep = true,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (typeof args.pattern !== "string" || !args.pattern) {
      return { ok: false, content: "pattern must be a non-empty string." };
    }

    const searchPath = typeof args.path === "string" ? args.path : ".";
    const accessOptions = {
      allowOutside: context?.userApproved === true,
      outsideRoot: context?.approvedFolder,
    };
    const absPath = this.workspace.resolve(searchPath, accessOptions);
    await this.workspace.assertRealPathWithin(absPath, accessOptions);
    if (!this.useRipgrep) {
      return this.executeNative(
        absPath,
        args.pattern,
        accessOptions,
        context,
      );
    }
    const result = await this.executor.run({
      command: "rg",
      args: [
        "--line-number",
        "--hidden",
        "--glob",
        "!**/node_modules/**",
        "--glob",
        "!**/dist/**",
        "--glob",
        "!**/.git/**",
        "--glob",
        "!**/.env",
        "--glob",
        "!**/.env.*",
        args.pattern,
        absPath,
      ],
      cwd: this.workspace.root,
      timeoutMs: 20_000,
      signal: context?.signal,
    });

    const rawOutput = result.stdout || result.stderr || "[No matches]";
    const truncated = rawOutput.length > this.maxOutputChars;
    const output = truncated
      ? `${rawOutput.slice(0, this.maxOutputChars)}\n[Output truncated]`
      : rawOutput;

    return {
      ok: result.exitCode === 0 || result.exitCode === 1,
      content: output,
      data: {
        exitCode: result.exitCode,
        truncated,
        engine: "ripgrep",
      },
    };
  }

  private async executeNative(
    searchRoot: string,
    pattern: string,
    accessOptions: {
      allowOutside: boolean;
      outsideRoot?: string;
    },
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    let matcher: RegExp;
    try {
      matcher = new RegExp(pattern);
    } catch (error: unknown) {
      return {
        ok: false,
        content: `Invalid regular expression: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    const matches: string[] = [];
    let outputLength = 0;
    let filesScanned = 0;
    let truncated = false;

    try {
      for await (const file of walkSearchFiles(searchRoot, context?.signal)) {
        if (filesScanned >= MAX_NATIVE_SEARCH_FILES) {
          truncated = true;
          break;
        }
        filesScanned += 1;
        const logicalPath = this.workspace.contains(file)
          ? this.workspace.relative(file)
          : file;
        let text: string;
        try {
          text = (
            await readTextFileSnapshot(this.workspace, logicalPath, {
              maxBytes: MAX_NATIVE_FILE_BYTES,
              allowOutside: accessOptions.allowOutside,
              outsideRoot: accessOptions.outsideRoot,
              signal: context?.signal,
            })
          ).text;
        } catch (error: unknown) {
          if (isCancellationError(error, context?.signal)) {
            throw error;
          }
          if (error instanceof FileOperationError) {
            continue;
          }
          continue;
        }

        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (!matcher.test(line)) {
            continue;
          }
          const match = `${logicalPath}:${index + 1}:${line}`;
          if (outputLength + match.length + 1 > this.maxOutputChars) {
            truncated = true;
            break;
          }
          matches.push(match);
          outputLength += match.length + 1;
        }
        if (truncated) {
          break;
        }
      }
    } catch (error: unknown) {
      if (isCancellationError(error, context?.signal)) {
        return {
          ok: false,
          content: "Text search cancelled.",
          data: { code: "cancelled", retryable: false },
        };
      }
      return {
        ok: false,
        content: error instanceof Error ? error.message : String(error),
      };
    }

    const content = [
      matches.join("\n") || "[No matches]",
      ...(truncated ? ["[Output truncated]"] : []),
    ].join("\n");

    return {
      ok: true,
      content,
      data: {
        exitCode: matches.length > 0 ? 0 : 1,
        truncated,
        filesScanned,
        engine: "native",
      },
    };
  }
}
