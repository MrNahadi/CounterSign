import { describe, expect, it } from "vitest";
import { type RecordSnapshots, runVerifiers, type TicketSnapshot } from "../src/index";
import { intent, ticket } from "./fixtures";

function photo(records: RecordSnapshots) {
  return runVerifiers(intent, records).find((entry) => entry.verifier === "evidence.photo_present");
}

const withPhoto: TicketSnapshot = {
  ...ticket,
  attachments: [{ id: "att_01", contentType: "image/jpeg" }],
};

describe("evidence.photo_present", () => {
  it("passes with an image attachment", () => {
    expect(photo({ ticket: withPhoto })?.result).toBe("pass");
  });

  it("passes when one of several attachments is an image, whatever its case", () => {
    const mixed: TicketSnapshot = {
      ...ticket,
      attachments: [
        { id: "att_01", contentType: "application/pdf" },
        { id: "att_02", contentType: "Image/PNG" },
      ],
    };
    expect(photo({ ticket: mixed })?.result).toBe("pass");
  });

  it("fails without an image attachment", () => {
    expect(photo({ ticket })?.result).toBe("fail");
    const pdf: TicketSnapshot = {
      ...ticket,
      attachments: [{ id: "att_01", contentType: "application/pdf" }],
    };
    expect(photo({ ticket: pdf })?.result).toBe("fail");
  });

  it("is unknown without the intent's ticket", () => {
    expect(photo({})?.result).toBe("unknown");
    expect(photo({ ticket: { ...withPhoto, id: "tkt_0043" } })?.result).toBe("unknown");
  });

  it("names the ticket call and record ID", () => {
    const expected = [{ call: "ticket", id: "tkt_0042" }];
    expect(photo({ ticket: withPhoto })?.records).toEqual(expected);
    expect(photo({})?.records).toEqual(expected);
  });

  it("names the image in its detail", () => {
    expect(photo({ ticket: withPhoto })?.detail).toBe("Ticket tkt_0042 has image att_01");
  });
});
