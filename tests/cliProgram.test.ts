import { describe, expect, it } from "vitest";
import {
  numericConfig,
  parseNonNegativeInteger,
  parsePositiveInteger,
} from "../src/cli/program.js";

describe("CLI option helpers", () => {
  it("parses bounded integer option forms without accepting coercions", () => {
    expect(parsePositiveInteger("12", "--turns")).toBe(12);
    expect(parseNonNegativeInteger("0", "--retries")).toBe(0);
    expect(() => parsePositiveInteger("1.5", "--turns")).toThrow("--turns");
    expect(() => parsePositiveInteger("01", "--turns")).toThrow("--turns");
    expect(() => parseNonNegativeInteger("-1", "--retries")).toThrow(
      "--retries",
    );
  });

  it("converts optional numeric config values for Commander resolution", () => {
    expect(numericConfig(undefined)).toBeUndefined();
    expect(numericConfig(42)).toBe("42");
  });
});
