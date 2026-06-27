import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import type { Tool, ToolExecutionResult } from "./base.js";

export type TodoStatus = "pending" | "in_progress" | "done";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export class TodoStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<TodoItem[]> {
    try {
      const parsed = JSON.parse(await readSafeFile(this.filePath)) as unknown;
      return validateTodos(parsed);
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }

      throw error;
    }
  }

  async write(todos: TodoItem[]): Promise<void> {
    const validated = validateTodos(todos);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeSafeFile(
      this.filePath,
      `${JSON.stringify(validated, null, 2)}\n`,
    );
  }
}

export class TodoReadTool implements Tool {
  name = "TodoRead";
  description = "Read the current task todo list.";
  inputSchema = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };

  constructor(private readonly store: TodoStore) {}

  async execute(): Promise<ToolExecutionResult> {
    try {
      const todos = await this.store.read();

      return {
        ok: true,
        content: todos.length > 0 ? JSON.stringify(todos, null, 2) : "[No todos]",
        data: { todos },
      };
    } catch (error: unknown) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export class TodoWriteTool implements Tool {
  name = "TodoWrite";
  description = "Replace the current task todo list.";
  inputSchema = {
    type: "object",
    properties: {
      todos: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "done"],
            },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  };

  constructor(private readonly store: TodoStore) {}

  async execute(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    try {
      const todos = validateTodos(args.todos);
      await this.store.write(todos);

      return {
        ok: true,
        content: `Todo list updated (${todos.length} items).`,
        data: { todos },
      };
    } catch (error: unknown) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function validateTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) {
    throw new Error("todos must be an array.");
  }

  if (value.length > 50) {
    throw new Error("todos cannot contain more than 50 items.");
  }

  const todos = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`todos[${index}] must be an object.`);
    }

    const record = item as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    const status = record.status;

    if (!content) {
      throw new Error(`todos[${index}].content must be a non-empty string.`);
    }

    if (!["pending", "in_progress", "done"].includes(String(status))) {
      throw new Error(`todos[${index}].status is invalid.`);
    }

    return { content, status: status as TodoStatus };
  });

  if (todos.filter((todo) => todo.status === "in_progress").length > 1) {
    throw new Error("Only one todo may be in progress at a time.");
  }

  return todos;
}

async function readSafeFile(filePath: string): Promise<string> {
  const pathInfo = await lstat(filePath);

  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
    throw new Error("Refusing to read a symbolic link or non-file todo path.");
  }

  const handle = await open(filePath, "r");

  try {
    await assertSameFile(filePath, pathInfo, handle);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function writeSafeFile(filePath: string, content: string): Promise<void> {
  let handle: FileHandle;

  try {
    handle = await open(filePath, "wx", 0o600);
  } catch (error: unknown) {
    if (!hasCode(error, "EEXIST")) {
      throw error;
    }

    const pathInfo = await lstat(filePath);

    if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
      throw new Error("Refusing to write a symbolic link or non-file todo path.");
    }

    handle = await open(filePath, "r+");

    try {
      await assertSameFile(filePath, pathInfo, handle);
      await handle.truncate(0);
    } catch (error: unknown) {
      await handle.close();
      throw error;
    }
  }

  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

async function assertSameFile(
  filePath: string,
  previousPathInfo: Stats,
  handle: FileHandle,
): Promise<void> {
  const [currentPathInfo, fileInfo] = await Promise.all([
    lstat(filePath),
    handle.stat(),
  ]);

  if (
    currentPathInfo.isSymbolicLink() ||
    !currentPathInfo.isFile() ||
    !sameFile(previousPathInfo, currentPathInfo) ||
    !sameFile(currentPathInfo, fileInfo)
  ) {
    throw new Error("Todo file changed while it was being opened.");
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
