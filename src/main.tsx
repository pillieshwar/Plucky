import { getCurrentWindow } from "@tauri-apps/api/window";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{view === "popover" ? <Popover /> : view === "quick" ? <QuickAdd /> : <App />}</React.StrictMode>,
);
