import { describe, expect, it, vi } from "vitest";
import {
  assertAllowedAddress,
  canonicalHostname,
} from "../src/runtime/httpSafety.js";
import {
  HttpFetchTool,
  type HttpRequester,
  type HttpResponse,
} from "../src/tools/httpFetch.js";

function response(
  body: string,
  options: {
    statusCode?: number;
    contentType?: string;
    location?: string;
    chunkSize?: number;
  } = {},
): HttpResponse {
  const bytes = Buffer.from(body);
  const chunkSize = options.chunkSize ?? (bytes.length || 1);
  return {
    statusCode: options.statusCode ?? 200,
    headers: {
      "content-type": options.contentType ?? "text/plain; charset=utf-8",
      location: options.location,
    },
    body: Object.assign(
      (async function* () {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          yield bytes.subarray(offset, offset + chunkSize);
        }
      })(),
      { destroy: vi.fn() },
    ),
  };
}

function toolWith(
  requester: HttpRequester,
  options: Partial<ConstructorParameters<typeof HttpFetchTool>[0]> = {},
) {
  return new HttpFetchTool({
    allowedHosts: ["example.com"],
    requester,
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    ...options,
  });
}

describe("HttpFetchTool", () => {
  it("performs only GET and marks text as untrusted", async () => {
    const requester = vi.fn<HttpRequester>().mockResolvedValue(
      response("external instructions"),
    );

    const result = await toolWith(requester).execute({
      url: "https://example.com/docs",
    });

    expect(result.ok).toBe(true);
    expect(requester).toHaveBeenCalledWith(
      new URL("https://example.com/docs"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.content).toContain("[UNTRUSTED HTTP CONTENT");
    expect(result.content).toContain("external instructions");
    expect(result.data).toMatchObject({
      untrusted: true,
      statusCode: 200,
      contentType: "text/plain",
    });
  });

  it("does not echo query values into tool output", async () => {
    const result = await toolWith(async () => response("ok")).execute({
      url: "https://example.com/docs?token=secret",
    });
    expect(result.content).not.toContain("secret");
    expect(result.data?.url).toContain("[redacted]");
  });

  it("revalidates redirects and rejects a host outside the allowlist", async () => {
    const requester = vi.fn<HttpRequester>().mockResolvedValue(
      response("", {
        statusCode: 302,
        location: "https://evil.example/target",
      }),
    );

    const result = await toolWith(requester).execute({
      url: "https://example.com/start",
    });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("not in the HttpFetch allowlist");
    expect(requester).toHaveBeenCalledTimes(1);
  });

  it("enforces the redirect limit and rejects redirect fragments", async () => {
    const looping = vi
      .fn<HttpRequester>()
      .mockResolvedValue(
        response("", { statusCode: 302, location: "/next" }),
      );
    const limited = await toolWith(looping, { maxRedirects: 1 }).execute({
      url: "https://example.com/start",
    });
    expect(limited.ok).toBe(false);
    expect(limited.content).toContain("redirect limit");
    expect(looping).toHaveBeenCalledTimes(2);

    const fragment = vi
      .fn<HttpRequester>()
      .mockResolvedValue(
        response("", { statusCode: 302, location: "/next#hidden" }),
      );
    const fragmentResult = await toolWith(fragment).execute({
      url: "https://example.com/start",
    });
    expect(fragmentResult.ok).toBe(false);
    expect(fragmentResult.content).toContain("fragments are denied");
  });

  it("rejects credentials, fragments, HTTP by default, and wildcard config", async () => {
    const requester = vi.fn<HttpRequester>();
    const httpsOnly = toolWith(requester);
    await expect(
      httpsOnly.execute({ url: "http://example.com/a" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      httpsOnly.execute({ url: "https://user:pass@example.com/a" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      httpsOnly.execute({ url: "https://example.com/a#fragment" }),
    ).resolves.toMatchObject({ ok: false });
    expect(requester).not.toHaveBeenCalled();
    expect(
      () => new HttpFetchTool({ allowedHosts: ["*.example.com"] }),
    ).toThrow(/exact/);
    expect(
      () => new HttpFetchTool({ allowedHosts: ["Example.com"] }),
    ).toThrow(/canonical/);
  });

  it("permits localhost HTTP only with explicit opt-in", async () => {
    const requester = vi
      .fn<HttpRequester>()
      .mockResolvedValue(response("local"));
    const localhost = new HttpFetchTool({
      allowedHosts: ["localhost"],
      allowedPorts: [8123],
      allowHttpLocalhost: true,
      requester,
      resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    const result = await localhost.execute({
      url: "http://localhost:8123/health",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a non-default port unless it is explicitly allowed", async () => {
    const requester = vi.fn<HttpRequester>();
    const denied = await toolWith(requester).execute({
      url: "https://example.com:8443/data",
    });
    expect(denied.ok).toBe(false);
    expect(denied.content).toContain("Port 8443");
    expect(requester).not.toHaveBeenCalled();

    const allowed = await toolWith(
      async () => response("ok"),
      { allowedPorts: [8443] },
    ).execute({ url: "https://example.com:8443/data" });
    expect(allowed.ok).toBe(true);
  });

  it("rejects an allowlisted private IP literal before connecting", async () => {
    const requester = vi.fn<HttpRequester>();
    const literal = new HttpFetchTool({
      allowedHosts: ["127.0.0.1"],
      requester,
    });
    const result = await literal.execute({ url: "https://127.0.0.1/data" });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("non-public IP");
    expect(requester).not.toHaveBeenCalled();
  });

  it("rejects non-text content and oversized streaming bodies", async () => {
    const binaryResult = await toolWith(async () =>
      response("1234", { contentType: "application/octet-stream" }),
    ).execute({ url: "https://example.com/file" });
    expect(binaryResult.ok).toBe(false);
    expect(binaryResult.content).toContain("content type");

    const largeResult = await toolWith(
      async () =>
        response('{"value":"too long"}', {
          contentType: "application/json",
          chunkSize: 2,
        }),
      { maxResponseBytes: 5 },
    ).execute({ url: "https://example.com/data" });
    expect(largeResult.ok).toBe(false);
    expect(largeResult.content).toContain("byte limit");
  });

  it("rejects all private, loopback, link-local, reserved, metadata, and mapped IPs", () => {
    for (const address of [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "192.0.2.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
      "::1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
    ]) {
      expect(() =>
        assertAllowedAddress(address, { allowLoopback: false }),
      ).toThrow(/non-public/);
    }
    expect(() =>
      assertAllowedAddress("127.0.0.1", { allowLoopback: true }),
    ).not.toThrow();
    expect(() =>
      assertAllowedAddress("::ffff:7f00:1", { allowLoopback: true }),
    ).not.toThrow();
    expect(() =>
      assertAllowedAddress("169.254.169.254", { allowLoopback: true }),
    ).toThrow();
    expect(() =>
      assertAllowedAddress("8.8.8.8", { allowLoopback: false }),
    ).not.toThrow();
  });

  it("rejects every DNS answer if a response mixes public and private IPs", () => {
    const answers = ["93.184.216.34", "10.0.0.4"];
    expect(() => {
      for (const address of answers) {
        assertAllowedAddress(address, { allowLoopback: false });
      }
    }).toThrow(/non-public/);
  });

  it("canonicalizes DNS hostnames", () => {
    expect(canonicalHostname("EXAMPLE.COM.")).toBe("example.com");
    expect(canonicalHostname("bücher.example")).toBe("xn--bcher-kva.example");
  });
});
