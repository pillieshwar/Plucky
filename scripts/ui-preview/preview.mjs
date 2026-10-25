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
  deadline: null,
  evening: false,
  someday: false,
  project: null,
  heading: null,
  checklist: [],
  series_date: null,
  paused: false,
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
  theme: "system",
  theme_v2: true,
  double_copy: true,
  city_name: "Lumen Bay",
  city_corner: true,
  mayor_name: "Sam",
  undated_nudge: true,
  undated_time: "16:00",
  last_undated_nudge: null,
  due_spotlight: true,
  agents_enabled: false,
  agents_proactive: true,
  email: {
    enabled: false,
    start: "09:00",
    end: "17:00",
    interval: 30,
    weekdays_only: false,
    server: null,
    last_ok: null,
    last: null,
  },
  watch: {
    enabled: false,
    apps: [],
    excluded: [],
    plugged_in_only: false,
    show_right_away: true,
    paused_until: null,
    names: {},
  },
};

const agentApp = (id, name, installed, connected = false) => ({
  id,
  name,
  installed,
  connected,
  stale: false,
  restart_hint: "Restart the app to finish.",
});
const AGENT_STATUS = {
  supported: true,
  enabled: false,
  proactive: true,
  command: "/Applications/Plucky.app/Contents/MacOS/Pluck",
  temporary_location: false,
  apps: [
    agentApp("claude_code", "Claude Code", true),
    agentApp("claude_desktop", "Claude Desktop", true),
    agentApp("cursor", "Cursor", true),
    agentApp("vscode", "VS Code", false),
    agentApp("windsurf", "Windsurf", false),
    agentApp("lm_studio", "LM Studio", false),
  ],
  pending: 0,
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
    agents: AGENT_STATUS,
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
    agents_status: () => s.agents,
    agents_test: () => "Working — AI apps can send tasks to Plucky.",
    inbox_list: () => s.inbox ?? [],
    watch_status: () =>
      s.watch ?? {
        supported: true,
        default_name: "Sam Rivera",
        model: "qwen3.5-4b",
        settings: s.settings.watch,
        always_skipped: [["com.1password.1password", "1Password"]],
        live: { state: "off", current: null, last_found: null, last_look: null, recent: [] },
      },
    email_tasks_status: () =>
      s.emailTasks ?? { schedule: s.settings.email, servers: [], claude_code_connected: false, running: false },
    calendar_status: () => s.calendar ?? { supported: true, access: "not_determined", enabled: false, hidden: [] },
    calendar_calendars: () => [
      { id: "c1", key: "Google / Work", title: "Work", source: "Google", color: "#3b82f6" },
      { id: "c2", key: "iCloud / Home", title: "Home", source: "iCloud", color: "#16a34a" },
      { id: "c3", key: "Other / Birthdays", title: "Birthdays", source: "Other", color: "#a855f7" },
      { id: "c4", key: "Other / US Holidays", title: "US Holidays", source: "Other", color: "#ef4444" },
    ],
    calendar_events: (a) =>
      (s.events ?? []).filter((e) => e.start.slice(0, 10) <= a.to && (e.end.slice(0, 10) > a.from || e.start.slice(0, 10) >= a.from)),
    autostart_enabled: () => true,
    panel_full: () => !!s.full,
    city_windows: () => s.cityWindows ?? [],
    list_floors: () => s.floors ?? [],
    create_project: (a) => a.name,
    project_tasks: (a) => [...s.tasks, ...(s.logbook ?? [])].filter((t) => t.project === a.project),
    delete_project: () => true,
    delete_floor: () => true,
    add_floor: (a) => a.name,
    save_city_image: () => "/Users/sam/Downloads/Lumen Bay.png",
    set_panel_full: (a) => {
      s.full = a.full;
      setTimeout(() => window.__emit("panel-full", a.full), 0);
      return null;
    },
    list_backups: () => s.backups,
    extract: () => (s.extract === "pending" ? new Promise(() => {}) : s.extract),
    update_task: (a) => ({ ...s.tasks.find((t) => t.id === a.id), ...a.patch }),
    logbook: () => s.logbook ?? [],
    list_projects: () => {
      const m = new Map();
      for (const t of [...s.tasks, ...(s.logbook ?? [])]) {
        if (!t.project) continue;
        const p = m.get(t.project) ?? { name: t.project, open: 0, done: 0 };
        if (t.done) p.done += 1;
        else p.open += 1;
        m.set(t.project, p);
      }
      return [...m.values()];
    },
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

// Software WebGL, so the 3D city renders too.
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });

