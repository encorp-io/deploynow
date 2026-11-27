import { NextResponse } from "next/server";
import type { Readable } from "stream";
import { endpointGate, dockerError, validRef, containerGuard } from "@/lib/endpointRoute";
import { demux, logBufferToText, isMultiplexed } from "@/lib/docker/streams";

type Params = { params: Promise<{ id: string; cid: string }> };

/**
 * GET …/logs?tail=500&timestamps=1            → { text }
 * GET …/logs?tail=200&follow=1                → text/event-stream, one event per chunk
 */
export async function GET(request: Request, { params }: Params) {
  const { id, cid } = await params;
  if (!validRef(cid)) return NextResponse.json({ error: "Invalid container id" }, { status: 400 });
  const gate = await endpointGate(id, "container.logs");
  if (!gate.ok) return gate.response;

  const url = new URL(request.url);
  const tail = Math.min(5000, Math.max(1, parseInt(url.searchParams.get("tail") || "500") || 500));
  const timestamps = url.searchParams.get("timestamps") === "1";
  const follow = url.searchParams.get("follow") === "1";
  const container = gate.ctx.docker.getContainer(cid);

  let tty = false;
  try {
    const info = await container.inspect();
    const guard = containerGuard(gate.ctx.user, id, info, "logs");
    if (guard.response) return guard.response;
    tty = info.Config.Tty;
  } catch (err) {
    return dockerError(err);
  }

  if (!follow) {
    try {
      const raw = (await container.logs({ stdout: true, stderr: true, tail, timestamps, follow: false })) as unknown as Buffer;
      return NextResponse.json({ text: logBufferToText(raw) });
    } catch (err) {
      return dockerError(err);
    }
  }

  let stream: Readable;
  try {
    stream = (await container.logs({ stdout: true, stderr: true, tail, timestamps, follow: true })) as unknown as Readable;
  } catch (err) {
    return dockerError(err);
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      let pending = Buffer.alloc(0);
      const send = (text: string, s = "stdout") => {
        if (text) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ s, t: text })}\n\n`));
      };
      stream.on("data", (chunk: Buffer) => {
        if (tty) return send(chunk.toString("utf8"));
        pending = Buffer.concat([pending, chunk]);
        if (!isMultiplexed(pending) && pending.length >= 8) {
          send(pending.toString("utf8"));
          pending = Buffer.alloc(0);
          return;
        }
        const { frames, rest } = demux(pending);
        pending = Buffer.from(rest);
        for (const f of frames) send(f.text, f.stream);
      });
      stream.on("end", () => {
        controller.enqueue(encoder.encode("event: end\ndata: {}\n\n"));
        controller.close();
      });
      stream.on("error", () => controller.close());
      // Keep proxies from closing an idle stream
      const ping = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 25_000);
      const stop = () => {
        clearInterval(ping);
        stream.destroy();
      };
      stream.on("close", () => clearInterval(ping));
      request.signal.addEventListener("abort", stop);
    },
    cancel() {
      stream.destroy();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
