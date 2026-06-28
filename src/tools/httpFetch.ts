import { Agent, request, type Dispatcher } from "undici";
import type { LookupOptions } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import type {
  LookupAddress,
  ResolveHost,
} from "../runtime/httpSafety.js";
import {
  assertAllowedAddress,
  canonicalHostname,
  resolveHost,
} from "../runtime/httpSafety.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./base.js";

export interface HttpFetchOptions {
  allowedHosts: string[];
  allowedPorts?: number[];
  allowHttpLocalhost?: boolean;
  maxRedirects?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
  resolveHost?: ResolveHost;
  requester?: HttpRequester;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array> & { destroy(): void };
}

export type HttpRequester = (
  url: URL,
  options: {
    method: "GET";
    dispatcher: Dispatcher;
    signal?: AbortSignal;
    headers: Record<string, string>;
  },
) => Promise<HttpResponse>;

export class HttpFetchTool implements Tool {
  readonly name = "HttpFetch";
  readonly description =
    "Fetch untrusted text or JSON from an explicitly allowed HTTPS host.";
  readonly effect = "readonly" as const;
  readonly inputSchema = {
    type: "object",
    properties: {
      url: { type: "string" },
    },
    required: ["url"],
    additionalProperties: false,
  };
  readonly timeoutMs: number;

  private readonly allowedHosts: ReadonlySet<string>;
  private readonly allowedPorts: ReadonlySet<number>;
  private readonly allowHttpLocalhost: boolean;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly resolver: ResolveHost;
  private readonly requester: HttpRequester;

  constructor(options: HttpFetchOptions) {
    if (options.allowedHosts.length === 0) {
      throw new Error("HttpFetch requires at least one allowed host.");
    }
    for (const host of options.allowedHosts) {
      if (
        host.includes("*") ||
        canonicalHostname(host) !== host ||
        host.includes(":") ||
        host.includes("/")
      ) {
        throw new Error(
          `Allowed host "${host}" must be an exact, lowercase canonical hostname.`,
        );
      }
    }
    this.allowedHosts = new Set(options.allowedHosts);
    const allowedPorts = options.allowedPorts ?? [443];
    if (
      allowedPorts.length === 0 ||
      allowedPorts.some(
        (port) =>
          !Number.isInteger(port) || port < 1 || port > 65_535,
      )
    ) {
      throw new Error(
        "HttpFetch allowed ports must be integers between 1 and 65535.",
      );
    }
    this.allowedPorts = new Set(allowedPorts);
    this.allowHttpLocalhost = options.allowHttpLocalhost ?? false;
    this.maxRedirects = options.maxRedirects ?? 3;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.resolver = options.resolveHost ?? resolveHost;
    this.requester =
      options.requester ??
      (async (url, requestOptions) => request(url, requestOptions));

    if (
      !Number.isInteger(this.maxRedirects) ||
      this.maxRedirects < 0 ||
      !Number.isSafeInteger(this.maxResponseBytes) ||
      this.maxResponseBytes <= 0 ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs <= 0
    ) {
      throw new Error(
        "HttpFetch byte and timeout limits must be positive integers, and redirects must be a non-negative integer.",
      );
    }
  }

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (typeof args.url !== "string") {
      return { ok: false, content: "url must be a string." };
    }

    let current: URL;
    try {
      current = new URL(args.url);
    } catch {
      return { ok: false, content: "url must be an absolute URL." };
    }

