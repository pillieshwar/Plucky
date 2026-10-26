import { describe, expect, it } from "vitest";
import { safeLocale } from "./locale";

describe("safeLocale", () => {
  it("keeps valid tags", () => {
    expect(safeLocale("en-US")).toBe("en-US");
    expect(safeLocale("de-DE")).toBe("de-DE");
  });

  it("repairs tags Intl rejects", () => {
    expect(safeLocale("en-US@posix")).toBe("en-US");
    expect(safeLocale("en_GB.UTF-8")).toBe("en-GB");
    expect(safeLocale("C")).toBe("en-US");
    expect(safeLocale("")).toBe("en-US");
    expect(safeLocale(undefined)).toBe("en-US");
  });
});
