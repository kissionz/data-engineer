import { describe, expect, it } from "vitest";
import { sameFileIdentity } from "../src/runtime/fileIdentity.js";

describe("sameFileIdentity", () => {
  const base = {
    dev: 1,
    ino: 2,
    size: 10,
    birthtimeMs: 100,
    ctimeMs: 200,
  };

  it("uses stable device and inode identity on Unix", () => {
    expect(sameFileIdentity(base, { ...base }, "linux")).toBe(true);
    expect(
      sameFileIdentity(base, { ...base, ino: 3 }, "linux"),
    ).toBe(false);
  });

  it("accepts Windows path and handle stats with matching creation metadata", () => {
    expect(
      sameFileIdentity(
        base,
        { ...base, dev: 9, ino: 99 },
        "win32",
      ),
    ).toBe(true);
    expect(
      sameFileIdentity(
        base,
        { ...base, dev: 9, ino: 99, size: 11 },
        "win32",
      ),
    ).toBe(false);
    expect(
      sameFileIdentity(
        base,
        { ...base, dev: 9, ino: 99, birthtimeMs: 101, ctimeMs: 201 },
        "win32",
      ),
    ).toBe(false);
  });
});
