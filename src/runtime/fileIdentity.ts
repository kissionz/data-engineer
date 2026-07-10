export interface FileIdentityLike {
  dev: number;
  ino: number;
  size: number;
  birthtimeMs?: number;
  ctimeMs?: number;
}

/**
 * Compare two observations of one filesystem object.
 *
 * Unix exposes stable device/inode pairs. On Windows, Node/libuv may report
 * different synthetic dev/ino values for a pathname stat and a handle stat,
 * so use creation metadata as the secondary identity. Size is included to
 * avoid accepting an obviously replaced object. Content hashes and realpath
 * checks remain responsible for detecting in-place changes at call sites.
 */
export function sameFileIdentity(
  left: FileIdentityLike,
  right: FileIdentityLike,
  platform = process.platform,
): boolean {
  if (
    (left.dev !== 0 || left.ino !== 0) &&
    left.dev === right.dev &&
    left.ino === right.ino
  ) {
    return true;
  }
  if (platform !== "win32" || left.size !== right.size) {
    return false;
  }
  if (
    typeof left.birthtimeMs === "number" &&
    typeof right.birthtimeMs === "number" &&
    Number.isFinite(left.birthtimeMs) &&
    left.birthtimeMs > 0 &&
    left.birthtimeMs === right.birthtimeMs
  ) {
    return true;
  }
  return (
    typeof left.ctimeMs === "number" &&
    typeof right.ctimeMs === "number" &&
    Number.isFinite(left.ctimeMs) &&
    left.ctimeMs > 0 &&
    left.ctimeMs === right.ctimeMs
  );
}
