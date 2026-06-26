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