    let redirects = 0;
    while (true) {
      let host: string;
      try {
        host = this.validateUrl(current);
        current.hostname = host;
      } catch (error) {
        return this.failure(error);
      }

      const allowLoopback =
        host === "localhost" &&
        (current.protocol === "https:" || this.allowHttpLocalhost);
      const dispatcher = this.createDispatcher(host, allowLoopback);

      try {
        const response = await this.requester(current, {
          method: "GET",
          dispatcher,
          signal: context?.signal,
          headers: {
            accept: "text/*, application/json, application/*+json",
            "user-agent": "harness-http-fetch/1",
          },
        });

        if (redirectStatuses.has(response.statusCode)) {
          response.body.destroy();
          const location = response.headers.location;
          if (!location) {
            return {
              ok: false,
              content: "HTTP redirect response did not include Location.",
            };
          }
          if (redirects >= this.maxRedirects) {
            return {
              ok: false,
              content: `HTTP redirect limit of ${this.maxRedirects} exceeded.`,
            };
          }
          current = new URL(
            Array.isArray(location) ? location[0] : location,
            current,
          );
          redirects += 1;
          continue;
        }

        const contentType = this.getContentType(response.headers["content-type"]);
        if (!isAllowedContentType(contentType)) {
          response.body.destroy();
          return {
            ok: false,
            content: `HTTP content type "${contentType || "[missing]"}" is not allowed.`,
          };
        }

        const body = await this.readLimitedBody(response.body);
        const finalUrl = safeDisplayUrl(current);
        return {
          ok: response.statusCode >= 200 && response.statusCode < 300,
          content:
            `[UNTRUSTED HTTP CONTENT from ${finalUrl}]\n` +
            `${body.toString("utf8")}\n[END UNTRUSTED HTTP CONTENT]`,
          data: {
            untrusted: true,
            url: finalUrl,
            statusCode: response.statusCode,
            contentType,
            bytes: body.byteLength,
            redirects,
          },
        };
      } catch (error) {
        return this.failure(error);
      } finally {
        await dispatcher.close();
      }
    }
  }

  private validateUrl(url: URL): string {
    if (url.username || url.password) {
      throw new Error("URL credentials are denied.");
    }
    if (url.hash) {
      throw new Error("URL fragments are denied.");
    }
    const host = canonicalHostname(url.hostname);
    if (!this.allowedHosts.has(host)) {
      throw new Error(`Host "${host}" is not in the HttpFetch allowlist.`);
    }
    const port = url.port
      ? Number(url.port)
      : url.protocol === "https:"
        ? 443
        : 80;
    if (!this.allowedPorts.has(port)) {
      throw new Error(
        `Port ${port} is not in the HttpFetch allowlist.`,
      );
    }
    // Node does not invoke a custom DNS lookup for IP-literal URLs, so validate
    // literals here instead of relying on the connection-time lookup guard.
    if (isIP(host)) {
      assertAllowedAddress(host, { allowLoopback: false });
    }
    if (url.protocol === "https:") {
      return host;
    }
    if (
      url.protocol === "http:" &&
      host === "localhost" &&
      this.allowHttpLocalhost
    ) {
      return host;
    }
    throw new Error("Only HTTPS URLs are allowed.");
  }

  private createDispatcher(hostname: string, allowLoopback: boolean): Agent {
    const resolver = this.resolver;
    return new Agent({
      connect: {
        lookup(host, options, callback) {
          const canonical = canonicalHostname(host);
          if (canonical !== hostname) {
            callback(
              new Error("Connection hostname changed after validation."),
              "",
              0,
            );
            return;
          }
          void (async () => {
            try {
              const addresses = await resolver(canonical);
              if (addresses.length === 0) {
                throw new Error(`DNS returned no addresses for ${canonical}.`);
              }
              for (const entry of addresses) {
                assertAllowedAddress(entry.address, { allowLoopback });
              }
              finishLookup(addresses, options, callback);
            } catch (error) {
              callback(
                error instanceof Error ? error : new Error(String(error)),
                "",
                0,
              );
            }
          })();
        },
      },
    });
  }

  private async readLimitedBody(
    body: HttpResponse["body"],
  ): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > this.maxResponseBytes) {
        body.destroy();
        throw new Error(
          `HTTP response exceeds ${this.maxResponseBytes} byte limit.`,
        );
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, bytes);
  }

  private getContentType(value: string | string[] | undefined): string {
    const raw = Array.isArray(value) ? value[0] : value;
    return raw?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  }

  private failure(error: unknown): ToolExecutionResult {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      content: `HttpFetch denied or failed: ${message}`,
      data: { untrusted: true },
    };
  }
}

function isAllowedContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    (contentType.startsWith("application/") && contentType.endsWith("+json"))
  );
}

function safeDisplayUrl(url: URL): string {
  const display = new URL(url);
  if (display.search) {
    display.search = "?[redacted]";
  }
  display.hash = "";
  return display.toString();
}

function finishLookup(
  addresses: LookupAddress[],
  options: LookupOptions,
  callback: Parameters<LookupFunction>[2],
): void {
  const requestedFamily =
    options.family === 4 || options.family === "IPv4"
      ? 4
      : options.family === 6 || options.family === "IPv6"
        ? 6
        : undefined;
  const eligible = requestedFamily
    ? addresses.filter(({ family }) => family === requestedFamily)
    : addresses;
  if (eligible.length === 0) {
    callback(
      new Error("DNS returned no address for the requested family."),
      "",
      0,
    );
    return;
  }
  if (options.all) {
    callback(null, eligible);
    return;
  }
  callback(null, eligible[0].address, eligible[0].family);
}
