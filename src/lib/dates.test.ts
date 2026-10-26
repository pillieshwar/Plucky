import { describe, expect, it } from "vitest";
import { dayOrderForLocale, normalize, relativeLabel, resolveDatePhrase, resolveExtraction } from "./dates";

// Tuesday, 13 October 2026, mid-afternoon local time.
const TUE = new Date(2026, 9, 13, 15, 30);
const FRI = new Date(2026, 9, 16, 9, 0);
const SAT = new Date(2026, 9, 17, 9, 0);
const SUN = new Date(2026, 9, 18, 9, 0);

const r = (phrase: string, ref = TUE, order: "MDY" | "DMY" = "MDY") => resolveDatePhrase(phrase, ref, order);

describe("normalize", () => {
  it("strips deadline words, ordinals and time-of-day", () => {
    expect(normalize("By Friday EOD.")).toBe("friday");
    expect(normalize("no later than Oct 20th")).toBe("oct 20");
    expect(normalize("by the end of the month")).toBe("end of the month");
    expect(normalize("Thursday at 3pm")).toBe("thursday");
    expect(normalize("tomorrow morning")).toBe("tomorrow");
  });
});

describe("relative days", () => {
  it("today / tomorrow / day after", () => {
    expect(r("today")).toEqual({ date: "2026-10-13", alternatives: [], confident: true });
    expect(r("EOD").date).toBe("2026-10-13");
    expect(r("tomorrow").date).toBe("2026-10-14");
    expect(r("the day after tomorrow").date).toBe("2026-10-15");
  });

  it("in N days / weeks / business days", () => {
    expect(r("in 3 days").date).toBe("2026-10-16");
    expect(r("in two weeks").date).toBe("2026-10-27");
    expect(r("in a week").date).toBe("2026-10-20");
    // Tue + 4 business days skips the weekend.
    expect(r("in 4 business days").date).toBe("2026-10-19");
  });
});

describe("weekdays", () => {
  it("plain and 'this' weekday resolve to the coming one", () => {
    expect(r("by Friday")).toEqual({ date: "2026-10-16", alternatives: [], confident: true });
    expect(r("this thurs").date).toBe("2026-10-15");
    expect(r("Monday")).toEqual({ date: "2026-10-19", alternatives: [], confident: true });
  });

  it("'next Friday' mid-week is ambiguous and offers both", () => {
    expect(r("next Friday")).toEqual({ date: "2026-10-23", alternatives: ["2026-10-16"], confident: false });
  });

  it("'next Friday' from Saturday is unambiguous", () => {
    expect(r("next friday", SAT)).toEqual({ date: "2026-10-23", alternatives: [], confident: true });
  });

  it("same weekday as today asks", () => {
    expect(r("friday", FRI)).toEqual({ date: "2026-10-16", alternatives: ["2026-10-23"], confident: false });
  });

  it("explicit week qualifiers", () => {
    expect(r("wednesday next week").date).toBe("2026-10-21");
    expect(r("monday this week").date).toBe("2026-10-12");
  });
});

describe("weeks and months", () => {
  it("end of week is Friday", () => {
    expect(r("end of the week")).toEqual({ date: "2026-10-16", alternatives: [], confident: true });
    expect(r("EOW").date).toBe("2026-10-16");
    expect(r("end of week", SAT)).toEqual({ date: "2026-10-23", alternatives: [], confident: false });
  });

  it("next week is vague, end of next week is not", () => {
    expect(r("next week")).toEqual({ date: "2026-10-19", alternatives: [], confident: false });
    expect(r("end of next week").date).toBe("2026-10-23");
  });

  it("weekend", () => {
    expect(r("this weekend").date).toBe("2026-10-17");
    expect(r("the weekend", SUN).date).toBe("2026-10-18");
  });

  it("month ends", () => {
    expect(r("by the end of the month")).toEqual({ date: "2026-10-31", alternatives: [], confident: true });
    expect(r("end of next month").date).toBe("2026-11-30");
    expect(r("next month").confident).toBe(false);
  });
});

describe("calendar dates", () => {
  it("month names in either order, with ordinals", () => {
    expect(r("Oct 20").date).toBe("2026-10-20");
    expect(r("October 20th").date).toBe("2026-10-20");
    expect(r("20th of October").date).toBe("2026-10-20");
    expect(r("3 Nov 2027").date).toBe("2027-11-03");
  });

  it("past days without a year roll to next year", () => {
    expect(r("Jan 5").date).toBe("2027-01-05");
    expect(r("Oct 1").date).toBe("2027-10-01");
  });

  it("ISO and impossible dates", () => {
    expect(r("2026-12-01").date).toBe("2026-12-01");
    expect(r("Feb 30").date).toBe(null);
  });

  it("numeric dates honour locale but flag ambiguity", () => {
    expect(r("10/20")).toEqual({ date: "2026-10-20", alternatives: [], confident: true });
    expect(r("20/10")).toEqual({ date: "2026-10-20", alternatives: [], confident: true });
    expect(r("11/3")).toEqual({ date: "2026-11-03", alternatives: ["2027-03-11"], confident: false });
    expect(r("11/3", TUE, "DMY")).toEqual({ date: "2027-03-11", alternatives: ["2026-11-03"], confident: false });
    expect(r("12/25/26").date).toBe("2026-12-25");
  });
});

describe("vague and hostile input", () => {
  it("returns no date for vague phrases", () => {
    for (const p of ["soon", "asap", "later", "", "   "]) {
      expect(r(p)).toEqual({ date: null, alternatives: [], confident: false });
    }
  });

  it("does not read Object prototype keys as words", () => {
    expect(r("constructor").date).toBe(null);
    expect(r("in constructor days").date).toBe(null);
    expect(r("toString 5").date).toBe(null);
  });
});

describe("resolveExtraction", () => {
  it("asks when the model found no date", () => {
    expect(resolveExtraction(null, "none", TUE).mustAsk).toBe(true);
  });

  it("does not ask for a specific date the model was sure about", () => {
    const res = resolveExtraction("by Friday", "high", TUE);
    expect(res.date).toBe("2026-10-16");
    expect(res.mustAsk).toBe(false);
  });

  it("asks when the model was unsure even if parsing succeeded", () => {
    expect(resolveExtraction("Friday", "low", TUE).mustAsk).toBe(true);
  });

  it("asks when the phrase is ambiguous", () => {
    expect(resolveExtraction("next Friday", "high", TUE).mustAsk).toBe(true);
  });
});

describe("labels", () => {
  it("relative labels", () => {
    expect(relativeLabel("2026-10-13", TUE, "en-US")).toBe("Today");
    expect(relativeLabel("2026-10-14", TUE, "en-US")).toBe("Tomorrow");
    expect(relativeLabel("2026-10-16", TUE, "en-US")).toBe("Friday");
    expect(relativeLabel("2026-10-26", TUE, "en-US")).toBe("Mon, Oct 26");
  });

  it("day order from locale", () => {
    expect(dayOrderForLocale("en-US")).toBe("MDY");
    expect(dayOrderForLocale("en-GB")).toBe("DMY");
    expect(dayOrderForLocale("de-DE")).toBe("DMY");
  });
});