const failed = [];
async function shot(name, size, s, steps = async () => {}, dark = false) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light", reducedMotion: "reduce" });
    await page.addInitScript(mockTauri, { ...s, shortcuts: SHORTCUTS });
    await page.goto(`${base}/?view=${s.label}`);
    await page.waitForTimeout(400);
    await steps(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/${name}.png` });
    console.log("saved", name);
  } catch (e) {
    const msg = `${name}: ${String(e).split("\n")[0]}${errors.length ? ` | page: ${errors[0]}` : ""}`;
    failed.push(msg);
    console.log(`::error::${msg.replace(/[\r\n]+/g, " ")}`);
    await page.screenshot({ path: `${out}/${name}-FAILED.png` }).catch(() => {});
  } finally {
    await page.close();
  }
}

const PANEL = { width: 360, height: 720 };
/** Settings live behind the gear; open it, then the tab. */
const tab = async (p, name) => {
  const t = p.getByRole("tab", { name: new RegExp(`^${name}`) });
  if (!(await t.count())) await p.getByRole("button", { name: "Settings", exact: true }).click();
  await t.click();
};
/** Open a task as a card. */
const openTask = async (p, n) => {
  await p.locator(".task .task-row").nth(n).click();
  await p.waitForTimeout(150);
};
const POP = { width: 340, height: 540 };
const QUICK = { width: 640, height: 300 };

await shot("panel-tasks", PANEL, scenario());
await shot("panel-tasks-dark", PANEL, scenario(), async () => {}, true);
await shot("panel-focus-keys", PANEL, scenario(), async (p) => {
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("ArrowDown");
});
const doneAt = (daysAgo, h) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, 15, 0, 0);
  return d.toISOString();
};
const RICH_TASKS = [
  ...TASKS,
  task("Pack for the offsite", {
    due_date: day(1),
    deadline: day(2),
    project: "Offsite 2026",
    heading: "Travel",
    checklist: [
      { text: "Charger and adapters", done: true },
      { text: "Passport", done: false },
      { text: "Printed agenda", done: false },
    ],
  }),
  task("Book flights", { due_date: day(4), deadline: day(0), project: "Offsite 2026", heading: "Travel" }),
  task("Draft the welcome talk", { project: "Offsite 2026", heading: "Program" }),
  task("Call mom", { due_date: day(0), evening: true }),
  task("Learn to make sourdough", { someday: true }),
  task("Plan a trip to Japan", { someday: true }),
];
const LOGBOOK = [
  task("Send the Q2 report", { done: true, completed_at: doneAt(0, 9), project: "Offsite 2026" }),
  task("Renew car registration", { done: true, completed_at: doneAt(1, 16) }),
  task("Order team t-shirts", { done: true, completed_at: doneAt(1, 11), project: "Offsite 2026" }),
  task("Fix the leaking tap", { done: true, completed_at: doneAt(3, 18) }),
];
const rich = (o = {}) => scenario({ tasks: RICH_TASKS, logbook: LOGBOOK, ...o });
const pickList = (name) => async (p) => {
  await p.locator(".list-title").click();
  await p.locator(".lp-menu").getByRole("menuitemradio", { name }).click();
  await p.waitForTimeout(200);
};
await shot("panel-rich", PANEL, rich());
await shot("panel-lists-menu", PANEL, rich(), async (p) => {
  await p.locator(".list-title").click();
});
await shot("panel-project", PANEL, rich(), pickList(/Offsite 2026/));
await shot("panel-project-dark", PANEL, rich(), pickList(/Offsite 2026/), true);
await shot("panel-someday", PANEL, rich(), pickList(/Someday/));
await shot("panel-logbook", PANEL, rich(), pickList(/Logbook/));
await shot("panel-steps-open", PANEL, rich(), async (p) => {
  await pickList(/Offsite 2026/)(p);
  await p.locator(".task .task-row", { hasText: "Pack for the offsite" }).click();
});
await shot("panel-project-picker", PANEL, rich(), async (p) => {
  await openTask(p, 1);
  await p.locator(".tc-pill", { hasText: "Project" }).click();
});
await shot("panel-when-editor", PANEL, rich(), async (p) => {
  await openTask(p, 1);
  await p.locator(".tc-pill").first().click();
});
await shot("popover-rich", POP, rich({ label: "popover" }));
await shot("panel-multi-select", PANEL, rich(), async (p) => {
  await p.locator(".task").nth(1).click({ modifiers: ["Meta"] });
  await p.locator(".task").nth(2).click({ modifiers: ["Meta"] });
  await p.locator(".task").nth(3).click({ modifiers: ["Meta"] });
});
await shot("panel-repeat-editor", PANEL, rich(), async (p) => {
  await p.locator(".task .task-row", { hasText: "Water the plants" }).first().click();
  await p.locator(".tc-pill").nth(3).click();
  await p.locator(".de-series").scrollIntoViewIfNeeded();
});

const PLAN_EVENTS = [
  { id: "e1", title: "Standup", start: `${day(0)}T09:30:00`, end: `${day(0)}T09:45:00`, all_day: false, calendar: "Work", color: "#3b82f6" },
  { id: "e2", title: "Design review", start: `${day(0)}T13:00:00`, end: `${day(0)}T14:00:00`, all_day: false, calendar: "Work", color: "#3b82f6" },
  { id: "e3", title: "Halloween", start: `${day(2)}T00:00:00`, end: `${day(3)}T00:00:00`, all_day: true, calendar: "US Holidays", color: "#ef4444" },
];
const PLAN_TASKS = [
  ...TASKS,
  task("Wrap up the launch notes #work", { due_date: day(0), due_time: "12:00" }),
  task("Gym", { due_date: day(0), due_time: "18:30" }),
  task("Draft the offsite agenda", { due_date: day(0), due_time: "10:00" }),
];
const planScenario = (o = {}) => scenario({ tasks: PLAN_TASKS, events: PLAN_EVENTS, ...o });
const week = async (p) => {
  await p.locator(".list-title").click();
  await p.locator(".lp-menu").getByRole("menuitemradio", { name: /Calendar/ }).click();
  await p.waitForTimeout(250);
};
await shot("panel-week", PANEL, planScenario(), week);
await shot("panel-week-dark", PANEL, planScenario(), week, true);
await shot("panel-week-add-at-hour", PANEL, planScenario(), async (p) => {
  await week(p);
  const slot = p.locator('.plan-slot[data-hour="11"]');
  await slot.scrollIntoViewIfNeeded();
  await slot.hover();
  await slot.locator(".plan-add").click();
  await p.keyboard.type("Prep questions for the 1:1");
});
const dragTo = (from, to) => async (p) => {
  const a = p.locator(from).first();
  const b = p.locator(to).first();
  await b.scrollIntoViewIfNeeded();
  const ra = await a.boundingBox();
  const rb = await b.boundingBox();
  await p.mouse.move(ra.x + 30, ra.y + ra.height / 2);
  await p.mouse.down();
  for (let i = 1; i <= 8; i++) {
    const tx = rb.width < 120 ? rb.x + rb.width / 2 : rb.x + 60;
    await p.mouse.move(ra.x + 30 + ((tx - ra.x - 30) * i) / 8, ra.y + ra.height / 2 + ((rb.y + rb.height / 2 - ra.y - ra.height / 2) * i) / 8);
  }
  await p.waitForTimeout(150);
};
await shot("panel-week-drag-hour", PANEL, planScenario(), async (p) => {
  await week(p);
  await dragTo(".plan-any .plan-task", '.plan-slot[data-hour="15"] .plan-cell')(p);
});
await shot("panel-week-drag-day", PANEL, planScenario(), async (p) => {
  await week(p);
  await dragTo(".plan-any .plan-task", ".wk-day:not(.on)")(p);
});
await shot("popover-hours", POP, planScenario({ label: "popover" }), async (p) => {
  await p.getByRole("radio", { name: "Day" }).click();
});
await shot("popover-hours-dark", POP, planScenario({ label: "popover" }), async (p) => {
  await p.getByRole("radio", { name: "Day" }).click();
}, true);
await shot("popover-hours-drag", POP, planScenario({ label: "popover" }), async (p) => {
  await p.getByRole("radio", { name: "Day" }).click();
  await p.waitForTimeout(200);
  await dragTo(".plan-any .plan-task", '.plan-slot[data-hour="16"] .plan-cell')(p);
});
await shot("panel-today-hours", PANEL, planScenario(), async (p) => {
  await p.getByRole("radio", { name: "Hours" }).click();
  await p.waitForTimeout(250);
});
await shot("panel-today-hours-dark", PANEL, planScenario(), async (p) => {
  await p.getByRole("radio", { name: "Hours" }).click();
  await p.waitForTimeout(250);
}, true);
await shot("panel-anytime", PANEL, rich(), pickList(/Anytime/));
await shot("panel-drag-to-day", PANEL, scenario(), async (p) => {
  await dragTo(".task .task-row", ".ws-day:nth-child(4)")(p);
});
await shot("panel-add-at-project", PANEL, rich(), async (p) => {
  await p.getByRole("button", { name: "Add a task", exact: true }).click();
  await p.keyboard.type("Book hotel @off fri");
});
await shot("panel-focus-today", PANEL, scenario(), async (p) => {
  await p.keyboard.press("f");
});
await shot("panel-snooze", PANEL, scenario(), async (p) => {
  await openTask(p, 2);
  await p.locator(".tc-link", { hasText: "Snooze" }).click();
});
await shot("panel-task-open", PANEL, scenario(), async (p) => {
  await openTask(p, 2);
});
await shot("panel-task-open-dark", PANEL, scenario(), async (p) => {
  await openTask(p, 2);
}, true);
await shot("panel-notes-edit", PANEL, scenario(), async (p) => {
  await openTask(p, 3);
  await p.locator(".tc-notes").click();
  await p.keyboard.type("Deck: https://slides.example.com/q3");
});
await shot("panel-keys-sheet", PANEL, scenario(), async (p) => {
  await p.keyboard.press("Shift+Slash");
});
await shot("panel-date-editor", PANEL, scenario(), async (p) => {
  await openTask(p, 0);
  await p.locator(".tc-pill").first().click();
  await p.keyboard.type("fri 3pm every week");
});
await shot("panel-search", PANEL, scenario(), async (p) => {
  await p.getByRole("button", { name: "Search", exact: true }).click();
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
await shot("panel-preferences", PANEL, scenario(), async (p) => {
  await tab(p, "Preferences");
});
// Dark chosen in Preferences while macOS is light.
await shot("panel-preferences-dark", PANEL, scenario({ settings: { ...SETTINGS, theme: "dark" } }), async (p) => {
  await tab(p, "Preferences");
});
await shot("panel-settings", PANEL, scenario({ update: { state: "ready", version: "0.2.1", notes: null } }), async (p) => {
  await tab(p, "Preferences");
  await p.locator(".settings-h", { hasText: "General" }).scrollIntoViewIfNeeded();
});
await shot("panel-settings-data", PANEL, scenario(), async (p) => {
  await tab(p, "Preferences");
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
for (let step = 1; step <= 3; step++) {
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
    await tab(p, "Models");
  },
);
await shot("panel-models-local-open", PANEL, scenario(), async (p) => {
  await tab(p, "Models");
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
    await tab(p, "Connectors");
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
const CAL_ON = { supported: true, access: "full", enabled: true, hidden: ["Other / Birthdays"] };
const EVENTS = [
  { id: "e0", title: "Office closed (half day)", start: `${EV_DAY}T00:00:00`, end: `${day(1)}T00:00:00`, all_day: true, calendar: "Work", color: "#3b82f6" },
  { id: "e1", title: "Standup", start: `${EV_DAY}T09:30:00`, end: `${EV_DAY}T09:45:00`, all_day: false, calendar: "Work", color: "#3b82f6" },
  { id: "e2", title: "Design review with Priya", start: `${EV_DAY}T13:00:00`, end: `${EV_DAY}T14:00:00`, all_day: false, calendar: "Work", color: "#3b82f6" },
  { id: "h1", title: "Veterans Day", start: `${day(2)}T00:00:00`, end: `${day(3)}T00:00:00`, all_day: true, calendar: "US Holidays", color: "#7c3aed" },
  { id: "e3", title: "Pick up groceries", start: `${EV_DAY}T18:00:00`, end: `${EV_DAY}T18:30:00`, all_day: false, calendar: "Home", color: "#16a34a" },
];
await shot("panel-connectors", PANEL, scenario(), async (p) => {
  await tab(p, "Connectors");
});
await shot("panel-connectors-calendar", PANEL, scenario({ calendar: CAL_ON }), async (p) => {
  await tab(p, "Connectors");
  await p.locator(".connector-action").first().click();
});
await shot("panel-connectors-reminders", PANEL, scenario(), async (p) => {
  await tab(p, "Connectors");
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
  await p.locator(".pop-quick input").click();
  await p.keyboard.type("dentist fri 3pm");
});
await shot("popover-add-description", POP, scenario({ label: "popover" }), async (p) => {
  await p.locator(".pop-quick input").click();
  await p.keyboard.type("Send the Q3 deck to Priya fri 3pm @Offsite");
});
await shot("panel-add-task", PANEL, scenario(), async (p) => {
  await p.getByRole("button", { name: "Add a task", exact: true }).click();
  await p.keyboard.type("Book flights for the offsite next tue");
  await p.getByRole("button", { name: "+ Description" }).click();
  await p.keyboard.type("Team of 6, window seats if possible");
});
const focus = (f) => async (p) => {
  await p.waitForTimeout(200);
  await p.evaluate((x) => window.__emit("popover-focus", x), f);
  await p.waitForTimeout(400);
};
await shot("popover-focus-due", POP, scenario({ label: "popover" }), focus({ kind: "due", ids: [TASKS[0].id] }));
await shot(
  "popover-focus-due-dark",
  POP,
  scenario({ label: "popover" }),
  focus({ kind: "due", ids: [TASKS[0].id, TASKS[2].id] }),
  true,
);
const UNDATED = [
  ...TASKS,
  task("Look into the flaky login test #work", { source_app: "Slack" }),
  task("Get a quote for the bike service"),
  task("Draft the offsite agenda #work"),
];
await shot("popover-focus-undated", POP, scenario({ label: "popover", tasks: UNDATED }), focus({ kind: "undated" }));
await shot(
  "popover-focus-undated-dark",
  POP,
  scenario({ label: "popover", tasks: UNDATED, settings: { ...SETTINGS, theme: "dark" } }),
  focus({ kind: "undated" }),
);
const INBOX = [
  { id: 1, title: "Send the Q3 deck to Priya", due_date: day(1), due_time: "15:00", notes: "She asked for the version with the regional breakdown.", agent: "Claude", received_at: localStamp(0), date_text: null, source: "agent" },
  { id: 2, title: "Book flights for the Austin offsite", due_date: day(4), due_time: null, notes: null, agent: "Claude", received_at: localStamp(0), date_text: null, source: "agent" },
];
const NOTICED = [
  { id: 7, title: "Send Dana the rollout checklist", due_date: null, due_time: null, notes: "Noticed in Slack · #launch", agent: "Slack", received_at: localStamp(0), date_text: "by Friday", source: "watch" },
  { id: 8, title: "Review the pricing doc", due_date: null, due_time: null, notes: "Noticed in Slack · Priya Shah", agent: "Slack", received_at: localStamp(0), date_text: "tomorrow 3pm", source: "watch" },
];
await shot("popover-focus-noticed", POP, scenario({ label: "popover", inbox: NOTICED }), focus({ kind: "inbox" }));
await shot("popover-noticed-banner", POP, scenario({ label: "popover", inbox: NOTICED }));
const WATCH_ON = {
  supported: true,
  default_name: "Sam Rivera",
  model: "qwen3.5-4b",
  settings: { ...SETTINGS.watch, enabled: true, excluded: ["com.spotify.client"], names: { "*": "Sam Rivera; Rivera, Sam" } },
  always_skipped: [["com.1password.1password", "1Password"]],
  live: {
    state: "watching",
    current: "Slack",
    last_found: null,
    last_look: { app: "Slack", at: "15:58:12", lines: 214, new: 3, asked: true, found: 1, step: "suggested" },
    recent: [
      { bundle: "com.tinyspeck.slackmacgap", name: "Slack", skipped: false },
      { bundle: "com.google.Chrome", name: "Google Chrome", skipped: false },
      { bundle: "com.microsoft.Outlook", name: "Microsoft Outlook", skipped: false },
      { bundle: "com.spotify.client", name: "Spotify", skipped: true },
    ],
  },
};
await shot("panel-connectors-watch", PANEL, scenario({ watch: WATCH_ON }), async (p) => {
  await tab(p, "Connectors");
  await p.locator(".connector-action").nth(2).click();
});
await shot("panel-connectors-watch-names", PANEL, scenario({ watch: WATCH_ON }), async (p) => {
  await tab(p, "Connectors");
  await p.locator(".connector-action").nth(2).click();
  await p.locator(".connector-subhead", { hasText: "Apps" }).scrollIntoViewIfNeeded();
});
await shot("popover-focus-inbox", POP, scenario({ label: "popover", inbox: INBOX }), focus({ kind: "inbox" }));
await shot("popover-focus-inbox-dark", POP, scenario({ label: "popover", inbox: INBOX }), focus({ kind: "inbox" }), true);
await shot("popover-inbox-banner", POP, scenario({ label: "popover", inbox: INBOX }));
const AGENTS_ON = {
  ...AGENT_STATUS,
  enabled: true,
  apps: AGENT_STATUS.apps.map((a) => (a.id === "claude_code" ? { ...a, connected: true } : a)),
};
await shot("panel-connectors-agents", PANEL, scenario({ agents: AGENTS_ON }), async (p) => {
  await tab(p, "Connectors");
  await p.locator(".connector-action").nth(3).click();
  await p.locator(".connector-subhead", { hasText: "Your AI apps" }).scrollIntoViewIfNeeded();
});
await shot(
  "panel-connectors-email",
  PANEL,
  scenario({
    agents: AGENTS_ON,
    emailTasks: {
      schedule: {
        ...SETTINGS.email,
        enabled: true,
        server: "outlook",
        last_ok: localStamp(-12),
        last: { at: localStamp(-12), ok: true, message: "Sent 2 tasks to Plucky." },
      },
      servers: ["outlook", "github"],
      claude_code_connected: true,
      running: false,
    },
  }),
  async (p) => {
    await tab(p, "Connectors");
    await p.locator(".connector-action").nth(3).click();
    await p.locator(".connector-subhead", { hasText: "Email to tasks" }).scrollIntoViewIfNeeded();
  },
);
await shot("panel-connectors-agents-tested", PANEL, scenario({ agents: AGENTS_ON }), async (p) => {
  await tab(p, "Connectors");
  await p.locator(".connector-action").nth(3).click();
  await p.getByRole("button", { name: "Send test task" }).click();
  await p.waitForTimeout(200);
  await p.locator(".agent-test").scrollIntoViewIfNeeded();
});
await shot("quick-empty", QUICK, scenario({ label: "quick" }));
await shot("quick-typed", QUICK, scenario({ label: "quick" }), async (p) => {
  await p.keyboard.type("pay rent friday 5pm every month #home");
});
await shot("quick-typed-dark", QUICK, scenario({ label: "quick" }), async (p) => {
  await p.keyboard.type("call mom tomorrow 6pm");
}, true);

// ── Full screen ─────────────────────────────────────────────────────────────
const FULL = { width: 1440, height: 900 };
const FULL_TASKS = [
  ...RICH_TASKS,
  task("Wrap up the launch notes #work", { due_date: day(0), due_time: "12:00", project: "Q4 launch" }),
  task("Draft the offsite agenda", { due_date: day(0), due_time: "10:00", project: "Offsite 2026", heading: "Program" }),
  task("Final pricing page copy", { due_date: day(2), due_time: "11:00", deadline: day(3), project: "Q4 launch" }),
  task("1:1 prep for Maya", { due_date: day(1), due_time: "15:00" }),
  task("Accessibility pass", { project: "Q4 launch" }),
  task("Order a new desk chair"),
];
const FULL_EVENTS = [
  ...PLAN_EVENTS,
  { id: "e4", title: "Lunch with Sam", start: `${day(1)}T12:00:00`, end: `${day(1)}T13:00:00`, all_day: false, calendar: "Home", color: "#16a34a" },
  { id: "e5", title: "Launch rehearsal", start: `${day(3)}T15:00:00`, end: `${day(3)}T16:30:00`, all_day: false, calendar: "Work", color: "#3b82f6" },
];
// The city: finished tasks over the last two months, more on some projects.
const CITY_WINDOWS = (() => {
  const out = [];
  const projects = [["Q4 launch", 58], ["Hiring", 40], ["Offsite 2026", 31], [null, 26], ["Taxes 2026", 22], ["Home", 14], ["Reading list", 6]];
  let n = 5000;
  for (const [project, count] of projects) {
    for (let i = 0; i < count; i++) {
      const daysAgo = Math.floor(((i * 7919) % 60) * (i < count * 0.2 ? 0.1 : 1));
      const d = new Date();
      d.setDate(d.getDate() - daysAgo);
      d.setHours(9 + (i % 9), (i * 13) % 60, 0, 0);
      const heading = project === "Offsite 2026" ? (i % 3 ? "Travel" : "Program") : project === "Q4 launch" ? ["Design", "Launch day", "Design", "Docs"][i % 4] : null;
      out.push({ id: n++, title: `${project ?? "Errand"} task ${i + 1}`, project, heading, completed_at: d.toISOString() });
    }
  }
  out.push({ id: n++, title: "Sent Q3 numbers to Priya", project: "Q4 launch", heading: "Docs", completed_at: new Date().toISOString() });
  return out.sort((a, b) => a.completed_at.localeCompare(b.completed_at));
})();
const FULL_FLOORS = [{ project: "Garden reno", name: "Beds", open: 0, done: 0 }];
const full = (o = {}) =>
  scenario({ tasks: FULL_TASKS, logbook: LOGBOOK, events: FULL_EVENTS, calendar: CAL_ON, full: true, cityWindows: CITY_WINDOWS, floors: FULL_FLOORS, ...o });
const DARK = { ...SETTINGS, theme: "dark" };
const LIGHT = { ...SETTINGS, theme: "light" };
const side = (name) => async (p) => {
  await p.locator(".sidebar button:not(.sb-chev)").filter({ hasText: name }).first().click();
  await p.waitForTimeout(250);
};
await shot("full-today", FULL, full({ settings: DARK }));
await shot("full-today-light", FULL, full({ settings: LIGHT }));
await shot("full-today-hours", FULL, full({ settings: DARK }), async (p) => {
  // Today always shows its hours beside the list; there's no switch any more.
  if (await p.getByRole("radio", { name: "List + Hours" }).count()) throw new Error("the List / List + Hours switch is still there");
  if (!(await p.locator(".mcal").count())) throw new Error("no month calendar on the right");
});
await shot("full-overdue", FULL, full({ settings: DARK }), async (p) => {
  await side(/Overdue/)(p);
  if (await p.locator(".due-strip, .full-due").count()) throw new Error("the due bar is still showing in full screen");
});
await shot("full-task-open", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".task .task-row").nth(1).click();
});
await shot("full-task-open-light", FULL, full({ settings: LIGHT }), async (p) => {
  await p.locator(".task .task-row").nth(1).click();
});
await shot("full-project", FULL, full({ settings: DARK }), async (p) => {
  await side(/Offsite 2026/)(p);
  await p.locator(".task .task-row", { hasText: "Pack for the offsite" }).click();
});
await shot("full-when-editor", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".task .task-row").nth(1).click();
  await p.locator(".tc-props .tc-pill").first().click();
});
await shot("full-upcoming", FULL, full({ settings: DARK }), side(/Calendar/));
await shot("full-upcoming-light", FULL, full({ settings: LIGHT }), side(/Calendar/));
await shot("full-upcoming-drag", FULL, full({ settings: DARK }), async (p) => {
  await side(/Calendar/)(p);
  const from = await p.locator(".wg-task").first().boundingBox();
  const to = await p.locator(`.wg-cell[data-iso="${day(2)}"][data-hour="16"]`).boundingBox();
  await p.mouse.move(from.x + 30, from.y + 8);
  await p.mouse.down();
  await p.mouse.move(from.x + 60, from.y + 30, { steps: 4 });
  await p.mouse.move(to.x + 30, to.y + 20, { steps: 8 });
  await p.waitForTimeout(150);
});
await shot("full-settings", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".sidebar").getByRole("button", { name: /^Settings/ }).click();
  await p.waitForTimeout(200);
});
await shot("full-search", FULL, full({ settings: DARK }), async (p) => {
  await p.keyboard.press("Meta+k");
  await p.keyboard.type("offsite");
});
await shot("full-no-sidebar", FULL, full({ settings: DARK }), async (p) => {
  await p.getByRole("button", { name: "Hide sidebar" }).click();
});
await shot("full-tour", FULL, full({ settings: { ...DARK, onboarding_done: false }, status: { accessibility: true, engine: "bundled", active_model: null, version: "0.4.28", platform: "macos" } }));
await shot("full-city-corner-hover", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".city-card").hover();
});
await shot("full-city", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".city-card-art").click();
  await p.waitForTimeout(300);
});
await shot("full-city-light", FULL, full({ settings: LIGHT }), async (p) => {
  await p.locator(".city-card-art").click();
  await p.waitForTimeout(300);
});
await shot("full-city-turned", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".city-card-art").click();
  const c = await p.locator(".city-view canvas").first().boundingBox();
  await p.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await p.mouse.down();
  await p.mouse.move(c.x + c.width / 2 - 260, c.y + c.height / 2 + 90, { steps: 10 });
  await p.mouse.up();
  await p.mouse.move(c.x + c.width / 2, c.y + c.height / 2 + 40);
  await p.waitForTimeout(200);
});
await shot("full-city-hover", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".city-card-art").click();
  const c = await p.locator(".city-view canvas").first().boundingBox();
  await p.mouse.move(c.x + c.width / 2 + 5, c.y + c.height / 2 + 10, { steps: 3 });
});
await shot("full-city-clicked-building", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".city-card-art").click();
  const c = await p.locator(".city-view canvas").first().boundingBox();
  await p.mouse.move(c.x + c.width / 2 + 5, c.y + c.height / 2 + 10, { steps: 3 });
  await p.mouse.down();
  await p.mouse.up();
  await p.waitForTimeout(250);
});
await shot("full-city-share", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".city-card").hover();
  await p.getByRole("button", { name: "Share a picture of your city" }).click();
  await p.waitForTimeout(300);
});
await shot("full-city-name", FULL, full({ settings: { ...DARK, city_name: null } }), async (p) => {
  await p.locator(".city-card-art").click();
  await p.waitForTimeout(300);
});
await shot("full-city-named", FULL, full({ settings: { ...DARK, city_name: null } }), async (p) => {
  await p.locator(".city-card-art").click();
  await p.getByRole("button", { name: "Harbor Lights" }).click();
  await p.getByRole("button", { name: "Found the city" }).click();
  await p.waitForTimeout(1200);
  if (!(await p.locator(".cv-name", { hasText: "Harbor Lights" }).count())) throw new Error("the city didn't open after naming it");
});
await shot("full-city-empty", FULL, full({ settings: DARK, cityWindows: [] }));
await shot("full-project-building", FULL, full({ settings: DARK }), async (p) => {
  await side(/Offsite 2026/)(p);
});
await shot("full-building-floors", FULL, full({ settings: DARK }), async (p) => {
  await side(/Offsite 2026/)(p);
  await p.getByRole("button", { name: "Show Q4 launch's floors" }).click();
});
await shot("full-add-room", FULL, full({ settings: DARK }), async (p) => {
  await side(/Offsite 2026/)(p);
  await p.getByRole("button", { name: /^Add Task$/ }).click();
  await p.keyboard.type("Book the venue fri 2pm");
});
const openFloor = async (p) => {
  await side(/Offsite 2026/)(p);
  await p.locator(".sb-floor", { hasText: "Floor: Travel" }).click();
  await p.waitForTimeout(250);
  if (!(await p.locator(".fh-title", { hasText: "Floor: Travel" }).count())) throw new Error("the floor's page didn't open");
};
await shot("full-floor-page", FULL, full({ settings: DARK }), openFloor);
await shot("full-floor-add", FULL, full({ settings: DARK }), async (p) => {
  await openFloor(p);
  await p.getByRole("button", { name: /^Add Task$/ }).first().click();
  await p.keyboard.type("Book the airport taxi");
});
await shot("full-floor-added", FULL, full({ settings: DARK }), async (p) => {
  await openFloor(p);
  await p.getByRole("button", { name: /^Add Task$/ }).first().click();
  await p.keyboard.type("Book the airport taxi");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(300);
  if (await p.locator(".add-task").count()) throw new Error("the add form stayed open after adding");
});
await shot("full-room-drawers", FULL, full({ settings: DARK }), async (p) => {
  await openFloor(p);
  await p.locator(".task .task-row", { hasText: "Pack for the offsite" }).click();
  await p.waitForTimeout(200);
  if (!(await p.locator(".task.open .sp-done").count())) throw new Error("the task didn't open in place with a Done button");
});
await shot("full-floor-menu", FULL, full({ settings: DARK }), async (p) => {
  await side(/Offsite 2026/)(p);
  await p.locator(".sb-b", { hasText: "Offsite 2026" }).hover();
  await p.getByRole("button", { name: "More for Offsite 2026" }).click();
});
await shot("full-city-story", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".city-card-art").click();
  await p.waitForTimeout(600);
  await p.getByRole("button", { name: /Story/ }).click();
  await p.locator(".story-card").getByRole("button", { name: "Next", exact: true }).click();
  await p.locator(".story-card").getByRole("button", { name: "Next", exact: true }).click();
  await p.waitForTimeout(350);
});
await shot("full-new-building", FULL, full({ settings: DARK }), async (p) => {
  await p.getByRole("button", { name: "New project" }).click();
  await p.keyboard.type("Garden reno");
});
await shot("full-city-dark-room", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".city-card-art").click();
  await p.waitForTimeout(800);
  const c = await p.locator(".city-view canvas").first().boundingBox();
  for (const [dx, dy] of [[0, 40], [60, 20], [-80, 30], [120, -40], [-140, 60]]) {
    await p.mouse.move(c.x + c.width / 2 + dx, c.y + c.height / 2 + dy, { steps: 2 });
    await p.waitForTimeout(80);
    if (await p.locator(".cv-tip", { hasText: /still to do|Overdue|readied/ }).count()) break;
  }
});
await shot("panel-full-button", PANEL, scenario({ settings: DARK }), async (p) => {
  await p.getByRole("button", { name: "Open full screen" }).hover();
});

await browser.close();

if (failed.length) {
  console.log(`::error::${failed.length} preview(s) failed`);
  process.exitCode = 1;
}
