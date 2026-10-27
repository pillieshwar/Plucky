// Renders TodoCity's UI in Chromium with a fake Tauri backend and saves
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

const MODE = (id, name, icon, extra = {}) => ({
  id, name, icon, projects: [], new_projects: false, no_project: true, hidden_calendars: [], notify: true, new_task_project: null, ...extra,
});
const MODES = [MODE("work", "Work", "💼"), MODE("personal", "Personal", "🏠", { new_projects: true })];
const SETTINGS = {
  modes: MODES,
  mode: null,
  open_full: true,
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
  city_seen: 99999,
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
  command: "/Applications/TodoCity.app/Contents/MacOS/TodoCity",
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
    // Fresh objects each time, as the real backend returns.
    list_tasks: () => s.tasks.map((t) => ({ ...t })),
    status: () => s.status,
    get_settings: () => s.settings,
    set_settings: (a) => (s.settings = a.value),
    set_view_mode: (a) => {
      s.settings = { ...s.settings, mode: a.id };
      setTimeout(() => window.__emit?.("settings-changed", s.settings), 0);
      return s.settings;
    },
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
    agents_test: () => "Working — AI apps can send tasks to TodoCity.",
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
    sync_status: () =>
      s.sync ?? {
        on: false,
        name: "Sam's MacBook Air",
        devices: [],
        local_only: [],
        last_ok: null,
        error: null,
        busy: false,
        pending: 0,
        removed_notice: false,
        pairing: null,
      },
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
    set_project_color: (a) => {
      s.colors = { ...(s.colors ?? { "Offsite 2026": "#f08a3c", "Q4 launch": "#3fbf7f" }), [a.name]: a.color };
      return null;
    },
    delete_floor: () => true,
    add_floor: (a) => a.name,
    things_find: () => [{ path: "/Users/sam/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-1A2B3/Things Database.thingsdatabase/main.sqlite", modified: "2026-10-25T18:40:00Z" }],
    things_pick: () => null,
    things_preview: (a) => {
      const done = a.options?.include_done ?? true;
      const b = (key, name, kind, area, open, d, floors) => ({ key, name, kind, area, open, done: done ? d : 0, floors });
      const buildings = [
        b("P1", "Kitchen remodel", "project", "Home", 14, 22, 3),
        b("P2", "Q1 planning", "project", "Work", 9, 41, 2),
        b("P3", "Trip to Lisbon", "project", null, 6, 3, 0),
        b("area:A1", "Home", "area", null, 7, 120, 0),
        b("", "", "loose", null, 11, 310, 0),
      ];
      return {
        source: { path: "/Users/sam/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-1A2B3/Things Database.thingsdatabase/main.sqlite", modified: "2026-10-25T18:40:00Z" },
        preview: { buildings, open: 47, done: done ? 496 : 0, someday: 8, repeating: 4, subtasks: 63, canceled: 5, unmapped_repeats: 1, already: 0 },
      };
    },
    things_import: () => ({ added: 543, done: 496, skipped: 0, failed: 0 }),
    todoist_pick_files: () => ["/Users/sam/Downloads/Lisbon [2203306141].csv"],
    todoist_preview: (a) => {
      if (a.token && a.token !== "good-token") throw "Todoist didn't accept that token. Copy it again from Todoist → Settings → Integrations → Developer.";
      if (a.token || a.files) s.todoistKind = a.token ? "api" : "csv";
      const api = (s.todoistKind ?? "api") === "api";
      const done = api && (a.options?.include_done ?? true);
      const b = (key, name, kind, area, open, d, floors) => ({ key, name, kind, area, open, done: done ? d : 0, floors });
      const buildings = [
        b("200", "Kitchen", "project", null, 12, 30, 2),
        b("201", "Tiles", "project", "Kitchen", 4, 6, 0),
        b("300", "Work", "project", null, 21, 180, 3),
        b("9", "Old launch", "project", "archived", 0, 44, 0),
        b("", "", "loose", null, 9, 75, 0),
      ].filter((x) => x.open + x.done > 0);
      return {
        source: api ? { kind: "api", label: "your Todoist account" } : { kind: "csv", label: "1 CSV file" },
        preview: { buildings, open: 46, done: done ? 335 : 0, someday: 0, repeating: 6, subtasks: 38, canceled: 0, unmapped_repeats: 2, already: 0 },
      };
    },
    todoist_import: () => ({ added: 381, done: 335, skipped: 0, failed: 0 }),
    save_city_image: () => "/Users/sam/Downloads/Lumen Bay.png",
    set_panel_full: (a) => {
      s.full = a.full;
      setTimeout(() => window.__emit("panel-full", a.full), 0);
      return null;
    },
    list_backups: () => s.backups,
    extract: () => (s.extract === "pending" ? new Promise(() => {}) : s.extract),
    update_task: (a) => {
      const t = s.tasks.find((x) => x.id === a.id);
      if (!t) return null;
      const { only_this, ...patch } = a.patch ?? {};
      Object.assign(t, patch);
      // The app refreshes when the backend says tasks changed.
      setTimeout(() => window.__emit?.("tasks-changed", null), 0);
      return { ...t };
    },
    logbook: () => s.logbook ?? [],
    list_projects: () => {
      const m = new Map();
      for (const t of [...s.tasks, ...(s.logbook ?? [])]) {
        if (!t.project) continue;
        const p = m.get(t.project) ?? { name: t.project, open: 0, done: 0, color: (s.colors ?? { "Offsite 2026": "#f08a3c", "Q4 launch": "#3fbf7f" })[t.project] ?? null };
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
/** Settings pages by their old tab names too. */
const PAGE_NAMES = { Preferences: "General", Models: "AI model", "Data transfer": "Move in" };
const tab = async (p, name) => {
  const label = PAGE_NAMES[name] ?? name;
  const item = () => p.locator(".set-item", { hasText: new RegExp(`^.?${label}`) }).first();
  if (!(await item().count())) await p.getByRole("button", { name: "Settings", exact: true }).first().click();
  await p.waitForTimeout(100);
  await item().click();
  await p.waitForTimeout(150);
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
await shot("panel-inbox", PANEL, rich(), pickList(/Inbox/));
await shot("panel-completed", PANEL, rich(), pickList(/Completed/));
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
  await p.locator(".de-series-actions").scrollIntoViewIfNeeded();
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
await shot("panel-settings-home", PANEL, scenario({ update: { state: "ready", version: "0.2.1", notes: null } }), async (p) => {
  await p.getByRole("button", { name: "Settings", exact: true }).first().click();
});
await shot("panel-settings-appearance", PANEL, scenario(), async (p) => {
  await tab(p, "Appearance");
});
await shot("panel-settings-notifications", PANEL, scenario(), async (p) => {
  await tab(p, "Notifications");
});
await shot("panel-preferences", PANEL, scenario(), async (p) => {
  await tab(p, "Preferences");
});
// Dark chosen in Preferences while macOS is light.
await shot("panel-preferences-dark", PANEL, scenario({ settings: { ...SETTINGS, theme: "dark" } }), async (p) => {
  await tab(p, "Preferences");
});
await shot("panel-settings", PANEL, scenario({ update: { state: "ready", version: "0.2.1", notes: null } }), async (p) => {
  await tab(p, "General");
});
await shot("panel-settings-data", PANEL, scenario(), async (p) => {
  await tab(p, "Backups & export");
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
      list: { id: "l1", title: "TodoCity", source: "iCloud", icloud: true, leaves_mac: true, writable: true },
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
await shot(
  "popover-capture-place",
  POP,
  scenario({
    label: "popover",
    extract: { task: "Send Q3 numbers to Priya", date_text: "by Friday 3pm", date_confidence: "high" },
    tasks: RICH_TASKS,
    floors: [
      { project: "Offsite 2026", name: "Travel", open: 1, done: 0 },
      { project: "Offsite 2026", name: "Program", open: 1, done: 0 },
    ],
  }),
  async (p) => {
    await p.evaluate((c) => window.__emit("capture", c), CAPTURED);
    await p.waitForTimeout(300);
    await p.locator(".capture .add-place select").first().selectOption("Offsite 2026");
    const floors = await p.locator(".capture .add-place select").nth(1).locator("option").allTextContents();
    if (!floors.includes("Travel")) throw new Error(`the floor list doesn't follow the project: ${floors.join(", ")}`);
    await p.locator(".capture .add-place select").nth(1).selectOption("Travel");
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
const SYNC_BASE = {
  on: false,
  name: "Sam's MacBook Air",
  devices: [],
  local_only: [],
  last_ok: null,
  error: null,
  busy: false,
  pending: 0,
  removed_notice: false,
  pairing: null,
};
const SYNC_ON = {
  ...SYNC_BASE,
  on: true,
  devices: [
    { id: "me", name: "Sam's MacBook Air", me: true, last_seen: null },
    { id: "work", name: "Work MacBook Pro", me: false, last_seen: new Date(Date.now() - 4 * 60_000).toISOString() },
  ],
  local_only: ["Offsite 2026"],
  last_ok: new Date(Date.now() - 30_000).toISOString(),
};
const syncOpen = async (p) => {
  await tab(p, "Your other Macs");
};
await shot("panel-connectors-sync", PANEL, scenario({ sync: SYNC_BASE }), syncOpen);
await shot(
  "panel-connectors-sync-code",
  PANEL,
  scenario({ sync: { ...SYNC_BASE, on: true, pairing: { role: "host", code: "K7MX-4QRB", stage: "waiting", sas: null, confirmed: false, error: null } } }),
  async (p) => await tab(p, "Your other Macs"),
);
const SYNC_COMPARE = { ...SYNC_BASE, pairing: { role: "join", code: "K7MX-4QRB", stage: "compare", sas: "482 913", confirmed: false, error: null } };
await shot("panel-connectors-sync-compare", PANEL, scenario({ sync: SYNC_COMPARE }), async (p) => await tab(p, "Your other Macs"));
await shot("panel-connectors-sync-compare-dark", PANEL, scenario({ sync: SYNC_COMPARE }), async (p) => await tab(p, "Your other Macs"), true);
await shot("panel-connectors-sync-on", PANEL, scenario({ sync: SYNC_ON }), async (p) => {
  await syncOpen(p);
  await p.locator(".connector-subhead", { hasText: "Your Macs" }).scrollIntoViewIfNeeded();
});
await shot("panel-connectors-sync-local", PANEL, scenario({ sync: SYNC_ON, tasks: RICH_TASKS }), async (p) => {
  await syncOpen(p);
  await p.locator(".sync-leave").scrollIntoViewIfNeeded();
});
await shot("panel-connectors-sync-join", PANEL, scenario({ sync: SYNC_BASE }), async (p) => {
  await syncOpen(p);
  await p.getByRole("button", { name: "I have a code" }).click();
  await p.locator("#sync-code").fill("k7mx-4qrb");
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
  await p.getByRole("button", { name: "+ Notes" }).click();
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
        last: { at: localStamp(-12), ok: true, message: "Sent 2 tasks to TodoCity." },
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
// Modes: the work laptop in Work mode shows only work projects.
const WORK_MODES = [
  MODE("work", "Work", "💼", { projects: ["Hiring", "Q4 launch"] }),
  MODE("personal", "Personal", "🏠", { new_projects: true, projects: ["Hiring", "Q4 launch"] }),
  MODE("study", "Study", "📚", { projects: ["Reading list"], no_project: false }),
];
const IN_WORK = { ...LIGHT, modes: WORK_MODES, mode: "work" };
await shot("full-mode-work", FULL, full({ settings: IN_WORK }));
await shot("full-mode-work-dark", FULL, full({ settings: { ...IN_WORK, theme: "dark" } }), async () => {}, true);
await shot("full-mode-menu", FULL, full({ settings: IN_WORK }), async (p) => {
  await p.locator(".mode-switch.mode-side .mode-btn").click();
});
await shot("full-mode-others", FULL, full({ settings: IN_WORK }), async (p) => {
  await p.locator(".sb-others").click();
});
await shot("full-mode-peek", FULL, full({ settings: IN_WORK }), async (p) => {
  await p.locator(".mode-hidden .link").click();
});
await shot("full-mode-switch", FULL, full({ settings: { ...LIGHT, modes: WORK_MODES } }), async (p) => {
  await p.locator(".mode-switch.mode-side .mode-btn").click();
  await p.getByRole("menuitemradio", { name: /Personal/ }).click();
  await p.waitForTimeout(300);
  if (!(await p.locator(".mode-switch.mode-side.on").count())) throw new Error("the mode didn't switch");
});
await shot("full-settings-modes", FULL, full({ settings: IN_WORK }), async (p) => {
  await tab(p, "Modes");
});
await shot("popover-mode", POP, scenario({ label: "popover", settings: IN_WORK, tasks: FULL_TASKS }));
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
  // A project opens as a board: its floors as columns.
  if ((await p.locator(".bcol").count()) < 2) throw new Error("the project didn't open as a board of floors");
  await p.locator(".bcard", { hasText: "Pack for the offsite" }).click();
  await p.locator(".detail-pane").waitFor();
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
for (const [name, page] of [["notifications", "Notifications"], ["capture", "Capture & shortcuts"], ["city", "Your city"], ["sync", "Your other Macs"], ["connectors", "Connectors"], ["help", "Help"], ["backups", "Backups & export"]]) {
  await shot(`full-settings-${name}`, FULL, full({ settings: DARK }), async (p) => await tab(p, page));
}
await shot("full-customize", FULL, full({ settings: DARK }), async (p) => {
  await tab(p, "Appearance");
  await p.getByRole("radio", { name: "Green" }).click();
  await p.waitForTimeout(150);
  if ((await p.evaluate(() => document.documentElement.dataset.accent)) !== "green") throw new Error("the accent color didn't change");
});
await shot("full-transfer", FULL, full({ settings: DARK }), async (p) => {
  await tab(p, "Move in");
  await p.getByRole("button", { name: "Find my Things library" }).click();
  await p.waitForTimeout(200);
  await p.locator(".tr-list li", { hasText: "Trip to Lisbon" }).locator("input").click();
  const label = await p.locator(".tr-preview .primary").textContent();
  if (label !== "Move in 534 to-dos") throw new Error(`move-in count wrong: ${label}`);
});
await shot("full-transfer-todoist", FULL, full({ settings: DARK }), async (p) => {
  await tab(p, "Move in");
  await p.getByRole("tab", { name: /Todoist/ }).click();
  await p.getByLabel("Todoist API token").fill("bad-token");
  await p.getByRole("button", { name: "Connect", exact: true }).click();
  await p.locator(".tr-error").waitFor();
  await p.getByLabel("Todoist API token").fill("good-token");
  await p.getByRole("button", { name: "Connect", exact: true }).click();
  await p.locator(".tr-preview").waitFor();
  const label = await p.locator(".tr-preview .primary").textContent();
  if (label !== "Move in 381 tasks") throw new Error(`move-in count wrong: ${label}`);
  if ((await p.getByLabel("Todoist API token").count()) !== 0) throw new Error("the token field should be gone after connecting");
});
await shot("full-transfer-todoist-csv", FULL, full({ settings: DARK }), async (p) => {
  await tab(p, "Move in");
  await p.getByRole("tab", { name: /Todoist/ }).click();
  await p.getByText("No token? Use CSV files instead").click();
  await p.getByRole("button", { name: "Choose CSV files…" }).click();
  await p.locator(".tr-preview").waitFor();
  if (!(await p.getByRole("switch", { name: /Bring completed tasks/ }).isDisabled())) throw new Error("completed tasks should be off for CSV");
});
await shot("panel-transfer-done", PANEL, scenario(), async (p) => {
  await tab(p, "Data transfer");
  await p.getByRole("button", { name: "Find my Things library" }).click();
  await p.getByRole("button", { name: /^Move in \d/ }).click();
  await p.locator(".tr-done").waitFor();
  if (!(await p.locator(".tr-done").textContent()).includes("543 tasks moved in")) throw new Error("done message missing");
});
await shot("full-compact-blue", FULL, full({ settings: { ...DARK, look: { week_start: "mon", clock: "24", start_list: "last", details: false, accent: "blue", city_sky: "auto", city_motion: true, compact: true } } }), async (p) => {
  if (!(await p.locator(".app-full.compact").count())) throw new Error("compact rows didn't apply");
  if (await p.locator(".task-extra").count()) throw new Error("notes still show under tasks with details off");
  const dow = await p.locator(".mcal-dow").first().textContent();
  if (dow !== "M") throw new Error(`week doesn't start on Monday (${dow})`);
});
await shot("full-search", FULL, full({ settings: DARK }), async (p) => {
  await p.keyboard.press("Meta+k");
  await p.keyboard.type("offsite");
});
await shot("full-no-sidebar", FULL, full({ settings: DARK }), async (p) => {
  await p.getByRole("button", { name: "Hide sidebar" }).click();
});
await shot("full-tour", FULL, full({ settings: { ...DARK, onboarding_done: false }, status: { accessibility: true, engine: "bundled", active_model: null, version: "0.4.28", platform: "macos" } }));
await shot("full-footer-city-hover", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".ff-city").hover();
});
await shot("full-city", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".ff-city").click();
  await p.waitForTimeout(300);
});
await shot("full-city-light", FULL, full({ settings: LIGHT }), async (p) => {
  await p.locator(".ff-city").click();
  await p.waitForTimeout(300);
});
await shot("full-city-turned", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".ff-city").click();
  const c = await p.locator(".city-view canvas").first().boundingBox();
  await p.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await p.mouse.down();
  await p.mouse.move(c.x + c.width / 2 - 260, c.y + c.height / 2 + 90, { steps: 10 });
  await p.mouse.up();
  await p.mouse.move(c.x + c.width / 2, c.y + c.height / 2 + 40);
  await p.waitForTimeout(200);
});
await shot("full-city-hover", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".ff-city").click();
  const c = await p.locator(".city-view canvas").first().boundingBox();
  await p.mouse.move(c.x + c.width / 2 + 5, c.y + c.height / 2 + 10, { steps: 3 });
});
await shot("full-city-clicked-building", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".ff-city").click();
  const c = await p.locator(".city-view canvas").first().boundingBox();
  await p.mouse.move(c.x + c.width / 2 + 5, c.y + c.height / 2 + 10, { steps: 3 });
  await p.mouse.down();
  await p.mouse.up();
  await p.waitForTimeout(250);
});
await shot("full-city-share", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".ff-city").click();
  await p.locator(".cv-share").click();
  await p.waitForTimeout(300);
});
await shot("full-city-name", FULL, full({ settings: { ...DARK, city_name: null } }), async (p) => {
  await p.locator(".ff-city").click();
  await p.waitForTimeout(300);
});
await shot("full-city-named", FULL, full({ settings: { ...DARK, city_name: null } }), async (p) => {
  await p.locator(".ff-city").click();
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
  await p.getByRole("button", { name: "1st Floor: Travel", exact: true }).click();
  await p.waitForTimeout(250);
  if (!(await p.locator(".fh-title", { hasText: "Floor: Travel" }).count())) throw new Error("the floor's page didn't open");
  if (!(await p.locator(".fh-crumb", { hasText: "Offsite 2026" }).count())) throw new Error("no breadcrumb back to the project");
  if (!(await p.locator(".mcal-scope", { hasText: "Offsite 2026" }).count())) throw new Error("the month isn't narrowed to the floor");
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
// Inbox: tasks in no project, as a board by default.
await shot("full-inbox-board", FULL, full({ settings: DARK }), async (p) => {
  await side(/Inbox/)(p);
  const cols = await p.locator(".bcol-title").allTextContents();
  if (cols.join(",") !== "Today,Tomorrow,Next 7 days,Later,Someday") throw new Error(`Inbox columns: ${cols.join(",")}`);
  if (await p.locator(".bcard", { hasText: "Book flights" }).count()) throw new Error("a project's task is in Inbox");
});
await shot("full-inbox-list", FULL, full({ settings: DARK }), async (p) => {
  await side(/Inbox/)(p);
  await p.getByRole("button", { name: "List view" }).click();
  await p.waitForTimeout(300);
  if (await p.locator(".bcol").count()) throw new Error("still a board after choosing List");
  if (!(await p.locator(".task").count())) throw new Error("no tasks in Inbox's list");
});
await shot("full-inbox-drag", FULL, full({ settings: DARK }), async (p) => {
  await side(/Inbox/)(p);
  const card = p.locator(".bcard").first();
  const title = (await card.locator(".bcard-title").textContent())?.trim();
  const from = await card.boundingBox();
  const to = await p.locator(".bcol", { has: p.locator(".bcol-title", { hasText: "Someday" }) }).boundingBox();
  await p.mouse.move(from.x + 40, from.y + 14);
  await p.mouse.down();
  await p.mouse.move(from.x + 60, from.y + 40, { steps: 4 });
  await p.mouse.move(to.x + 60, to.y + 60, { steps: 10 });
  await p.waitForTimeout(150);
  if (!(await p.locator(".bcol.drop").count())) throw new Error("the column doesn't light up under a dragged card");
  await p.mouse.up();
  await p.waitForTimeout(400);
  const some = await p.locator(".bcol", { has: p.locator(".bcol-title", { hasText: "Someday" }) }).locator(".bcard-title").allTextContents();
  if (!some.map((x) => x.trim()).includes(title)) throw new Error(`"${title}" didn't move to Someday`);
});
await shot("full-board-floor-drag", FULL, full({ settings: DARK }), async (p) => {
  await side(/Offsite 2026/)(p);
  const card = p.locator(".bcard", { hasText: "Book flights" });
  const from = await card.boundingBox();
  const to = await p.locator(".bcol", { has: p.locator(".bcol-title", { hasText: "Program" }) }).boundingBox();
  await p.mouse.move(from.x + 40, from.y + 14);
  await p.mouse.down();
  await p.mouse.move(from.x + 60, from.y + 40, { steps: 4 });
  await p.mouse.move(to.x + 60, to.y + 60, { steps: 10 });
  await p.mouse.up();
  await p.waitForTimeout(400);
  if (!(await p.locator(".toast", { hasText: "Moved to Offsite 2026 › Program" }).count())) throw new Error("the card didn't move to the Program floor");
});
// The calendar pane closes from the header, and stays closed.
await shot("full-pane-closed", FULL, full({ settings: DARK }), async (p) => {
  await p.getByRole("button", { name: "Hide calendar pane" }).click();
  await p.waitForTimeout(300);
  if (await p.locator(".side-pane").count()) throw new Error("the pane didn't close");
  await p.getByRole("button", { name: "Show calendar pane" }).waitFor();
});
// Finished tasks wait behind "N completed · Show".
await shot("full-today-completed", FULL, full({ settings: DARK }), async (p) => {
  if (await p.locator(".task.done").count()) throw new Error("finished tasks show by default");
  await p.locator(".done-toggle").click();
  await p.waitForTimeout(200);
  if (!(await p.locator(".task.done").count())) throw new Error("Show didn't bring the finished tasks back");
});
// Floors in the sidebar: a small number, then the name.
await shot("full-sidebar-floors", FULL, full({ settings: DARK }), async (p) => {
  await side(/Offsite 2026/)(p);
  const lvl = await p.locator(".sb-floor-row .sb-lvl").allTextContents();
  if (!lvl.includes("G") || !lvl.includes("1")) throw new Error(`floor numbers missing: ${lvl.join(",")}`);
  if (await p.locator(".sb-floor-name", { hasText: "Floor:" }).count()) throw new Error("floor names still carry the 'Nth Floor:' prefix");
});
// Drag a task from Today onto a floor of another building.
await shot("full-drag-to-floor", FULL, full({ settings: DARK }), async (p) => {
  await p.getByRole("button", { name: "Show Offsite 2026's floors" }).click();
  const task = p.locator(".task .task-row").first();
  const name = (await task.locator(".task-title").first().textContent())?.trim();
  const from = await task.boundingBox();
  const to = await p.getByRole("button", { name: "1st Floor: Travel", exact: true }).boundingBox();
  await p.mouse.move(from.x + 40, from.y + from.height / 2);
  await p.mouse.down();
  await p.mouse.move(from.x + 60, from.y + 30, { steps: 4 });
  await p.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 10 });
  await p.waitForTimeout(150);
  if (!(await p.locator(".sb-floor-row.drop").count())) throw new Error("the floor doesn't light up under a dragged task");
  if (!(await p.locator(".pop-ghost", { hasText: "Offsite 2026 › Travel" }).count())) throw new Error("the drag label doesn't say where it goes");
  await p.mouse.up();
  await p.waitForTimeout(300);
  if (!(await p.locator(".toast", { hasText: "Moved to Offsite 2026 › Travel" }).count())) throw new Error(`no 'moved' note after dropping ${name}`);
});
// The right-hand pane: narrower, and its edge can be dragged (and the width is kept).
await shot("full-side-resized", FULL, full({ settings: DARK }), async (p) => {
  const pane = p.locator(".side-pane").first();
  const before = (await pane.boundingBox()).width;
  if (Math.abs(before - 300) > 2) throw new Error(`the pane should start at 300px, not ${before}`);
  const edge = await p.locator(".side-resize").boundingBox();
  await p.mouse.move(edge.x, edge.y + 300);
  await p.mouse.down();
  await p.mouse.move(edge.x - 120, edge.y + 300, { steps: 6 });
  await p.mouse.up();
  await p.waitForTimeout(300);
  const after = (await pane.boundingBox()).width;
  if (Math.abs(after - 420) > 3) throw new Error(`dragging the edge should make it 420px, not ${after}`);
  const kept = await p.locator(".app-full").getAttribute("style");
  if (!kept?.includes("--side-w: 420px")) throw new Error(`the width wasn't kept (${kept})`);
});
// The version dot: red with a newer version, and Update in its card.
await shot("full-version-dot", FULL, full({ settings: DARK, update: { state: "ready", version: "0.9.9", notes: null } }), async (p) => {
  // A newer version opens its card by itself, once.
  await p.waitForTimeout(300);
  if (!(await p.locator(".vdot-pop").count())) throw new Error("the update card didn't open by itself");
  if (!(await p.locator(".vdot.red").count())) throw new Error("the dot isn't red with a newer version out");
  await p.locator(".vdot-pop").getByRole("button", { name: "Update" }).waitFor();
});
await shot("full-version-latest", FULL, full({ settings: DARK, update: { state: "up_to_date" } }), async (p) => {
  await p.locator(".vdot").click();
  if (!(await p.locator(".vdot.green").count())) throw new Error("the dot isn't green on the latest version");
});
// The mayor: a 3D figure, a man or a woman.
await shot("full-mayor-pick", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".sidebar").getByRole("button", { name: /^Settings/ }).click();
  await tab(p, "Your city");
  await p.getByRole("radio", { name: /Woman/ }).click();
  await p.waitForTimeout(300);
  if (!(await p.locator(".sb-mayor .mayor-badge.figure img").count())) throw new Error("no 3D mayor in the sidebar");
});
await shot("full-city-mayor-woman", FULL, full({ settings: { ...DARK, look: { ...(DARK.look ?? {}), mayor_look: "woman" } } }), async (p) => {
  await p.locator(".sb-mayor").click();
  await p.waitForTimeout(1200);
});
await shot("full-room-drawers", FULL, full({ settings: DARK }), async (p) => {
  await openFloor(p);
  await p.locator(".task .task-row", { hasText: "Pack for the offsite" }).click();
  await p.waitForTimeout(200);
  if (!(await p.locator(".task.open .sp-done").count())) throw new Error("the task didn't open in place with a Done button");
});
await shot("full-task-when", FULL, full({ settings: DARK }), async (p) => {
  await openFloor(p);
  await p.locator(".task .task-row", { hasText: "Pack for the offsite" }).click();
  await p.waitForTimeout(200);
  await p.locator(".task.open .tc-props .tc-pill").first().click();
  await p.locator(".date-editor").waitFor();
  const box = await p.locator(".date-editor").boundingBox();
  if (box.width > 580) throw new Error(`the date card is too wide: ${Math.round(box.width)}px`);
  const cal = await p.locator(".date-editor .cal").boundingBox();
  if (cal.height > 280) throw new Error(`the month is too tall: ${Math.round(cal.height)}px`);
  await p.getByRole("combobox", { name: "Time" }).click();
  await p.keyboard.type("10:30pm");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(150);
  if (!(await p.locator(".time-select.set").count())) throw new Error("typing a time didn't set it");
  await p.getByRole("combobox", { name: "Time" }).click();
  await p.waitForTimeout(150);
});
await shot("full-task-deadline", FULL, full({ settings: DARK }), async (p) => {
  await openFloor(p);
  await p.locator(".task .task-row", { hasText: "Pack for the offsite" }).click();
  await p.waitForTimeout(200);
  await p.locator(".task.open .tc-props .tc-pill").nth(1).click();
  await p.locator(".de-tab.on", { hasText: "Deadline" }).waitFor();
  await p.locator(".date-editor .cal-quick", { hasText: "Friday" }).click();
  await p.waitForTimeout(150);
});
await shot("full-task-title-date", FULL, full({ settings: DARK }), async (p) => {
  await openFloor(p);
  await p.locator(".task .task-row", { hasText: "Pack for the offsite" }).click();
  await p.waitForTimeout(200);
  await p.locator(".task.open .tc-title").click();
  await p.keyboard.press("End");
  await p.keyboard.type(" tomorrow 10:30 pm");
  await p.locator(".tc-suggest").waitFor();
});
await shot("full-add-rich", FULL, full({ settings: DARK }), async (p) => {
  await side(/Offsite 2026/)(p);
  await p.getByRole("button", { name: /^Add Task$/ }).click();
  await p.keyboard.type("Ship the update tomorrow 3pm");
  if (!(await p.locator(".add-task-understood").count())) throw new Error("the typed date wasn't understood");
  await p.locator(".add-task-notes").click();
  await p.keyboard.type("Release notes are in the shared doc");
  await p.locator(".add-task .step-add").click();
  await p.keyboard.type("Write the notes");
  await p.keyboard.press("Enter");
  await p.keyboard.type("Tag the release");
  await p.keyboard.press("Enter");
  if ((await p.locator(".add-task .step").count()) !== 2) throw new Error("sub-tasks didn't add with Return");
  await p.locator(".add-task-pills .tc-pill").first().click();
  await p.locator(".add-task .date-editor").waitFor();
});
await shot("full-floor-menu", FULL, full({ settings: DARK }), async (p) => {
  await side(/Offsite 2026/)(p);
  await p.locator(".sb-b", { hasText: "Offsite 2026" }).hover();
  await p.getByRole("button", { name: "More for Offsite 2026" }).click();
});
await shot("full-project-color", FULL, full({ settings: DARK }), async (p) => {
  await side(/Q4 launch/)(p);
  await p.locator(".sb-b", { hasText: "Q4 launch" }).hover();
  await p.getByRole("button", { name: "More for Q4 launch" }).click();
  await p.getByRole("radio", { name: "Pink" }).click();
  await p.waitForTimeout(300);
});
await shot("full-city-story", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".ff-city").click();
  await p.waitForTimeout(600);
  await p.getByRole("button", { name: /Story/ }).click();
  await p.locator(".story-card").getByRole("button", { name: "Next", exact: true }).click();
  await p.locator(".story-card").getByRole("button", { name: "Next", exact: true }).click();
  await p.waitForTimeout(350);
});
await shot("full-city-milestones", FULL, full({ settings: { ...DARK, city_peak: 1200, city_seen: 1200 } }), async (p) => {
  await p.locator(".ff-city").click();
  await p.waitForTimeout(900);
  const n = await p.locator(".city3d-label.landmark").count();
  if (n < 6) throw new Error(`expected the park, square, train, harbour, stadium and island labels, saw ${n}`);
});
await shot("full-city-milestones-light", FULL, full({ settings: { ...LIGHT, city_peak: 1200, city_seen: 1200 } }), async (p) => {
  await p.locator(".ff-city").click();
  await p.waitForTimeout(900);
});
await shot("full-city-milestones-sheet", FULL, full({ settings: { ...DARK, city_peak: 80, city_seen: 99999 } }), async (p) => {
  await p.locator(".ff-city").click();
  await p.waitForTimeout(500);
  await p.getByRole("button", { name: /Milestones/ }).click();
  await p.waitForTimeout(300);
  if ((await p.locator(".ms-list li.got").count()) < 3) throw new Error("reached milestones aren't marked");
  if (!(await p.locator(".ms-rules").textContent()).includes("What's built stays built")) throw new Error("rules missing");
});
await shot("full-city-celebrate", FULL, full({ settings: { ...DARK, city_peak: 120, city_seen: 10 } }), async (p) => {
  await p.waitForTimeout(300);
  if (!(await p.locator(".toast, [role=status]").filter({ hasText: "the train is running" }).count())) throw new Error("no milestone toast");
  await p.locator(".ff-city").click();
  await p.locator(".ms-cheer").waitFor();
  await p.waitForTimeout(400);
});
await shot("full-new-building", FULL, full({ settings: DARK }), async (p) => {
  await p.getByRole("button", { name: "New project" }).click();
  await p.keyboard.type("Garden reno");
});
await shot("full-city-dark-room", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".ff-city").click();
  await p.waitForTimeout(800);
  const c = await p.locator(".city-view canvas").first().boundingBox();
  for (const [dx, dy] of [[0, 40], [60, 20], [-80, 30], [120, -40], [-140, 60]]) {
    await p.mouse.move(c.x + c.width / 2 + dx, c.y + c.height / 2 + dy, { steps: 2 });
    await p.waitForTimeout(80);
    if (await p.locator(".cv-tip", { hasText: /still to do|Overdue|readied/ }).count()) break;
  }
});
await shot("full-city-house", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".ff-city").click();
  await p.waitForTimeout(900);
  const c = await p.locator(".city-view canvas").first().boundingBox();
  // Sweep across the city until a house is under the pointer.
  outer: for (let y = 0.35; y < 0.95; y += 0.05) {
    for (let x = 0.1; x < 0.95; x += 0.05) {
      await p.mouse.move(c.x + c.width * x, c.y + c.height * y);
      await p.waitForTimeout(30);
      if (await p.locator(".cv-tip", { hasText: "A house" }).count()) break outer;
    }
  }
  const tip = p.locator(".cv-tip", { hasText: "A house" });
  if (await tip.count()) {
    const strong = await tip.locator("strong").textContent();
    if (strong === "Houses") throw new Error("hovering a house shows the whole neighbourhood, not its task");
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
