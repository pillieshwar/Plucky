import { DurableObject } from "cloudflare:workers";

/**
 * TodoCity sync relay.
 *
 * A dumb, always-on mailbox: Macs put sealed boxes in, other Macs take them
 * out. Everything is encrypted on the Mac before it arrives, so the relay
 * never sees task content and never has a key.
 *
 * Mailboxes — one per group of Macs, named by the app from the group key.
 * Every call carries `Authorization: Bearer <pass>` (also derived from the
 * group key; the relay stores only its SHA-256, set by the first call) and
 * `X-Device: <id>`.
 *
 *   POST   /v1/m/{mailbox}/boxes             store one box → {box}
 *   GET    /v1/m/{mailbox}/boxes?after=n     → {boxes:[{box,from,data}], more, gap, latest, devices:[{id,seen}]}
 *   POST   /v1/m/{mailbox}/ack   {upto}      this device has everything ≤ upto
 *   PUT    /v1/m/{mailbox}/devices/{id} {acked}  a Mac joining: keep boxes for it
 *   DELETE /v1/m/{mailbox}/devices/{id}      a Mac left
 *   DELETE /v1/m/{mailbox}                   delete the mailbox
 *
 * A box is deleted once every Mac has acknowledged it, or after 30 days.
 * A Mac that comes back after its boxes were deleted gets `gap: true` and
 * asks the others (through the mailbox) for a full copy.
 *
 * Pairing rooms — a few small messages between two Macs for 10 minutes,
 * named by an 8-letter code. The messages are public keys and a sealed
 * invite; see the app's `sync::pair`.
 *
 *   POST   /v1/pair/{code}?new=1   open a room with its first message
 *   POST   /v1/pair/{code}         add a message
 *   GET    /v1/pair/{code}?after=n → {msgs:[...]}
 *   DELETE /v1/pair/{code}
 *
 *   GET    /health                 "ok"
 */

interface RateLimit {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  MAILBOX: DurableObjectNamespace<Mailbox>;
  ROOM: DurableObjectNamespace<Room>;
  /** Per address: every request, and opening/joining pairing rooms. */
  PER_IP?: RateLimit;
  PAIR_IP?: RateLimit;
}

const MAX_BOX = 256 * 1024; // bytes per box
const MAX_BOXES = 4000; // waiting boxes per mailbox
const MAX_BYTES = 64 * 1024 * 1024; // waiting bytes per mailbox
const MAX_DEVICES = 10;
const PAGE = 100;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DAY_MS = 24 * 60 * 60 * 1000;
// Per mailbox, per minute.
const CALLS_PER_MIN = 600;
const PUTS_PER_MIN = 300;

const ROOM_MS = 10 * 60 * 1000;
const ROOM_MSGS = 12;
const ROOM_MSG_MAX = 16 * 1024;

const ID = /^[A-Za-z0-9_-]{8,64}$/;

type Reply = { status: number; body?: unknown; text?: string };

/** One mailbox: its own tiny SQLite database of sealed boxes. */
export class Mailbox extends DurableObject<Env> {
  private window = 0;
  private calls = 0;
  private puts = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS boxes (
      n INTEGER PRIMARY KEY AUTOINCREMENT,
      blob BLOB NOT NULL,
      at INTEGER NOT NULL,
      dev TEXT NOT NULL DEFAULT ''
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      acked INTEGER NOT NULL,
      seen INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    // Mailboxes made by the starter relay had no `dev` column.
    const cols = sql.exec<{ name: string }>("PRAGMA table_info(boxes)").toArray();
    if (!cols.some((c) => c.name === "dev")) sql.exec("ALTER TABLE boxes ADD COLUMN dev TEXT NOT NULL DEFAULT ''");
  }

  private meta(k: string): string | null {
    const r = this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray();
    return r.length ? r[0].v : null;
  }

  private setMeta(k: string, v: string) {
    this.ctx.storage.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
  }

  /** Highest box number ever deleted: reading from below it means a gap. */
  private floor(): number {
    return Number(this.meta("floor") ?? 0);
  }

  private latest(): number {
    const r = this.ctx.storage.sql.exec<{ n: number | null }>("SELECT MAX(n) AS n FROM boxes").one().n;
    return Math.max(r ?? 0, Number(this.meta("latest") ?? 0));
  }

  private allow(write: boolean): boolean {
    const minute = Math.floor(Date.now() / 60000);
    if (minute !== this.window) {
      this.window = minute;
      this.calls = 0;
      this.puts = 0;
    }
    this.calls++;
    if (write) this.puts++;
    return this.calls <= CALLS_PER_MIN && this.puts <= PUTS_PER_MIN;
  }

