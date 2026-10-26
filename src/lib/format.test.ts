import { describe, expect, it } from "vitest";
import { formatBytes, percent, timeAgo } from "./format";

describe("formatBytes", () => {
  it("uses decimal units like Finder", () => {
    expect(formatBytes(2_019_377_440)).toBe("2.0 GB");
    expect(formatBytes(812_000_000)).toBe("812 MB");
    expect(formatBytes(640_000)).toBe("640 KB");
    expect(formatBytes(10)).toBe("1 KB");
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(Number.NaN)).toBe("0 MB");
  });
});

describe("percent", () => {
  it("clamps and floors", () => {
    expect(percent(0, 100)).toBe(0);
    expect(percent(999, 1000)).toBe(99);
    expect(percent(1000, 1000)).toBe(100);
    expect(percent(2000, 1000)).toBe(100);
    expect(percent(5, 0)).toBe(0);
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  it("reads like a person would say it", () => {
    expect(timeAgo("2026-10-20T11:59:40Z", now)).toBe("just now");
    expect(timeAgo("2026-10-20T11:55:00Z", now)).toBe("5 min ago");
    expect(timeAgo("2026-10-20T09:00:00Z", now)).toBe("3 h ago");
    expect(timeAgo("2026-10-19T10:00:00Z", now)).toBe("yesterday");
    expect(timeAgo("2026-10-16T12:00:00Z", now)).toBe("4 days ago");
    expect(timeAgo(null, now)).toBeNull();
    expect(timeAgo("nope", now)).toBeNull();
  });
});
