import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { activeMode, newMode, setNewProjects, setProjectShown, showsProject } from "../lib/modes";
import type { AppSettings, CalendarInfo, ProjectSummary, ViewMode } from "../lib/types";
import { Toggle } from "./GeneralSettings";

interface Props {
  settings: AppSettings | null;
  onSettings: (s: AppSettings) => void;
  onError: (message: string) => void;
}

/**
 * Preferences → Modes: Work, Personal and any others, each showing just
 * the projects ticked here. Each Mac keeps its own modes and its own
 * current mode; tasks are the same everywhere.
 */
export function ModesSection({ settings, onSettings, onError }: Props) {
  const modes = settings?.modes ?? [];
  const current = activeMode(settings);
  const [sel, setSel] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const mode = modes.find((m) => m.id === sel) ?? current ?? modes[0] ?? null;

  useEffect(() => {
    api.listProjects().then(setProjects).catch(() => undefined);
  }, []);
  useEffect(() => {
    // The calendars the Calendar connector shows (if it's on).
    void (async () => {
      try {
        const st = await api.calendarStatus();
        if (!st.enabled || st.access !== "full") return;
        const c = await api.calendarCalendars();
        setCalendars(c.filter((x) => !st.hidden.includes(x.key)));
      } catch {
        // No calendars: the section stays hidden.
      }
    })();
  }, []);
  useEffect(() => {
    setName(mode?.name ?? "");
    setIcon(mode?.icon ?? "");
  }, [mode?.id, mode?.name, mode?.icon]);

  if (!settings || !mode) return null;
  const all = projects.map((p) => p.name);

  async function save(next: ViewMode[], extra?: Partial<AppSettings>) {
    try {
      onSettings(await api.setSettings({ ...settings!, modes: next, ...extra }));
    } catch (e) {
      onError(String(e));
    }
  }
  const change = (m: ViewMode) => void save(modes.map((x) => (x.id === m.id ? m : x)));
  const commitName = () => {
    const n = name.trim();
    const i = icon.trim();
    if ((n && n !== mode.name) || (i && i !== mode.icon)) change({ ...mode, name: n || mode.name, icon: i || mode.icon });
    else {
      setName(mode.name);
      setIcon(mode.icon);
    }
  };
  const add = () => {
    const m = newMode(modes);
    setSel(m.id);
    void save([...modes, m]);
  };
  const remove = () => {
    const rest = modes.filter((x) => x.id !== mode.id);
    setSel(rest[0]?.id ?? null);
    void save(rest, current?.id === mode.id ? { mode: null } : undefined);
  };
  const shown = all.filter((p) => showsProject(mode, p));

  return (
    <section className="settings-section" id="modes">
      <h2 className="settings-h">Modes</h2>
      <p className="settings-intro">
        A mode shows only the projects you choose — in Today, Calendar, Anytime, the menu bar and notifications. Switch with the menu at the
        top of the sidebar, or ⌃⌥1, ⌃⌥2… Each Mac remembers its own mode; your tasks stay the same everywhere.
      </p>

      <div className="modes-tabs" role="tablist" aria-label="Modes">
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={m.id === mode.id}
            className={m.id === mode.id ? "modes-tab on" : "modes-tab"}
            onClick={() => setSel(m.id)}
          >
            <span aria-hidden>{m.icon}</span> {m.name}
            {current?.id === m.id && <span className="modes-now">on now</span>}
          </button>
        ))}
        {modes.length < 12 && (
          <button type="button" className="modes-tab add" onClick={add}>
            + New mode
          </button>
        )}
      </div>

      <div className="modes-edit" role="tabpanel" aria-label={`${mode.name} mode`}>
        <div className="modes-name">
          <input
            className="modes-icon-input"
            value={icon}
            maxLength={4}
            aria-label="Icon (an emoji)"
            onChange={(e) => setIcon(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <input
            className="modes-name-input"
            value={name}
            maxLength={30}
            aria-label="Mode name"
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          {modes.length > 1 && (
            <button type="button" className="ghost small danger" onClick={remove}>
              Delete mode
            </button>
          )}
        </div>

        <h3 className="connector-subhead">{mode.name} shows</h3>
        <ul className="calendar-list modes-list">
          {projects.map((p) => (
            <li key={p.name}>
              <label>
                <input type="checkbox" checked={showsProject(mode, p.name)} onChange={(e) => change(setProjectShown(mode, p.name, e.target.checked))} />
                <span className="calendar-swatch" style={{ background: p.color ?? "var(--teal)" }} aria-hidden />
                <span className="calendar-name">{p.name}</span>
                <span className="calendar-source">{p.open ? `${p.open} to do` : ""}</span>
              </label>
            </li>
          ))}
          <li>
            <label>
              <input type="checkbox" checked={mode.no_project} onChange={(e) => change({ ...mode, no_project: e.target.checked })} />
              <span className="calendar-swatch" style={{ background: "var(--faint)" }} aria-hidden />
              <span className="calendar-name">Tasks with no project</span>
            </label>
          </li>
        </ul>
        {projects.length === 0 && <p className="sync-hint">No projects yet. Make one with + in the sidebar, then tick it here.</p>}

        <div className="card-stack modes-options">
          <Toggle
            label="Show new projects here too"
            hint="Projects you make later appear in this mode by themselves."
            checked={mode.new_projects}
            onChange={(v) => change(setNewProjects(mode, v, all))}
          />
          <Toggle
            label="Notifications only for these projects"
            hint={`While in ${mode.name}, reminders for other projects wait until you switch.`}
            checked={mode.notify}
            onChange={(v) => change({ ...mode, notify: v })}
          />
          <label className="setting-select">
            <span className="toggle-text">
              <span className="toggle-label">New tasks go to</span>
              <span className="toggle-hint">For tasks you add or capture with no project while in {mode.name}.</span>
            </span>
            <select
              value={mode.new_task_project ?? ""}
              onChange={(e) => change({ ...mode, new_task_project: e.target.value || null })}
              aria-label="New tasks go to"
            >
              <option value="">No project</option>
              {shown.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>

        {calendars.length > 0 && (
          <>
            <h3 className="connector-subhead">Calendars in {mode.name}</h3>
            <ul className="calendar-list modes-list">
              {calendars.map((c) => (
                <li key={c.key}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!mode.hidden_calendars.includes(c.key)}
                      onChange={(e) =>
                        change({
                          ...mode,
                          hidden_calendars: e.target.checked ? mode.hidden_calendars.filter((k) => k !== c.key) : [...mode.hidden_calendars, c.key],
                        })
                      }
                    />
                    <span className="calendar-swatch" style={{ background: c.color ?? "var(--faint)" }} aria-hidden />
                    <span className="calendar-name">{c.title}</span>
                    <span className="calendar-source">{c.source}</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <h3 className="connector-subhead">On this Mac</h3>
      <div className="card-stack">
        <label className="setting-select">
          <span className="toggle-text">
            <span className="toggle-label">Mode this Mac is in</span>
            <span className="toggle-hint">Your other Macs keep their own: say, Work on the work laptop and Personal at home.</span>
          </span>
          <select
            value={current?.id ?? ""}
            aria-label="Mode this Mac is in"
            onChange={(e) =>
              void api
                .setViewMode(e.target.value || null)
                .then(onSettings)
                .catch((err) => onError(String(err)))
            }
          >
            <option value="">Everything</option>
            {modes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.icon} {m.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}
