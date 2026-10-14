import { describe, expect, it } from "vitest";
import { formatBytes, percent } from "./format";

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
