/**
 * Sliding the Calendar's week a day at a time: drag the row of dates, or
 * swipe sideways with two fingers. The view is always seven days wide; each
 * whole column's worth of movement moves it by one day.
 */

/**
 * How many days a drag of `dx` pixels moves the week, snapped to whole days.
 * Dragging right by two columns moves two days ahead: the next days come in
 * on the right and the first ones slide off the left.
 */
export function daysForDrag(dx: number, columnWidth: number): number {
  if (!(columnWidth > 0) || !Number.isFinite(dx)) return 0;
  const n = Math.round(dx / columnWidth);
  return n === 0 ? 0 : n; // never -0
}

/**
 * A two-finger sideways swipe: adds `deltaX` to what's been gathered so far
 * and returns how many whole days to move, with what's left over for next
 * time. `step` is how far a swipe goes for one day.
 */
export function swipeDays(gathered: number, deltaX: number, step: number): { days: number; left: number } {
  const total = gathered + deltaX;
  if (!(step > 0)) return { days: 0, left: 0 };
  const days = Math.trunc(total / step);
  return { days: days === 0 ? 0 : days, left: total - days * step };
}

/** A mostly sideways wheel event (a horizontal swipe, not a scroll). */
export function isSideways(deltaX: number, deltaY: number): boolean {
  return Math.abs(deltaX) > Math.abs(deltaY) * 1.5 && Math.abs(deltaX) > 0.5;
}
