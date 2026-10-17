import { describe, expect, it } from "vitest";
import { openPostgres } from "../src/index";

// postgres.js connects on first use, so these never reach a server.
const URL_WITHOUT_SERVER = "postgres://countersign@127.0.0.1:1/countersign";

describe("openPostgres options", () => {
  it.each(['bad"name', "Upper", "1starts_with_digit", "has space", "", "a".repeat(64)])(
    "refuses the schema name %j before connecting",
    (schema) => {
      expect(() => openPostgres(URL_WITHOUT_SERVER, { schema })).toThrow();
    },
  );

  it.each([0, -1, 1.5, 101])("refuses a pool size of %d", (max) => {
    expect(() => openPostgres(URL_WITHOUT_SERVER, { max })).toThrow();
  });

  it("accepts a plain schema name and a pool size without connecting", async () => {
    const handle = openPostgres(URL_WITHOUT_SERVER, { schema: "countersign_live_0a1b", max: 8 });
    expect(handle.kind).toBe("postgres");
    await handle.close();
  });
});
