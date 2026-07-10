import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import {
  numericConfig,
  optionOrEnv,
  parseNonNegativeInteger,
  parsePositiveInteger,
  resolveStringOption,
} from "../src/cli/program.js";

describe("CLI option helpers", () => {
  afterEach(() => {
    delete process.env.MONTANE_TEST_LIMIT;
    delete process.env.HARNESS_TEST_LIMIT;
  });

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

  it("prefers Montane environment names while retaining legacy aliases", () => {
    const program = new Command()
      .exitOverride()
      .option("--limit <value>", "limit", "10");
    program.parse(["node", "test"]);
    const value = program.opts<{ limit: string }>().limit;

    process.env.HARNESS_TEST_LIMIT = "20";
    expect(
      optionOrEnv(
        program,
        "limit",
        value,
        "MONTANE_TEST_LIMIT",
        "HARNESS_TEST_LIMIT",
      ),
    ).toBe("20");
    expect(
      resolveStringOption(
        program,
        "limit",
        value,
        "MONTANE_TEST_LIMIT",
        "15",
        "HARNESS_TEST_LIMIT",
      ),
    ).toBe("20");

    process.env.MONTANE_TEST_LIMIT = "30";
    expect(
      optionOrEnv(
        program,
        "limit",
        value,
        "MONTANE_TEST_LIMIT",
        "HARNESS_TEST_LIMIT",
      ),
    ).toBe("30");
  });
});
