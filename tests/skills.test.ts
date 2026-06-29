import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_SKILL_COUNT,
  MAX_SKILL_SIZE_BYTES,
  SkillLoader,
  SkillLoaderError,
} from "../src/skills/loader.js";
import { SkillListTool, SkillLoadTool } from "../src/tools/skill.js";

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-skills-"));
  await mkdir(path.join(root, ".harness", "skills"), { recursive: true });
  return root;
}

async function writeSkill(
  root: string,
  directory: string,
  source: string,
): Promise<string> {
  const skillDirectory = path.join(root, ".harness", "skills", directory);
  await mkdir(skillDirectory, { recursive: true });
  const skillPath = path.join(skillDirectory, "SKILL.md");
  await writeFile(skillPath, source, "utf8");
  return skillPath;
}

describe("SkillLoader", () => {
  it("lists and loads skills with parsed YAML frontmatter", async () => {
    const root = await createWorkspace();
    await writeSkill(
      root,
      "deploy",
      [
        "---",
        "name: deploy",
        'description: "Deploy the application safely"',
        "tags:",
        "  - release",
        "---",
        "# Deploy",
        "",
        "Run the release checklist.",
      ].join("\n"),
    );
    await writeSkill(
      root,
      "audit",
      ["---", "name: audit", "description: Inspect changes", "---", "Read only."].join(
        "\n",
      ),
    );

    const loader = new SkillLoader(root);

    await expect(loader.list()).resolves.toEqual([
      { name: "audit", description: "Inspect changes" },
      { name: "deploy", description: "Deploy the application safely" },
    ]);
    await expect(loader.load("deploy")).resolves.toMatchObject({
      name: "deploy",
      description: "Deploy the application safely",
      metadata: { tags: ["release"] },
      content: "# Deploy\n\nRun the release checklist.",
      path: path.join(".harness", "skills", "deploy", "SKILL.md"),
    });
  });

  it("returns an empty list when the skills directory is absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-skills-"));

    await expect(new SkillLoader(root).list()).resolves.toEqual([]);
  });

  it("deterministically recommends relevant skills from metadata", async () => {
    const root = await createWorkspace();
    await writeSkill(
      root,
      "typescript-testing",
      [
        "---",
        "name: typescript-testing",
        "description: Run TypeScript tests and verify regressions",
        "---",
        "Use the test runner.",
      ].join("\n"),
    );
    await writeSkill(
      root,
      "release-notes",
      [
        "---",
        "name: release-notes",
        "description: Draft release documentation",
        "---",
        "Write notes.",
      ].join("\n"),
    );

    await expect(
      new SkillLoader(root).recommend("Fix the TypeScript testing regression"),
    ).resolves.toEqual([
      expect.objectContaining({
        name: "typescript-testing",
        score: expect.any(Number),
      }),
    ]);
  });

  it("bounds and normalizes recommended descriptions", async () => {
    const root = await createWorkspace();
    await writeSkill(
      root,
      "audit",
      [
        "---",
        "name: audit",
        `description: "Audit\\u0000 ${"details ".repeat(80)}"`,
        "---",
        "Instructions.",
      ].join("\n"),
    );

    const [recommended] = await new SkillLoader(root).recommend(
      "audit the details",
    );
    expect(recommended?.description.length).toBeLessThanOrEqual(300);
    expect(recommended?.description).not.toContain("\0");
  });

  it("caps skill count and reuses a successful metadata snapshot", async () => {
    const root = await createWorkspace();
    await writeSkill(
      root,
      "audit",
      "---\nname: audit\ndescription: Audit changes\n---\nInstructions.",
    );
    const loader = new SkillLoader(root);
    await expect(loader.list()).resolves.toHaveLength(1);
    await writeSkill(root, "broken", "invalid");
    await expect(loader.list()).resolves.toHaveLength(1);

    const crowded = await createWorkspace();
    for (let index = 0; index <= MAX_SKILL_COUNT; index += 1) {
      await mkdir(
        path.join(crowded, ".harness", "skills", `skill-${index}`),
      );
    }
    await expect(new SkillLoader(crowded).list()).rejects.toThrow(
      `${MAX_SKILL_COUNT}-skill limit`,
    );
  });

  it.each(["../outside", "nested/skill", "nested\\skill", ".", ".."])(
    "rejects unsafe skill name %s",
    async (name) => {
      const root = await createWorkspace();

      await expect(new SkillLoader(root).load(name)).rejects.toMatchObject({
        code: "invalid_name",
      });
    },
  );

  it("rejects a skill directory symlink that escapes the skills root", async () => {
    const root = await createWorkspace();
    const outside = await mkdtemp(path.join(os.tmpdir(), "harness-outside-"));
    await writeFile(
      path.join(outside, "SKILL.md"),
      "---\nname: outside\ndescription: Escaped\n---\nDo not load.",
      "utf8",
    );
    await symlink(outside, path.join(root, ".harness", "skills", "outside"));

    await expect(new SkillLoader(root).load("outside")).rejects.toMatchObject({
      code: "invalid_path",
    });
  });

  it("rejects a SKILL.md symlink", async () => {
    const root = await createWorkspace();
    const target = await writeSkill(
      root,
      "target",
      "---\nname: target\ndescription: Target\n---\nTarget body.",
    );
    const linkedDirectory = path.join(root, ".harness", "skills", "linked");
    await mkdir(linkedDirectory);
    await symlink(target, path.join(linkedDirectory, "SKILL.md"));

    await expect(new SkillLoader(root).load("linked")).rejects.toMatchObject({
      code: "invalid_path",
    });
  });

  it.each([
    ["missing delimiters", "name: broken\ndescription: Broken"],
    ["missing closing delimiter", "---\nname: broken\ndescription: Broken"],
    ["malformed YAML", "---\nname: [broken\ndescription: Broken\n---\nBody"],
    ["missing name", "---\ndescription: Broken\n---\nBody"],
    ["missing description", "---\nname: broken\n---\nBody"],
    [
      "name differs from directory",
      "---\nname: another\ndescription: Broken\n---\nBody",
    ],
  ])("rejects %s frontmatter", async (_label, source) => {
    const root = await createWorkspace();
    await writeSkill(root, "broken", source);

    await expect(new SkillLoader(root).load("broken")).rejects.toMatchObject({
      code: "invalid_frontmatter",
    });
  });

  it("rejects skill files larger than 64KB", async () => {
    const root = await createWorkspace();
    const header = "---\nname: large\ndescription: Large skill\n---\n";
    await writeSkill(
      root,
      "large",
      header + "x".repeat(MAX_SKILL_SIZE_BYTES - Buffer.byteLength(header) + 1),
    );

    await expect(new SkillLoader(root).load("large")).rejects.toMatchObject({
      code: "too_large",
    });
  });

  it("surfaces malformed skills during listing", async () => {
    const root = await createWorkspace();
    await writeSkill(root, "broken", "No frontmatter");

    await expect(new SkillLoader(root).list()).rejects.toBeInstanceOf(
      SkillLoaderError,
    );
  });
});

