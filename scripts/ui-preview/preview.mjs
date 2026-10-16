// Renders Plucky's UI in Chromium with a fake Tauri backend and saves
// screenshots of the main states. Used by .github/workflows/ui-preview.yml.
//
//   node scripts/ui-preview/preview.mjs http://localhost:4173 out/
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const [base = "http://localhost:4173", out = "ui-preview-out"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return iso(d);
};

const hm = (offsetMin) => {
  const d = new Date(Date.now() + offsetMin * 60000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const localStamp = (offsetMin) => {
  const d = new Date(Date.now() + offsetMin * 60000);
  return `${iso(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
};

let nextId = 1;
const task = (title, extra = {}) => ({
  id: nextId++,
  title,
  due_date: null,
  due_time: null,
  recurrence: null,
  source_text: null,
  source_app: null,
  source_bundle: null,
  source_url: null,
  done: false,
  created_at: "2026-10-10T10:00:00Z",
  created_tz: null,
  completed_at: null,
  snoozed_until: null,
  notified_at: null,
  next_id: null,
  notes: null,
  ...extra,
});

const TASKS = [
  task("Send Q3 numbers to Priya #work", {
    due_date: day(0),
    due_time: hm(-5),
    notified_at: localStamp(-5),
    source_app: "Slack",
    source_bundle: "com.tinyspeck.slackmacgap",
    source_url: "https://app.slack.com/client/T1/C2",
    source_text: "Could you send me the Q3 numbers by 3pm today?",
  }),
  task("Review the rollout checklist", {
    due_date: day(0),
    source_app: "Mail",
    notes: "Checklist: https://docs.example.com/rollout/v2 — ping Dana before sign-off",
  }),
  task("Water the plants #home", { due_date: day(0), due_time: hm(40), recurrence: "weekly" }),
  task("Renew passport", { due_date: day(-3) }),
  task("Reply to the design review thread #work", {
    due_date: day(1),
    source_app: "Google Chrome",
    source_url: "https://github.com/acme/app/pull/42",
  }),
  task("Book a room for Monday's review", { due_date: day(3), due_time: "10:30" }),
  task("Read the onboarding doc", {}),
  task("Pay rent #home", { due_date: day(0), done: true, completed_at: new Date().toISOString() }),
];

const SETTINGS = {
  notify: { enabled: true, all_day_time: "09:00", daily_summary: false },
  auto_update: true,
  remember_source: true,
  onboarding_done: true,
  autostart_initialized: true,
  last_summary: null,
  last_backup: null,
  seen_version: "0.2.1",
  show_on_start: true,
  last_greeted: null,
  menubar_placed: true,
  capture_in_menu_bar: true,
};

const SHORTCUTS = {
  capture: { meta: true, ctrl: false, alt: false, shift: true, code: "KeyS" },
  quick_add: { meta: true, ctrl: false, alt: false, shift: true, code: "Space" },
  toggle_panel: { meta: true, ctrl: false, alt: false, shift: true, code: "KeyH" },
};

function scenario(overrides = {}) {
  return {
    label: "panel",
    tasks: TASKS,
    settings: SETTINGS,
    status: { accessibility: true, engine: "bundled", active_model: "Llama 3.2 3B Instruct", version: "0.2.1", platform: "macos" },
    update: { state: "idle" },
    extract: null,
    backups: [
      { name: `tasks-${day(0)}.db`, day: day(0), size: 48_000 },
      { name: `tasks-${day(-1)}.db`, day: day(-1), size: 47_000 },
    ],
    ...overrides,
  };
}

/** Installed before the app loads: a fake `window.__TAURI_INTERNALS__`. */
function mockTauri(s) {
  const callbacks = new Map();
  const listeners = new Map();
  let id = 1;
  window.__emit = (event, payload) => {
    for (const cb of listeners.get(event) ?? []) callbacks.get(cb)?.({ event, id: 0, payload });
  };
  const responses = {
    list_tasks: () => s.tasks,
    status: () => s.status,
    get_settings: () => s.settings,
    set_settings: (a) => a.value,
    get_shortcuts: () => s.shortcuts,
    update_status: () => s.update,
    list_models: () => [
      {
        id: "llama-3.2-3b",
        name: "Llama 3.2 3B Instruct",
        publisher: "Meta",
        description:
          "The best balance of quality and speed for most Macs. Reads messages, emails and web pages well and handles dates reliably.",
        license: "Llama 3.2 Community License",
        repo: "x",
        file: "x",
        approx_size_mb: 2020,
        min_ram_gb: 8,
        recommended: true,
        installed: !!s.status.active_model,
        active: !!s.status.active_model,
        partial_bytes: 0,
        progress: null,
      },
    ],
    list_local_models: () => s.local ?? { added: [], found: [] },
    reminders_status: () => s.reminders ?? ({
      supported: true,
      access: "not_determined",
      enabled: false,
      include_notes: false,
      list: null,
      linked: 0,
      last_sync: null,
      last_error: null,
    }),
    notification_permission: () => "granted",
    calendar_status: () => s.calendar ?? { supported: true, access: "not_determined", enabled: false, calendars: null },
    calendar_calendars: () => [
      { id: "c1", title: "Work", source: "Google", color: "#3b82f6" },
      { id: "c2", title: "Home", source: "iCloud", color: "#16a34a" },
      { id: "c3", title: "Birthdays", source: "Other", color: "#a855f7" },
    ],
    calendar_events: () => s.events ?? [],
    autostart_enabled: () => true,
    list_backups: () => s.backups,
    extract: () => (s.extract === "pending" ? new Promise(() => {}) : s.extract),
    update_task: (a) => ({ ...s.tasks.find((t) => t.id === a.id), ...a.patch }),
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: s.label }, currentWebview: { label: s.label, windowLabel: s.label } },
    transformCallback(cb) {
      const n = id++;
      callbacks.set(n, cb);
      return n;
    },
    unregisterCallback(n) {
      callbacks.delete(n);
    },
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      if (cmd === "plugin:event|listen") {
        const list = listeners.get(args.event) ?? [];
        list.push(args.handler);
        listeners.set(args.event, list);
        return id++;
      }
      if (cmd.startsWith("plugin:")) return null;
      const f = responses[cmd];
      return f ? f(args ?? {}) : null;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
}

const browser = await chromium.launch();

async function shot(name, size, s, steps = async () => {}, dark = false) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 2 });
  await page.emulateMedia({ colorScheme: dark ? "dark" : "light", reducedMotion: "reduce" });
  await page.addInitScript(mockTauri, { ...s, shortcuts: SHORTCUTS });
  await page.goto(`${base}/?view=${s.label}`);
  await page.waitForTimeout(400);
  await steps(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${name}.png` });
  await page.close();
  console.log("saved", name);
}

