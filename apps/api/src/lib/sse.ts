import type { ChatEvent } from "@lumen/runtime";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Streams chat events as Server-Sent Events. The first event has already been pulled (so setup errors became
 * normal JSON responses); this writes it and the rest, and aborts the model call if the client disconnects.
 */
export async function streamChatEvents(
  req: FastifyRequest,
  reply: FastifyReply,
  first: IteratorResult<ChatEvent>,
  rest: AsyncIterable<ChatEvent>,
  abort: AbortController,
): Promise<void> {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  const send = (e: ChatEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  try {
    if (!first.done) send(first.value);
    for await (const e of rest) {
      if (res.destroyed) break;
      send(e);
    }
  } catch (err) {
    req.log.error({ err }, "chat stream failed");
    send({ type: "error", code: "internal", message: "Something went wrong while answering." });
  } finally {
    res.end();
  }
}