describe("skill tools", () => {
  it("lists and loads instructions without modifying or executing them", async () => {
    const root = await createWorkspace();
    const marker = path.join(root, "executed");
    const source = [
      "---",
      "name: passive",
      "description: Read-only instructions",
      "---",
      "# Instructions",
      "",
      `touch ${marker}`,
    ].join("\n");
    const skillPath = await writeSkill(root, "passive", source);
    const loader = new SkillLoader(root);

    const listed = await new SkillListTool(loader).execute({});
    const loaded = await new SkillLoadTool(loader).execute({ name: "passive" });

    expect(listed).toMatchObject({
      ok: true,
      data: {
        skills: [{ name: "passive", description: "Read-only instructions" }],
      },
    });
    expect(loaded).toMatchObject({
      ok: true,
      content: expect.stringContaining(`touch ${marker}`),
      data: {
        skill: {
          name: "passive",
          description: "Read-only instructions",
        },
      },
    });
    await expect(readFile(skillPath, "utf8")).resolves.toBe(source);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns structured failures for invalid loads", async () => {
    const root = await createWorkspace();
    const tool = new SkillLoadTool(root);

    await expect(tool.execute({ name: "../secret" })).resolves.toMatchObject({
      ok: false,
      data: { reason: "invalid_name" },
    });
    await expect(tool.execute({})).resolves.toMatchObject({
      ok: false,
      data: { reason: "invalid_name" },
    });
  });
});