const PANEL = { width: 360, height: 720 };
const POP = { width: 340, height: 540 };
const QUICK = { width: 640, height: 300 };

await shot("panel-tasks", PANEL, scenario());
await shot("panel-tasks-dark", PANEL, scenario(), async () => {}, true);
await shot("panel-focus-keys", PANEL, scenario(), async (p) => {
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("ArrowDown");
});
await shot("panel-focus-today", PANEL, scenario(), async (p) => {
  await p.keyboard.press("f");
});
await shot("panel-snooze", PANEL, scenario(), async (p) => {
  await p.locator(".task").nth(2).hover();
  await p.locator(".task").nth(2).locator(".task-date").first().click({ force: true });
});
await shot("panel-notes-edit", PANEL, scenario(), async (p) => {
  await p.locator(".task").nth(3).hover();
  await p.locator(".task").nth(3).locator('[aria-label="Add a description"]').click({ force: true });
  await p.keyboard.type("Deck: https://slides.example.com/q3");
});
await shot("panel-keys-sheet", PANEL, scenario(), async (p) => {
  await p.keyboard.press("Shift+Slash");
});
await shot("panel-date-editor", PANEL, scenario(), async (p) => {
  await p.locator(".task-date").nth(1).click({ force: true });
  await p.keyboard.type("fri 3pm every week");
});
await shot("panel-search", PANEL, scenario(), async (p) => {
  await p.locator(".tag-chip").first().click();
});
await shot("panel-toast", PANEL, scenario(), async (p) => {
  await p.locator(".check").nth(1).click();
  await p.waitForTimeout(700);
});
await shot(
  "panel-capture-single",
  PANEL,
  scenario({ extract: { task: "Water the plants", date_text: "every Monday morning", date_confidence: "high" } }),
  async (p) => {
    await p.evaluate(() =>
      window.__emit("capture", {
        kind: "text",
        method: "clipboard",
        text: "Reminder: water the plants every Monday morning.",
        source: { app: "Notes", bundle: "com.apple.Notes", url: null },
      }),
    );
  },
);
await shot("panel-extracting", PANEL, scenario({ extract: "pending" }), async (p) => {
  await p.evaluate(() =>
    window.__emit("capture", {
      kind: "text",
      method: "accessibility",
      text: "Can you review the rollout checklist and send comments by Friday?",
      source: { app: "Mail", bundle: "com.apple.mail", url: null },
    }),
  );
});
await shot("panel-settings", PANEL, scenario({ update: { state: "ready", version: "0.2.1", notes: null } }), async (p) => {
  await p.getByRole("tab", { name: "Settings" }).click();
  await p.locator(".settings-h", { hasText: "General" }).scrollIntoViewIfNeeded();
});
await shot("panel-settings-data", PANEL, scenario(), async (p) => {
  await p.getByRole("tab", { name: "Settings" }).click();
  await p.locator(".settings-h", { hasText: "Your data" }).scrollIntoViewIfNeeded();
});
await shot(
  "panel-onboarding",
  PANEL,
  scenario({
    tasks: [],
    settings: { ...SETTINGS, onboarding_done: false },
    status: { accessibility: false, engine: "bundled", active_model: null, version: "0.2.1", platform: "macos" },
  }),
);
const FRESH = scenario({
  tasks: [],
  settings: { ...SETTINGS, onboarding_done: false },
  status: { accessibility: true, engine: "bundled", active_model: null, version: "0.4.1", platform: "macos" },
});
for (let step = 1; step <= 7; step++) {
  await shot(`panel-tour-${step}`, PANEL, FRESH, async (p) => {
    for (let i = 1; i < step; i++) {
      await p.locator(".onboard-actions .primary").click();
      await p.waitForTimeout(150);
    }
  });
}
await shot(
  "panel-models",
  PANEL,
  scenario({
    local: {
      added: [],
      found: [{ name: "llama3.2:3b", path: "/Users/me/.ollama/models/blobs/sha256-x", source: "Ollama", size: 2_019_000_000 }],
    },
  }),
  async (p) => {
    await p.getByRole("tab", { name: "Models" }).click();
  },
);
await shot("panel-models-local-open", PANEL, scenario(), async (p) => {
  await p.getByRole("tab", { name: "Models" }).click();
  await p.locator(".local-toggle").click();
  await p.locator(".local-toggle").scrollIntoViewIfNeeded();
});
await shot(
  "panel-connectors-reminders-on",
  PANEL,
  scenario({
    reminders: {
      supported: true,
      access: "full",
      enabled: true,
      include_notes: false,
      list: { id: "l1", title: "Plucky", source: "iCloud", icloud: true, leaves_mac: true, writable: true },
      linked: 12,
      last_sync: new Date().toISOString(),
      last_error: null,
    },
  }),
  async (p) => {
    await p.getByRole("tab", { name: "Connectors" }).click();
    await p.locator(".connector-action").nth(1).click();
  },
);
await shot("panel-update-downloading", PANEL, scenario({ update: { state: "downloading", version: "0.4.5", percent: 40 } }));
await shot("panel-update-ready", PANEL, scenario({ update: { state: "ready", version: "0.4.5", notes: null } }));
await shot("panel-update-ready-dark", PANEL, scenario({ update: { state: "ready", version: "0.4.5", notes: null } }), async () => {}, true);
const CAPTURED = {
  kind: "text",
  method: "accessibility",
  text: "Hey — can you send the Q3 numbers to Priya by Friday 3pm? Thanks!",
  source: { app: "Slack", bundle: "com.tinyspeck.slackmacgap", url: null },
};
await shot(
  "popover-capture",
  POP,
  scenario({
    label: "popover",
    extract: { task: "Send Q3 numbers to Priya", date_text: "by Friday 3pm", date_confidence: "high" },
  }),
  async (p) => {
    await p.evaluate((c) => window.__emit("capture", c), CAPTURED);
    await p.waitForTimeout(300);
  },
);
await shot("popover-capture-reading", POP, scenario({ label: "popover", extract: "pending" }), async (p) => {
  await p.evaluate((c) => window.__emit("capture", c), CAPTURED);
});
await shot(
  "popover-capture-dark",
  POP,
  scenario({
    label: "popover",
    extract: { task: "Send Q3 numbers to Priya", date_text: "by Friday 3pm", date_confidence: "high" },
  }),
  async (p) => {
    await p.evaluate((c) => window.__emit("capture", c), CAPTURED);
    await p.waitForTimeout(300);
  },
  true,
);
const EV_DAY = day(0);
const CAL_ON = { supported: true, access: "full", enabled: true, calendars: ["c1", "c2"] };
const EVENTS = [
  { id: "e0", title: "Office closed (half day)", start: `${EV_DAY}T00:00:00`, end: `${day(1)}T00:00:00`, all_day: true, calendar: "Work", color: "#3b82f6" },
  { id: "e1", title: "Standup", start: `${EV_DAY}T09:30:00`, end: `${EV_DAY}T09:45:00`, all_day: false, calendar: "Work", color: "#3b82f6" },
  { id: "e2", title: "Design review with Priya", start: `${EV_DAY}T13:00:00`, end: `${EV_DAY}T14:00:00`, all_day: false, calendar: "Work", color: "#3b82f6" },
  { id: "e3", title: "Pick up groceries", start: `${EV_DAY}T18:00:00`, end: `${EV_DAY}T18:30:00`, all_day: false, calendar: "Home", color: "#16a34a" },
];
await shot("panel-connectors", PANEL, scenario(), async (p) => {
  await p.getByRole("tab", { name: "Connectors" }).click();
});
await shot("panel-connectors-calendar", PANEL, scenario({ calendar: CAL_ON }), async (p) => {
  await p.getByRole("tab", { name: "Connectors" }).click();
  await p.locator(".connector-action").first().click();
});
await shot("panel-connectors-reminders", PANEL, scenario(), async (p) => {
  await p.getByRole("tab", { name: "Connectors" }).click();
  await p.locator(".connector-action").nth(1).click();
});
await shot("popover-events", POP, scenario({ label: "popover", calendar: CAL_ON, events: EVENTS }));
await shot("popover-events-dark", POP, scenario({ label: "popover", calendar: CAL_ON, events: EVENTS }), async () => {}, true);
await shot("panel-empty", PANEL, scenario({ tasks: [] }));
await shot("panel-whats-new", PANEL, scenario({ settings: { ...SETTINGS, seen_version: "0.1.6" } }));
await shot("popover", POP, scenario({ label: "popover" }));
await shot("popover-dark", POP, scenario({ label: "popover" }), async () => {}, true);
await shot("popover-drag", POP, scenario({ label: "popover" }), async (p) => {
  const row = p.locator(".pop-row").nth(1);
  const box = await row.boundingBox();
  const target = await p.locator(".pop-day").nth(12).boundingBox();
  await p.mouse.move(box.x + 60, box.y + 12);
  await p.mouse.down();
  await p.mouse.move(box.x + 80, box.y - 20, { steps: 4 });
  await p.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
});
await shot("popover-add", POP, scenario({ label: "popover" }), async (p) => {
  await p.keyboard.press("n");
  await p.keyboard.type("dentist fri 3pm");
});
await shot("quick-empty", QUICK, scenario({ label: "quick" }));
await shot("quick-typed", QUICK, scenario({ label: "quick" }), async (p) => {
  await p.keyboard.type("pay rent friday 5pm every month #home");
});
await shot("quick-typed-dark", QUICK, scenario({ label: "quick" }), async (p) => {
  await p.keyboard.type("call mom tomorrow 6pm");
}, true);

await browser.close();
