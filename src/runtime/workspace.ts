import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceAccessOptions {
  allowOutside?: boolean;
  outsideRoot?: string;
}

export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  resolve(
    userPath: string,
    options: WorkspaceAccessOptions = {},
  ): string {
    const resolved = path.resolve(this.root, userPath);

    if (!options.allowOutside) {
      this.assertPathWithin(resolved, `Path outside workspace: ${userPath}`);
    } else if (
      options.outsideRoot &&
      !isWithin(path.resolve(options.outsideRoot), resolved)
    ) {
      throw new Error(`Path outside approved folder: ${userPath}`);
    }
    assertNoSensitiveRelativePath(
      this.root,
      resolved,
      `Sensitive path denied: ${userPath}`,
    );
    return resolved;
  }

  relative(absPath: string): string {
    return path.relative(this.root, absPath);
  }

  async assertRealPathWithin(
    absPath: string,
    options: WorkspaceAccessOptions = {},
  ): Promise<void> {
    const [rootRealPath, targetRealPath] = await Promise.all([
      realpath(this.root),
      realpath(absPath),
    ]);

    if (isWithin(this.root, absPath) || !options.allowOutside) {
      assertWithin(
        rootRealPath,
        targetRealPath,
        `Real path outside workspace: ${absPath}`,
      );
    } else if (options.outsideRoot) {
      const approvedRealPath = await realpath(options.outsideRoot);
      assertWithin(
        approvedRealPath,
        targetRealPath,
        `Real path outside approved folder: ${absPath}`,
      );
    }
    assertNoSensitiveRelativePath(
      rootRealPath,
      targetRealPath,
      `Sensitive real path denied: ${absPath}`,
    );
  }

  async resolveExistingDirectory(
    userPath: string,
    options: WorkspaceAccessOptions = {},
  ): Promise<string> {
    const absPath = this.resolve(userPath, options);
    const info = await stat(absPath);

    if (!info.isDirectory()) {
      throw new Error(`Not a directory: ${userPath}`);
    }

    await this.assertRealPathWithin(absPath, options);
    return absPath;
  }

  async assertCreatablePathWithin(
    absPath: string,
    options: WorkspaceAccessOptions = {},
  ): Promise<void> {
    if (!options.allowOutside) {
      this.assertPathWithin(absPath, `Path outside workspace: ${absPath}`);
    }

    let ancestor = path.dirname(absPath);

    while (true) {
      const info = await stat(ancestor).catch(() => null);

      if (info) {
        if (!info.isDirectory()) {
          throw new Error(`Parent path is not a directory: ${ancestor}`);
        }

        const [rootRealPath, ancestorRealPath] = await Promise.all([
          realpath(this.root),
          realpath(ancestor),
        ]);

        if (isWithin(this.root, absPath) || !options.allowOutside) {
          assertWithin(
            rootRealPath,
            ancestorRealPath,
            `Parent path resolves outside workspace: ${ancestor}`,
          );
        } else if (options.outsideRoot) {
          assertWithin(
            await realpath(options.outsideRoot),
            ancestorRealPath,
            `Parent path resolves outside approved folder: ${ancestor}`,
          );
        }
        assertNoSensitiveRelativePath(
          rootRealPath,
          ancestorRealPath,
          `Sensitive parent path denied: ${ancestor}`,
        );
        return;
      }

      const parent = path.dirname(ancestor);

      if (parent === ancestor) {
        throw new Error(`No existing parent directory for: ${absPath}`);
      }

      ancestor = parent;
    }
  }

  private assertPathWithin(absPath: string, message: string): void {
    assertWithin(this.root, absPath, message);
  }
}

function assertWithin(root: string, target: string, message: string): void {
  if (!isWithin(root, target)) {
    throw new Error(message);
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function assertNoSensitiveRelativePath(
  root: string,
  target: string,
  message: string,
): void {
  const segments = path
    .relative(root, target)
    .split(path.sep)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());

  if (
    segments.some(
      (segment) =>
        segment === ".git" ||
        segment === "node_modules" ||
        segment === ".env" ||
        segment.startsWith(".env."),
    ) ||
    segments.some(
      (segment, index) =>
        segment === ".harness" && segments[index + 1] === "permissions",
    )
  ) {
    throw new Error(message);
  }
}
