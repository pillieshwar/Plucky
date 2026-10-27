import type { ReactNode } from "react";
import { activeMode } from "../lib/modes";
import type { AppSettings, Status, UpdateStatus } from "../lib/types";
import type { ShortcutSettings } from "../lib/shortcuts";
import { ConnectorsTab } from "./ConnectorsTab";
import { DataTransferTab } from "./DataTransferTab";
import { AppearancePage, CapturePage, CityPage, DataSection, GeneralPage, HelpPage, NotificationsPage } from "./GeneralSettings";
import { ModelsTab } from "./ModelsTab";
import { ModesSection } from "./ModesSettings";
import { ShortcutEditor } from "./ShortcutEditor";
import { SyncSection, useSyncStatus } from "./SyncSection";

export type SettingsPage =
  | "general"
  | "appearance"
  | "notifications"
  | "capture"
  | "modes"
  | "city"
  | "sync"
  | "connectors"
  | "model"
  | "movein"
  | "backups"
  | "help";

interface PageInfo {
  id: SettingsPage;
  label: string;
  /** A small glyph on a colored tile. */
  glyph: string;
  tone: string;
}

export const PAGE_GROUPS: { label: string; pages: PageInfo[] }[] = [
  {
    label: "App",
    pages: [
      { id: "general", label: "General", glyph: "⚙", tone: "gray" },
      { id: "appearance", label: "Appearance", glyph: "◐", tone: "violet" },
      { id: "notifications", label: "Notifications", glyph: "●", tone: "red" },
      { id: "capture", label: "Capture & shortcuts", glyph: "⌘", tone: "blue" },
    ],
  },
  {
    label: "Tasks",
    pages: [
      { id: "modes", label: "Modes", glyph: "◑", tone: "amber" },
      { id: "city", label: "Your city", glyph: "▥", tone: "green" },
    ],
  },
  {
    label: "Connections",
    pages: [
      { id: "sync", label: "Your other Macs", glyph: "⇄", tone: "blue" },
      { id: "connectors", label: "Connectors", glyph: "⧉", tone: "teal" },
      { id: "model", label: "AI model", glyph: "✦", tone: "violet" },
    ],
  },
  {
    label: "Data",
    pages: [
      { id: "movein", label: "Import Data", glyph: "↓", tone: "gray" },
      { id: "backups", label: "Backups & export", glyph: "⛁", tone: "gray" },
      { id: "help", label: "Help", glyph: "?", tone: "gray" },
    ],
  },
];

const ALL = PAGE_GROUPS.flatMap((g) => g.pages);
export const pageLabel = (p: SettingsPage) => ALL.find((x) => x.id === p)?.label ?? "Settings";

/** Older names for places in Settings (from the menu bar, the tour…). */
export function pageFromTab(t: string): SettingsPage | null {
  const old: Record<string, SettingsPage> = { settings: "general", models: "model", transfer: "movein", preferences: "general" };
  if (old[t]) return old[t];
  return ALL.some((p) => p.id === t) ? (t as SettingsPage) : null;
}

/** The pages, grouped: a sidebar in full screen, a list in the side panel. */
export function SettingsNav({
  page,
  onPage,
  settings,
  update,
  variant,
}: {
  page: SettingsPage | null;
  onPage: (p: SettingsPage) => void;
  settings: AppSettings | null;
  update: UpdateStatus;
  variant: "side" | "list";
}) {
  const [sync] = useSyncStatus();
  const mode = activeMode(settings);
  const badge = (p: SettingsPage): ReactNode => {
    if (p === "modes" && mode) return mode.name;
    if (p === "sync" && sync?.on) return `${sync.devices.length} ${sync.devices.length === 1 ? "Mac" : "Macs"}`;
    if (p === "general" && update.state === "ready") return <span className="tab-dot" aria-label="Update ready" />;
    return null;
  };
  return (
    <nav className={`set-nav ${variant}`} aria-label="Settings">
      {PAGE_GROUPS.map((g) => (
        <div key={g.label} className="set-group">
          <h2 className="set-group-label">{g.label}</h2>
          {g.pages.map((p) => {
            const on = variant === "side" && page === p.id;
            return (
              <button
                key={p.id}
                type="button"
                className={on ? "set-item on" : "set-item"}
                aria-current={on ? "page" : undefined}
                onClick={() => onPage(p.id)}
              >
                <span className={`set-icon ${p.tone}`} aria-hidden>
                  {p.glyph}
                </span>
                <span className="set-label">{p.label}</span>
                <span className="set-badge">{badge(p.id)}</span>
                {variant === "list" && (
                  <svg className="set-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
                    <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** One page of Settings. */
export function SettingsContent({
  page,
  settings,
  onSettings,
  shortcuts,
  onShortcuts,
  status,
  update,
  onError,
  onTour,
  onKeys,
  onModelChanged,
  onDone,
  showTitle = true,
}: {
  page: SettingsPage;
  settings: AppSettings | null;
  onSettings: (s: AppSettings) => void;
  shortcuts: ShortcutSettings | null;
  onShortcuts: (s: ShortcutSettings) => void;
  status: Status | null;
  update: UpdateStatus;
  onError: (message: string) => void;
  onTour: () => void;
  onKeys: () => void;
  onModelChanged: () => void;
  /** Back to the tasks (after moving in). */
  onDone: () => void;
  showTitle?: boolean;
}) {
  const props = { settings, onSettings, onError };
  return (
    <div className={`settings set-page-${page}`}>
      {showTitle && <h1 className="set-title">{pageLabel(page)}</h1>}
      {page === "general" && <GeneralPage {...props} status={status} update={update} />}
      {page === "appearance" && <AppearancePage {...props} />}
      {page === "notifications" && <NotificationsPage {...props} />}
      {page === "capture" && <CapturePage {...props} shortcuts={<ShortcutEditor shortcuts={shortcuts} onShortcuts={onShortcuts} />} />}
      {page === "modes" && <ModesSection {...props} />}
      {page === "city" && <CityPage {...props} />}
      {page === "sync" && <SyncPage />}
      {page === "connectors" && <ConnectorsTab />}
      {page === "model" && <ModelsTab onChanged={onModelChanged} />}
      {page === "movein" && <DataTransferTab onFinished={onDone} />}
      {page === "backups" && <DataSection onError={onError} />}
      {page === "help" && <HelpPage onTour={onTour} onKeys={onKeys} />}
    </div>
  );
}

function SyncPage() {
  const [status, setStatus] = useSyncStatus();
  return (
    <section className="settings-section set-sync">
      <SyncSection status={status} onStatus={setStatus} />
    </section>
  );
}
