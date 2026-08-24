/**
 * WallHub — the live-update fan-out.
 *
 * On the Node build a plain `Set` of open responses was enough, because one
 * process held every connection. Workers spreads requests across isolates that
 * share no memory, so the subscriber list has to live somewhere single-homed:
 * one Durable Object that every wall, projector and API call talks to.
 *
 * Nothing is persisted. The DO is used purely as a rendezvous point, which is
 * why it costs effectively nothing on the free plan.
 */
export class WallHub {
  constructor(state) {
    this.state = state;
    /** @type {Set<WritableStreamDefaultWriter>} */
    this.subscribers = new Set();
    this.encoder = new TextEncoder();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/subscribe') return this.subscribe();

    if (url.pathname === '/publish') {
      const { event, payload } = await request.json();
      this.broadcast(event, payload);
      return new Response(null, { status: 204 });
    }

    return new Response('not found', { status: 404 });
  }

  subscribe() {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    this.subscribers.add(writer);

    writer.write(this.encoder.encode('retry: 3000\n\n')).catch(() => this.drop(writer));

    // Proxies and phones both drop a stream that goes quiet; a comment line
    // every 25s keeps it open without waking any page code.
    const ping = setInterval(() => {
      writer.write(this.encoder.encode(': ping\n\n')).catch(() => {
        clearInterval(ping);
        this.drop(writer);
      });
    }, 25_000);

    writer.closed.catch(() => {}).finally(() => {
      clearInterval(ping);
      this.drop(writer);
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  broadcast(event, payload = {}) {
    const frame = this.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    for (const writer of this.subscribers) {
      writer.write(frame).catch(() => this.drop(writer));
    }
  }

  drop(writer) {
    this.subscribers.delete(writer);
    try {
      writer.close();
    } catch {
      /* already gone */
    }
  }
}

/** Every page and route shares one hub instance. */
export function hub(env) {
  return env.WALL_HUB.get(env.WALL_HUB.idFromName('global'));
}

export async function publish(env, event, payload) {
  await hub(env).fetch('https://hub/publish', {
    method: 'POST',
    body: JSON.stringify({ event, payload }),
  });
}
