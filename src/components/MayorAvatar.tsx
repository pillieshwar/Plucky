import { useMemo } from "react";
import { mayorPortrait, type MayorLook } from "../lib/mayorModel";

/** The mayor's face for the sidebar: a small 3D portrait, or initials if it can't be drawn. */
export function MayorAvatar({ look, fallback, size = 30 }: { look: MayorLook; fallback: string; size?: number }) {
  const url = useMemo(() => mayorPortrait(look, size * 3), [look, size]);
  return (
    <span className={url ? "mayor-badge figure" : "mayor-badge"} style={size !== 30 ? { width: size, height: size } : undefined} aria-hidden>
      {url ? <img src={url} alt="" width={size} height={size} draggable={false} /> : fallback}
    </span>
  );
}