  /** Check the pass (setting it on first use) and note the device. */
  private enter(passHash: string, device: string): Reply | null {
    const known = this.meta("pass");
    if (known === null) {
      if (this.meta("deleted")) return { status: 410, text: "This mailbox was deleted" };
      this.setMeta("pass", passHash);
    } else if (known !== passHash) {
      return { status: 401, text: "Wrong pass" };
    }
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    const had = sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM devices WHERE id = ?", device).one().c;
    if (had) {
      sql.exec("UPDATE devices SET seen = ? WHERE id = ?", now, device);
    } else {
      const count = sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM devices").one().c;
      if (count >= MAX_DEVICES) return { status: 403, text: "Too many Macs in this group" };
      // A Mac nobody announced: it starts from what's still here.
      sql.exec("INSERT INTO devices (id, acked, seen) VALUES (?, ?, ?)", device, this.floor(), now);
    }
    return null;
  }

  async handle(
    passHash: string,
    device: string,
    method: string,
    action: string,
    arg: string,
    body: ArrayBuffer,
  ): Promise<Reply> {
    if (!this.allow(method !== "GET")) return { status: 429, text: "Slow down" };
    const denied = this.enter(passHash, device);
    if (denied) return denied;
    const sql = this.ctx.storage.sql;

    if (action === "boxes" && method === "POST") {
      if (!body.byteLength || body.byteLength > MAX_BOX) return { status: 413, text: "Box must be 1 byte to 256 KB" };
      const { c, bytes } = sql
        .exec<{ c: number; bytes: number | null }>("SELECT COUNT(*) AS c, SUM(length(blob)) AS bytes FROM boxes")
        .one();
      if (c >= MAX_BOXES || (bytes ?? 0) + body.byteLength > MAX_BYTES) return { status: 507, text: "Mailbox full" };
      const at = Date.now();
      const { n } = sql
        .exec<{ n: number }>("INSERT INTO boxes (blob, at, dev) VALUES (?, ?, ?) RETURNING n", body, at, device)
        .one();
      this.setMeta("latest", String(n));
      // A Mac has seen its own box.
      sql.exec("UPDATE devices SET acked = MAX(acked, ?) WHERE id = ? AND acked = ? - 1", n, device, n);
      if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(at + DAY_MS);
      return { status: 200, body: { box: n } };
    }

    if (action === "boxes" && method === "GET") {
      const after = Math.max(0, Math.floor(Number(arg) || 0));
      const floor = this.floor();
      const rows = sql
        .exec<{ n: number; blob: ArrayBuffer; dev: string }>(
          "SELECT n, blob, dev FROM boxes WHERE n > ? ORDER BY n LIMIT ?",
          after,
          PAGE + 1,
        )
        .toArray();
      const more = rows.length > PAGE;
      return {
        status: 200,
        body: {
          boxes: rows.slice(0, PAGE).map((r) => ({ box: r.n, from: r.dev, data: base64(r.blob) })),
          more,
          gap: after < floor,
          latest: this.latest(),
          // When each Mac last checked in, so the others can show it.
          devices: sql.exec<{ id: string; seen: number }>("SELECT id, seen FROM devices").toArray(),
        },
      };
    }

    if (action === "ack" && method === "POST") {
      const upto = Math.floor(Number(parseJson(body)?.upto) || 0);
      if (upto < 0 || upto > this.latest()) return { status: 400, text: "Bad ack" };
      sql.exec("UPDATE devices SET acked = MAX(acked, ?) WHERE id = ?", upto, device);
      this.sweep();
      return { status: 200, body: { ok: true } };
    }

    if (action === "devices" && ID.test(arg)) {
      if (method === "PUT") {
        const acked = Math.max(0, Math.floor(Number(parseJson(body)?.acked) || 0));
        const count = sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM devices WHERE id != ?", arg).one().c;
        if (count >= MAX_DEVICES) return { status: 403, text: "Too many Macs in this group" };
        sql.exec(
          "INSERT INTO devices (id, acked, seen) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET acked = MIN(acked, excluded.acked), seen = excluded.seen",
          arg,
          Math.max(acked, this.floor()),
          Date.now(),
        );
        return { status: 200, body: { ok: true } };
      }
      if (method === "DELETE") {
        sql.exec("DELETE FROM devices WHERE id = ?", arg);
        this.sweep();
        return { status: 200, body: { ok: true } };
      }
    }

    if (action === "" && method === "DELETE") {
      await this.ctx.storage.deleteAlarm();
      sql.exec("DELETE FROM boxes");
      sql.exec("DELETE FROM devices");
      sql.exec("DELETE FROM meta");
      // Remember it's gone, so the old pass can't quietly reopen it.
      this.setMeta("deleted", "1");
      return { status: 200, body: { ok: true } };
    }

    return { status: 405, text: "Method not allowed" };
  }

  /** Delete boxes every Mac has. Macs not seen for 30 days don't count. */
  private sweep() {
    const sql = this.ctx.storage.sql;
    const live = sql
      .exec<{ m: number | null }>("SELECT MIN(acked) AS m FROM devices WHERE seen >= ?", Date.now() - KEEP_MS)
      .one().m;
    if (live === null) return;
    const gone = sql.exec<{ n: number | null }>("SELECT MAX(n) AS n FROM boxes WHERE n <= ?", live).one().n;
    if (gone === null) return;
    sql.exec("DELETE FROM boxes WHERE n <= ?", live);
    this.setMeta("floor", String(Math.max(this.floor(), gone)));
  }

