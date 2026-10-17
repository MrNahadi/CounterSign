import { describe, expect, it } from "vitest";
import { TimestampSchema } from "../src/index";

describe("the timestamp rule", () => {
  it.each([
    "2026-02-31T10:00:00Z",
    "2026-02-29T10:00:00Z",
    "2026-10-17T06:40Z",
    "2026-10-17T06:40:00",
    "2026-10-17T25:00:00Z",
    "17 Oct 2026",
    "",
  ])("rejects %j", (value) => {
    expect(TimestampSchema.safeParse(value).success).toBe(false);
  });

  it.each(["2028-02-29T10:00:00Z", "2026-10-17T06:00:00.123+03:00", "2026-10-17T06:40:00Z"])(
    "accepts %j",
    (value) => {
      expect(TimestampSchema.safeParse(value)).toEqual({ success: true, data: value });
    },
  );
});
