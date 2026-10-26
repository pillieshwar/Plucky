import { useRef } from "react";

export const SIDE_MIN = 240;
export const SIDE_MAX = 640;

/** The right-hand pane's width when the user hasn't set one (follows the window, as in the CSS). */
export const defaultSideWidth = () => (window.innerWidth <= 1180 ? 255 : 300);

/** Keep the pane between its limits and leave the list room to breathe. */
export function clampSide(w: number): number {
  const room = Math.max(SIDE_MIN, window.innerWidth - 640);
  return Math.round(Math.min(Math.max(w, SIDE_MIN), SIDE_MAX, room));
}

/**
 * The handle on the right-hand pane's left edge: drag it to make the pane
 * wider or narrower (arrow keys work too); double-click for the usual width.
 * `onLive` follows the pointer; `onCommit` saves once it's let go.
 */
export function SideResizer({
  width,
  onLive,
  onCommit,
}: {
  width: number;
  onLive: (w: number) => void;
  /** 0: back to the usual width. */
  onCommit: (w: number) => void;
}) {
  const start = useRef<{ x: number; w: number; last: number } | null>(null);
  return (
    <div
      className="side-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side pane"
      aria-valuemin={SIDE_MIN}
      aria-valuemax={SIDE_MAX}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click for the usual width"
      data-nodrag
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: width, last: width };
        document.documentElement.classList.add("resizing-side");
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        // The pane is on the right: moving left makes it wider.
        s.last = clampSide(s.w + (s.x - e.clientX));
        onLive(s.last);
      }}
      onPointerUp={(e) => {
        const s = start.current;
        start.current = null;
        document.documentElement.classList.remove("resizing-side");
        (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
        if (s && s.last !== s.w) onCommit(s.last);
      }}
      onPointerCancel={() => {
        start.current = null;
        document.documentElement.classList.remove("resizing-side");
      }}
      onDoubleClick={() => onCommit(0)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        if (e.key === "ArrowLeft") onCommit(clampSide(width + step));
        else if (e.key === "ArrowRight") onCommit(clampSide(width - step));
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    />
  );
}
