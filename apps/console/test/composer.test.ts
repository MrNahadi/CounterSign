import { describe, expect, it } from "vitest";
import {
  BASELINE_NOTE,
  type ComposerForm,
  checkPhoto,
  DEFAULT_MODE,
  MESSAGES_PATH,
  messageRequest,
  SIMULATED_NOTE,
  sendMessage,
  toBase64,
} from "../src/composer";
import { RESOLVE_UNREACHABLE } from "../src/resolve-routes";
import { MessageRequestSchema } from "../src/resolve-schemas";

// The "Simulate a message" dialog's form-to-request function and its send, with the console's
// route played by an injected fetch.

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MB2 = 2 * 1024 * 1024;

const photo = (name: string, type: string, bytes: Uint8Array, size = bytes.byteLength) => ({
  name,
  type,
  size,
  bytes,
});

const email: ComposerForm = {
  channel: "email",
  senderEmail: " payer@example.com ",
  senderPhone: "+254 700 000000",
  subject: " Stalled parcel ",
  body: "My parcel hasn't moved in 10 days.\n",
  photos: [photo("parcel.jpg", "image/jpeg", JPEG)],
};

const chat: ComposerForm = {
  channel: "chat",
  senderEmail: "",
  senderPhone: "+254 700 000000",
  subject: "Ignored for chat",
  body: "Where is KIK-1035?",
  photos: [],
};

describe("the mode switch and notes", () => {
  it("defaults to Protected and words the notes as requirements.md does", () => {
    expect(DEFAULT_MODE).toBe("protected");
    expect(BASELINE_NOTE).toBe(
      "Baseline: the same agent wired straight to PayPal's tools, with no Countersign checks. Sandbox only.",
    );
    expect(SIMULATED_NOTE).toBe("Simulated: no email is sent or received.");
  });
});

describe("messageRequest", () => {
  it("turns an email into Resolve's request, with photos as base64 and the chosen mode", () => {
    const result = messageRequest(email, "baseline");
    expect(result).toEqual({
      ok: true,
      request: {
        channel: "email",
        sender_email: "payer@example.com",
        subject: "Stalled parcel",
        body: "My parcel hasn't moved in 10 days.",
        attachments: [{ content_type: "image/jpeg", data: toBase64(JPEG) }],
        mode: "baseline",
      },
    });
    if (result.ok) expect(MessageRequestSchema.parse(result.request)).toEqual(result.request);
    expect(toBase64(JPEG)).toBe(Buffer.from(JPEG).toString("base64"));
  });

  it("sends a chat with a phone and no subject, and leaves out an empty email", () => {
    expect(messageRequest(chat, "protected")).toEqual({
      ok: true,
      request: {
        channel: "chat",
        sender_phone: "+254 700 000000",
        body: "Where is KIK-1035?",
        attachments: [],
        mode: "protected",
      },
    });
    const both = messageRequest({ ...chat, senderEmail: "buyer@example.com" }, "protected");
    expect(both.ok && both.request.sender_email).toBe("buyer@example.com");
  });

  it("names the field to fix, in one sentence", () => {
    const cases: [ComposerForm, string][] = [
      [{ ...email, senderEmail: " " }, "senderEmail"],
      [{ ...email, senderEmail: "not-an-email" }, "senderEmail"],
      [{ ...email, subject: "" }, "subject"],
      [{ ...email, subject: "x".repeat(201) }, "subject"],
      [{ ...email, body: "  \n" }, "body"],
      [{ ...email, body: "x".repeat(4001) }, "body"],
      [{ ...chat, senderPhone: "" }, "senderEmail"],
      [{ ...chat, senderPhone: "call me" }, "senderPhone"],
      [{ ...chat, senderPhone: "", senderEmail: "nope" }, "senderEmail"],
    ];
    for (const [form, field] of cases) {
      const result = messageRequest(form, "protected");
      expect(result.ok, field).toBe(false);
      if (!result.ok) {
        expect(result.field).toBe(field);
        expect(result.problem).toMatch(/^[A-Z].*\.$/);
        expect(result.problem).not.toContain("!");
      }
    }
  });

  it("takes up to 3 photos, each a JPEG, PNG or WebP of 2 MB or less", () => {
    const three = [1, 2, 3].map((n) => photo(`p${n}.png`, "image/png", PNG));
    expect(messageRequest({ ...email, photos: three }, "protected").ok).toBe(true);
    const four = messageRequest(
      { ...email, photos: [...three, photo("p4.png", "image/png", PNG)] },
      "protected",
    );
    expect(four).toEqual({ ok: false, field: "photos", problem: "Add up to 3 photos." });

    const gif = photo("cat.gif", "image/gif", JPEG);
    expect(messageRequest({ ...email, photos: [gif] }, "protected")).toEqual({
      ok: false,
      field: "photos",
      problem: "cat.gif isn't a JPEG, PNG or WebP image.",
    });
    const big = photo("big.jpg", "image/jpeg", JPEG, MB2 + 1);
    expect(messageRequest({ ...email, photos: [big] }, "protected")).toEqual({
      ok: false,
      field: "photos",
      problem: "big.jpg is larger than 2 MB.",
    });
    expect(checkPhoto(photo("edge.webp", "image/webp", JPEG, MB2))).toBeNull();
    expect(checkPhoto(photo("empty.jpg", "image/jpeg", new Uint8Array(), 0))).toBe(
      "empty.jpg is empty.",
    );
  });
});

describe("sendMessage", () => {
  const accepted = {
    ticket_id: `tkt_${"c".repeat(32)}`,
    thread_id: `tkt_${"c".repeat(32)}`,
    run_id: `run_${"d".repeat(32)}`,
  };

  function routeAt(answer: () => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return answer();
    }) as typeof fetch;
    return { calls, fetch: fetchFake };
  }

  const request = (() => {
    const result = messageRequest(email, "protected");
    if (!result.ok) throw new Error("fixture");
    return result.request;
  })();

  it("posts the request as JSON to the console's route and returns the new thread", async () => {
    const route = routeAt(() => Response.json(accepted, { status: 202 }));
    expect(await sendMessage(request, { fetch: route.fetch })).toEqual({
      ok: true,
      threadId: accepted.thread_id,
    });
    expect(route.calls).toHaveLength(1);
    expect(route.calls[0]?.url).toBe(MESSAGES_PATH);
    expect(route.calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(route.calls[0]?.init?.body))).toEqual(request);
  });

  it("shows Resolve's sentence from a 400, and one sentence for anything unreadable", async () => {
    const refused = routeAt(() =>
      Response.json(
        { message: "The first photo isn't the JPEG image its type says." },
        { status: 400 },
      ),
    );
    expect(await sendMessage(request, { fetch: refused.fetch })).toEqual({
      ok: false,
      message: "The first photo isn't the JPEG image its type says.",
    });
    const down = routeAt(() => Response.json({ message: RESOLVE_UNREACHABLE }, { status: 502 }));
    expect(await sendMessage(request, { fetch: down.fetch })).toEqual({
      ok: false,
      message: RESOLVE_UNREACHABLE,
    });
    for (const answer of [
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => new Response("<html>", { status: 500 }),
      () => Response.json({ thread_id: "nope" }, { status: 202 }),
    ]) {
      expect(await sendMessage(request, { fetch: routeAt(answer).fetch })).toEqual({
        ok: false,
        message: RESOLVE_UNREACHABLE,
      });
    }
  });
});
