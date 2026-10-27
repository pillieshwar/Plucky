import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { UpdateStatus } from "../lib/types";

/**
 * The version, at the right of full screen's footer, with a dot: green on
 * the latest version, red when a newer one is out. Click it for the version
 * and, when there's a newer one, Update — which gets it (if it isn't
 * downloaded yet) and restarts into it. A newer version opens the card by
 * itself once; after that the red pill waits.
 */
export function VersionDot({ update, version, onError }: { update: UpdateStatus; version: string | null; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  // Update was pressed while the new version was still downloading.
  const [wanted, setWanted] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const newer = update.state === "ready" || update.state === "downloading";
  const tone = newer ? "red" : update.state === "failed" ? "gray" : "green";
  // Open by itself the first time a given version is ready.
  useEffect(() => {
    if (update.state !== "ready") return;
    let seen: string | null = null;
    try {
      seen = localStorage.getItem("todocity.updateSeen");
    } catch {
      // No storage: open it this once.
    }
    if (seen === update.version) return;
    setOpen(true);
    try {
      localStorage.setItem("todocity.updateSeen", update.version);
    } catch {
      // The card may open again next launch.
    }
  }, [update]);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const install = () => {
    setBusy(true);
    api.installUpdate().catch((e) => {
      setBusy(false);
      onError(String(e));
    });
  };
  // Once it's downloaded, finish what Update started.
  useEffect(() => {
    if (wanted && update.state === "ready") {
      setWanted(false);
      install();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, update.state]);

  const label =
    update.state === "ready"
      ? `TodoCity ${update.version} is out`
      : update.state === "downloading"
        ? `Getting TodoCity ${update.version}${update.percent !== null ? ` · ${update.percent}%` : "…"}`
        : update.state === "checking"
          ? "Checking for updates…"
          : update.state === "failed"
            ? "Couldn't check for updates"
            : "You're on the latest version";

  return (
    <div className={open ? "vdot-wrap open" : "vdot-wrap"} ref={ref}>
      <span className="vdot-version">TodoCity {version ?? ""}</span>
      <button type="button" className={`vdot ${tone}`} aria-expanded={open} title={label} onClick={() => setOpen((o) => !o)}>
        <span className="vdot-dot" aria-hidden />
        {busy
          ? "Updating…"
          : newer
            ? `Update to ${"version" in update ? update.version : ""}`
            : update.state === "failed"
              ? "Couldn't check"
              : update.state === "checking"
                ? "Checking…"
                : "Up to date"}
      </button>
      {open && (
        <div className="vdot-pop" role="dialog" aria-label="Version">
          <p className="vdot-now">
            <span className={`vdot-dot ${tone}`} aria-hidden /> {label}
          </p>
          <p className="vdot-ver">{version ? `This Mac has ${version}. ` : ""}Checks every day at 12:00 PM.</p>
          {newer ? (
            <button
              type="button"
              className="primary small vdot-btn"
              disabled={busy || wanted}
              onClick={() => (update.state === "ready" ? install() : setWanted(true))}
            >
              {busy ? "Restarting…" : wanted ? "Updating when it's ready…" : "Update"}
            </button>
          ) : (
            <button
              type="button"
              className="ghost small vdot-btn"
              disabled={update.state === "checking"}
              onClick={() => void api.checkForUpdates().catch((e) => onError(String(e)))}
            >
              Check now
            </button>
          )}
        </div>
      )}
    </div>
  );
}
