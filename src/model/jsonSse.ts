export interface JsonSseOptions {
  maxStreamBytes: number;
  maxEventBytes: number;
  source: string;
}

export async function* parseJsonSse<T>(
  stream: ReadableStream<Uint8Array>,
  options: JsonSseOptions,
): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      receivedBytes += value?.byteLength ?? 0;
      if (receivedBytes > options.maxStreamBytes) {
        throw new Error(
          `${options.source} stream exceeded the configured safety limit.`,
        );
      }
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replaceAll("\r\n", "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        yield* parseBlock<T>(block, options);
        boundary = buffer.indexOf("\n\n");
      }
      if (Buffer.byteLength(buffer, "utf8") > options.maxEventBytes) {
        throw new Error(
          `${options.source} stream event exceeded the safety limit.`,
        );
      }
      if (done) {
        yield* parseBlock<T>(buffer, options);
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function* parseBlock<T>(
  block: string,
  options: JsonSseOptions,
): Generator<T> {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") {
    return;
  }
  if (Buffer.byteLength(data, "utf8") > options.maxEventBytes) {
    throw new Error(`${options.source} stream event exceeded the safety limit.`);
  }
  try {
    yield JSON.parse(data) as T;
  } catch {
    throw new Error(`${options.source} returned an invalid streaming event.`);
  }
}
