import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  resolve(userPath: string): string {
    const resolved = path.resolve(this.root, userPath);

    this.assertPathWithin(resolved, `Path outside workspace: ${userPath}`);
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

  async assertRealPathWithin(absPath: string): Promise<void> {
    const [rootRealPath, targetRealPath] = await Promise.all([
      realpath(this.root),
      realpath(absPath),
    ]);

    assertWithin(rootRealPath, targetRealPath, `Real path outside workspace: ${absPath}`);
    assertNoSensitiveRelativePath(
      rootRealPath,
      targetRealPath,
      `Sensitive real path denied: ${absPath}`,
    );
  }

  async resolveExistingDirectory(userPath: string): Promise<string> {
    const absPath = this.resolve(userPath);
    const info = await stat(absPath);

    if (!info.isDirectory()) {
      throw new Error(`Not a directory: ${userPath}`);
    }

    await this.assertRealPathWithin(absPath);
    return absPath;
  }

  async assertCreatablePathWithin(absPath: string): Promise<void> {
    this.assertPathWithin(absPath, `Path outside workspace: ${absPath}`);

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

        assertWithin(
          rootRealPath,
          ancestorRealPath,
          `Parent path resolves outside workspace: ${ancestor}`,
        );
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
  const relative = path.relative(root, target);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(message);
  }
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
    )
  ) {
    throw new Error(message);
  }
}
