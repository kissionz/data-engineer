import { describe, expect, it } from "vitest";
import type { Tool, ToolExecutionResult } from "../src/tools/base.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { validateSchema } from "../src/tools/schemaValidator.js";

describe("tool schema validation", () => {
  it("validates required fields, nested arrays, and enums", () => {
    const schema = {
      type: "object",
      properties: {
        todos: {
          type: "array",
          maxItems: 2,
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "done"] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    };

    expect(
      validateSchema(schema, {
        todos: [{ content: "Ship", status: "done" }],
      }),
    ).toEqual({ ok: true });

    const invalid = validateSchema(schema, {
      todos: [
        { content: "One", status: "invalid" },
        { content: "Two" },
        { content: "Three", status: "done" },
      ],
    });

    expect(invalid).toMatchObject({ ok: false });
    if (!invalid.ok) {
      expect(invalid.errors).toContain(
        "args.todos cannot contain more than 2 items.",
      );
      expect(invalid.errors).toContain(
        "args.todos[0].status must be one of: pending, done.",
      );
      expect(invalid.errors).toContain("args.todos[1].status is required.");
    }
  });

  it("rejects unknown tools and invalid calls before execution", async () => {
    const registry = new ToolRegistry();
    const tool = new CountingTool();
    registry.register(tool);

    await expect(registry.execute("Missing", {})).resolves.toMatchObject({
      ok: false,
      data: { reason: "unknown_tool" },
    });
    await expect(registry.execute("Count", {})).resolves.toMatchObject({
      ok: false,
      data: { reason: "invalid_tool_arguments" },
    });
    expect(tool.executions).toBe(0);
  });
});

class CountingTool implements Tool {
  name = "Count";
  description = "Count executions.";
  inputSchema = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  };
  executions = 0;

  async execute(): Promise<ToolExecutionResult> {
    this.executions += 1;
    return { ok: true, content: "executed" };
  }
}