  /** Once a day: drop boxes older than 30 days and Macs gone that long. */
  async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const cutoff = Date.now() - KEEP_MS;
    const old = sql.exec<{ n: number | null }>("SELECT MAX(n) AS n FROM boxes WHERE at < ?", cutoff).one().n;
    if (old !== null) {
      sql.exec("DELETE FROM boxes WHERE n <= ?", old);
      this.setMeta("floor", String(Math.max(this.floor(), old)));
    }
    sql.exec("DELETE FROM devices WHERE seen < ?", cutoff);
    this.sweep();
    const left = sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM boxes").one().c;
    const devices = sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM devices").one().c;
    if (left || devices) {
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    } else if (!this.meta("deleted")) {
      // Nobody's used it in 30 days: forget it entirely.
      await this.ctx.storage.deleteAll();
    }
  }
}

/** A pairing room: a few messages, for 10 minutes. */
export class Room extends DurableObject<Env> {
  async handle(method: string, create: boolean, after: number, body: string): Promise<Reply> {
    const s = this.ctx.storage;
    const opened = await s.get<number>("opened");
    const live = opened !== undefined && Date.now() - opened < ROOM_MS;
    if (opened !== undefined && !live) {
      await s.deleteAll();
      await s.deleteAlarm();
    }

    if (method === "POST") {
      if (!body || body.length > ROOM_MSG_MAX) return { status: 413, text: "Message must be 1 byte to 16 KB" };
      if (create) {
        if (live) return { status: 409, text: "That code is taken" };
        await s.put({ opened: Date.now(), msgs: [body] });
        await s.setAlarm(Date.now() + ROOM_MS);
        return { status: 200, body: { ok: true } };
      }
      if (!live) return { status: 404, text: "No such code" };
      const msgs = (await s.get<string[]>("msgs")) ?? [];
      if (msgs.length >= ROOM_MSGS) return { status: 429, text: "Room is full" };
      msgs.push(body);
      await s.put("msgs", msgs);
      return { status: 200, body: { ok: true } };
    }
    if (method === "GET") {
      if (!live) return { status: 404, text: "No such code" };
      const msgs = (await s.get<string[]>("msgs")) ?? [];
      return { status: 200, body: { msgs: msgs.slice(Math.max(0, after)) } };
    }
    if (method === "DELETE") {
      await s.deleteAll();
      await s.deleteAlarm();
      return { status: 200, body: { ok: true } };
    }
    return { status: 405, text: "Method not allowed" };
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function parseJson(body: ArrayBuffer): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return base64(d);
}

const headers = { "cache-control": "no-store" };
const text = (body: string, status: number) =>
  new Response(body, { status, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
const send = (r: Reply) => (r.body !== undefined ? Response.json(r.body, { status: r.status, headers }) : text(r.text ?? "", r.status));

async function limited(rl: RateLimit | undefined, key: string): Promise<boolean> {
  if (!rl) return false;
  try {
    return !(await rl.limit({ key })).success;
  } catch {
    return false;
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return text("ok", 200);
    const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
    if (await limited(env.PER_IP, ip)) return text("Slow down", 429);

    // Mailboxes.
    const m = url.pathname.match(/^\/v1\/m\/([A-Za-z0-9_-]{22,64})(?:\/(boxes|ack|devices)(?:\/([A-Za-z0-9_-]{1,64}))?)?$/);
    if (m) {
      const auth = req.headers.get("authorization") ?? "";
      const pass = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const device = req.headers.get("x-device") ?? "";
      if (pass.length < 32) return text("Missing pass", 401);
      if (!ID.test(device)) return text("Missing device", 400);
      const len = Number(req.headers.get("content-length") ?? 0);
      if (len > MAX_BOX) return text("Box must be 1 byte to 256 KB", 413);
      const body = req.method === "GET" || req.method === "DELETE" ? new ArrayBuffer(0) : await req.arrayBuffer();
      const action = m[2] ?? "";
      const arg = action === "boxes" ? (url.searchParams.get("after") ?? "0") : (m[3] ?? "");
      if (action === "devices" && !m[3]) return text("Not found", 404);
      const box = env.MAILBOX.get(env.MAILBOX.idFromName(m[1]));
      return send(await box.handle(await sha256(pass), device, req.method, action, arg, body));
    }

    // Pairing rooms.
    const p = url.pathname.match(/^\/v1\/pair\/([2-9A-HJ-NP-Z]{8})$/);
    if (p) {
      const create = url.searchParams.get("new") === "1";
      if (req.method === "POST" && (await limited(env.PAIR_IP, ip))) return text("Slow down", 429);
      const len = Number(req.headers.get("content-length") ?? 0);
      if (len > ROOM_MSG_MAX) return text("Message must be 1 byte to 16 KB", 413);
      const body = req.method === "POST" ? await req.text() : "";
      const after = Math.floor(Number(url.searchParams.get("after") ?? 0) || 0);
      const room = env.ROOM.get(env.ROOM.idFromName(p[1]));
      return send(await room.handle(req.method, create, after, body));
    }

    return text("Not found", 404);
  },
};
