import { describe, expect, it } from "vitest";
import { daysForDrag, isSideways, swipeDays } from "./weekSlide";

describe("daysForDrag", () => {
  it("snaps to whole days", () => {
    expect(daysForDrag(0, 100)).toBe(0);
    expect(daysForDrag(40, 100)).toBe(0);
    expect(daysForDrag(60, 100)).toBe(1);
    expect(daysForDrag(210, 100)).toBe(2);
  });
  it("dragging right moves ahead; left goes back", () => {
    expect(daysForDrag(200, 100)).toBe(2);
    expect(daysForDrag(-200, 100)).toBe(-2);
    expect(Object.is(daysForDrag(-10, 100), -0)).toBe(false);
  });
  it("does nothing without a column width", () => {
    expect(daysForDrag(300, 0)).toBe(0);
    expect(daysForDrag(Number.NaN, 100)).toBe(0);
  });
});

describe("swipeDays", () => {
  it("gathers small swipes until a whole day", () => {
    let left = 0;
    let moved = 0;
    for (const dx of [20, 20, 20, 20]) {
      const r = swipeDays(left, dx, 70);
      moved += r.days;
      left = r.left;
    }
    expect(moved).toBe(1);
    expect(left).toBe(10);
  });
  it("goes back on a swipe the other way", () => {
    expect(swipeDays(0, -150, 70)).toEqual({ days: -2, left: -10 });
  });
  it("never moves with no step", () => {
    expect(swipeDays(50, 500, 0)).toEqual({ days: 0, left: 0 });
  });
});

describe("isSideways", () => {
  it("tells a sideways swipe from scrolling the hours", () => {
    expect(isSideways(30, 2)).toBe(true);
    expect(isSideways(5, 40)).toBe(false);
    expect(isSideways(10, 9)).toBe(false);
    expect(isSideways(0, 0)).toBe(false);
  });
});
