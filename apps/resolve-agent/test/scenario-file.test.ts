import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DatabaseHandle, openPgliteDirectory, seedOrders } from "@countersign/db";
import { trackedTempDirs } from "@countersign/gate/test/temp-dirs";
import { afterEach, describe, expect, it } from "vitest";
import { loadMessageFile, senderEmail } from "../src/scenario-file";

const tempDir = trackedTempDirs();
let handles: DatabaseHandle[] = [];

afterEach(async () => {
  for (const handle of handles) await handle.close().catch(() => {});
  handles = [];
});

async function database(seed: readonly { n: number; buyer: "A" | "B"; email: string }[] = []) {
  const handle = await openPgliteDirectory(tempDir("scenario-file-"));
  handles.push(handle);
  for (const { n, buyer, email } of seed) {
    await handle.db.insert(seedOrders).values({
      orderNumber: `KIK-${n}`,
      runId: "run1",
      paypalOrderId: `ORD${n}`,
      paypalCaptureId: `CAP${n}`,
      amountMinor: 1800,
      currency: "USD",
      payerEmail: email,
      buyer,
      trackingNumber: `KC-run1-${n}`,
      role: "demo",
      seededAt: "2026-10-01T08:00:00Z",
    });
  }
  return handle.db;
}

describe("senderEmail", () => {
  it("names the order that isn't seeded, with today's sentence", async () => {
    const db = await database();
    expect(await senderEmail(db, "payer:KIK-1035")).toEqual({
      ok: false,
      error: "Order KIK-1035 isn't seeded. Run npm run seed first.",
      unseeded: "Order KIK-1035",
    });
  });

  it("names the buyer that isn't seeded", async () => {
    const db = await database([{ n: 1035, buyer: "A", email: "amina.k@example.com" }]);
    expect(await senderEmail(db, "buyer:B")).toEqual({
      ok: false,
      error: "Buyer B isn't seeded. Run npm run seed first.",
      unseeded: "Buyer B",
    });
    expect(await senderEmail(db, "buyer:A")).toEqual({ ok: true, email: "amina.k@example.com" });
  });

  it("carries no unseeded name for other errors", async () => {
    const db = await database();
    // Past the schema's pattern, as a caller that skipped it would send.
    const result = await senderEmail(db, "payer:KIK-10" as never);
    expect(result).toEqual({
      ok: false,
      error: "payer:KIK-10 isn't an order number.",
      unseeded: null,
    });
  });

  it("resolves a payer order and a plain email", async () => {
    const db = await database([{ n: 1037, buyer: "A", email: "amina.k@example.com" }]);
    expect(await senderEmail(db, "payer:KIK-1037")).toEqual({
      ok: true,
      email: "amina.k@example.com",
    });
    expect(await senderEmail(db, "someone@example.com")).toEqual({
      ok: true,
      email: "someone@example.com",
    });
  });
});

describe("loadMessageFile", () => {
  it("refuses a file that isn't JSON or can't be read", () => {
    const dir = tempDir("scenario-file-");
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{");
    expect(loadMessageFile(bad)).toEqual({ ok: false, error: `${bad} isn't valid JSON.` });
    const missing = join(dir, "missing.json");
    expect(loadMessageFile(missing)).toEqual({ ok: false, error: `Can't read ${missing}.` });
  });

  it("refuses a photo that can't be read", () => {
    const dir = tempDir("scenario-file-");
    const path = join(dir, "m.json");
    writeFileSync(
      path,
      JSON.stringify({
        description: "Simulated.",
        messages: [{ channel: "chat", sender: "buyer:A", body: "Hi", attachments: ["gone.png"] }],
      }),
    );
    expect(loadMessageFile(path)).toEqual({
      ok: false,
      error: "Message 1: can't read the photo gone.png.",
    });
  });

  it("loads a file with no photos", () => {
    const dir = tempDir("scenario-file-");
    const path = join(dir, "m.json");
    writeFileSync(
      path,
      JSON.stringify({
        description: "Simulated.",
        messages: [{ channel: "chat", sender: "buyer:A", body: "Hi" }],
      }),
    );
    const result = loadMessageFile(path);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.loaded.photos).toEqual([[]]);
  });
});
