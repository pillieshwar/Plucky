import { DurableObject } from "cloudflare:workers";

/**
 * Todo City sync relay (starter).
 *
 * A dumb, always-on mailbox: Macs put encrypted boxes in, other Macs take
 * them out. Everything is encrypted on the Mac before it arrives, so the
 * relay never sees task content and never has a key.
 *
 *   PUT /v1/m/{mailbox}/boxes            store one box → {"box": n}
 *   GET /v1/m/{mailbox}/boxes?after=n    boxes newer than n → [{box, data}]
 *   GET /health                          "ok"
 *
 * Still to come before real users: device tokens, acknowledgements,
 * pairing rooms and per-device rate limits.
 */

interface Env {
  MAILBOX: DurableObjectNamespace<Mailbox>;
}

const MAX_BOX = 256 * 1024; // bytes per box
const MAX_BOXES = 2000; // waiting boxes per mailbox
const KEEP_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DAY_MS = 24 * 60 * 60 * 1000;

/** One mailbox: its own tiny SQLite database of encrypted boxes. */
export class Mailbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS boxes (
      n INTEGER PRIMARY KEY AUTOINCREMENT,
      blob BLOB NOT NULL,
      at INTEGER NOT NULL
    )`);
  }

  /** Store a box; its number, or null when the mailbox is full. */
  async put(blob: ArrayBuffer): Promise<number | null> {
    const waiting = this.ctx.storage.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM boxes").one().c;
    if (waiting >= MAX_BOXES) return null;
    const at = Date.now();
    const { n } = this.ctx.storage.sql
      .exec<{ n: number }>("INSERT INTO boxes (blob, at) VALUES (?, ?) RETURNING n", blob, at)
      .one();
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(at + DAY_MS);
    return n;
  }

  /** Boxes after `after`, oldest first, up to 100 at a time. */
  async list(after: number): Promise<{ n: number; blob: ArrayBuffer }[]> {
    return this.ctx.storage.sql
      .exec<{ n: number; blob: ArrayBuffer }>("SELECT n, blob FROM boxes WHERE n > ? ORDER BY n LIMIT 100", after)
      .toArray();
  }

  /** Once a day: delete anything older than 30 days. */
  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM boxes WHERE at < ?", Date.now() - KEEP_MS);
    const left = this.ctx.storage.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM boxes").one().c;
    if (left) await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
  }
}

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return text("ok", 200);

    // Mailbox IDs are long random strings made by the app.
    const m = url.pathname.match(/^\/v1\/m\/([A-Za-z0-9_-]{22,64})\/boxes$/);
    if (!m) return text("Not found", 404);
    const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(m[1]));

    if (req.method === "PUT") {
      const body = await req.arrayBuffer();
      if (!body.byteLength || body.byteLength > MAX_BOX) return text("Box must be 1 byte to 256 KB", 413);
      const n = await mailbox.put(body);
      if (n === null) return text("Mailbox full", 429);
      return Response.json({ box: n }, { headers: { "cache-control": "no-store" } });
    }
    if (req.method === "GET") {
      const after = Math.max(0, Math.floor(Number(url.searchParams.get("after") ?? 0) || 0));
      const rows = await mailbox.list(after);
      return Response.json(
        rows.map((r) => ({ box: r.n, data: base64(r.blob) })),
        { headers: { "cache-control": "no-store" } },
      );
    }
    return text("Method not allowed", 405);
  },
};
