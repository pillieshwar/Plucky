import { getCurrentWindow } from "@tauri-apps/api/window";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { api, onSettingsChanged } from "./lib/api";
import { applyTheme, cachedTheme } from "./lib/theme";
import { preloadDone, setDoneSound } from "./lib/sound";
import Popover from "./popover/Popover";
import QuickAdd from "./quick/QuickAdd";
import "./styles.css";
import "./popover/popover.css";
import "./quick/quick.css";

/** Both windows load this bundle; the window's label picks the view. */
function currentView(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return new URLSearchParams(window.location.search).get("view") ?? "panel";
  }
}

const view = currentView();
document.documentElement.dataset.view = view;
// No flash of the wrong theme while settings load.
applyTheme(cachedTheme());

// Every window follows the Appearance preference, live.
try {
  api
    .getSettings()
    .then((s) => {
      applyTheme(s.theme);
      setDoneSound(s.done_sound !== false);
      if (s.done_sound !== false) preloadDone();
    })
    .catch(() => undefined);
  void onSettingsChanged((s) => {
    applyTheme(s.theme);
    setDoneSound(s.done_sound !== false);
  }).catch(() => undefined);
} catch {
  // Outside Tauri (e.g. a browser preview): follow the system.
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{view === "popover" ? <Popover /> : view === "quick" ? <QuickAdd /> : <App />}</React.StrictMode>,
);
