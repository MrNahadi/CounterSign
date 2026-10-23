// The evidence PDF (ADR 0035): a dispute's facts printed with pdf-lib on A4 in Helvetica, at
// most six pages. Every line comes from the facts, so no AI text can reach it. Text outside
// WinAnsi is replaced with "?". The PDF's dates come from the injected clock, so the same facts
// at the same time give the same bytes.

import { PDFDocument, type PDFFont, StandardFonts } from "pdf-lib";
import type { EvidenceFacts } from "./dispute-evidence";

export const PDF_MAX_PAGES = 6;
export const SHOP_LINE = "Kikapu Studio (illustrative)";
export const CARRIER_SIMULATED = "Carrier data is simulated in this demo.";
export const RECOMPUTE_LINE = "Recompute it with npm run ledger -- check-export.";
export const PDF_SECTIONS = [
  "Dispute",
  "Payment",
  "Shipping",
  "Refunds",
  "Countersign decisions",
  "Audit log",
] as const;

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 56;
const BODY = 10;
const HEADING = 13;
const TITLE = 18;
const LEADING = 1.45;

// WinAnsi's characters beyond Latin-1: what Helvetica in pdf-lib can encode.
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

/** The text with every character Helvetica can't print replaced by "?". */
export function winAnsi(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const printable = (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff);
    out += printable || WIN_ANSI_EXTRA.has(char) ? char : "?";
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A date as "22 Oct 2026", in UTC. */
export function dayWords(at: Date): string {
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

type Line = { text: string; size: number; bold?: boolean; gap?: number };

const body = (text: string): Line => ({ text, size: BODY });
const heading = (text: string): Line => ({ text, size: HEADING, bold: true, gap: 10 });

function lines(facts: EvidenceFacts, now: Date): Line[] {
  const out: Line[] = [
    { text: `Evidence for dispute ${facts.dispute.id}`, size: TITLE, bold: true },
    body(
      `Prepared by Countersign for ${SHOP_LINE} from PayPal sandbox records on ${dayWords(now)}.`,
    ),
  ];
  if (facts.notAvailable.length > 0) {
    out.push(body("Some records couldn't be read:"));
    for (const missing of facts.notAvailable) out.push(body(`- ${missing}`));
  }

  const { dispute, capture } = facts;
  out.push(
    heading("Dispute"),
    body(`Dispute ID: ${dispute.id}`),
    body(`Status: ${dispute.status}`),
    body(`Reason: ${dispute.reasonWords} (${dispute.reason})`),
    body(`Stage: ${dispute.lifeCycleStage}`),
    body(`Amount: ${dispute.amount.display}`),
    body(`Seller response due: ${dispute.sellerResponseDueDate ?? "None given"}`),
  );

  out.push(
    heading("Payment"),
    body(`Capture ID: ${capture.id}`),
    body(`Amount: ${capture.amount?.display ?? "Not available"}`),
    body(`Status: ${capture.status ?? "Not available"}`),
    body(`Captured: ${capture.time ?? "Not available"}`),
    body(`Order number: ${facts.orderNumber ?? "Not seeded"}`),
  );

  out.push(heading("Shipping"), body(CARRIER_SIMULATED));
  if (facts.shipping === null) out.push(body("Trackers: Not available"));
  else if (facts.shipping.length === 0) out.push(body("No trackers on this payment."));
  for (const fact of facts.shipping ?? []) {
    out.push(body(`Tracking number ${fact.trackingNumber}, PayPal tracker ${fact.trackerStatus}`));
    if (fact.carrier === null) {
      out.push(body("  Carrier (simulated): Not available"));
      continue;
    }
    out.push(body(`  ${fact.carrier.source}: ${fact.carrier.carrierName}, ${fact.carrier.status}`));
    for (const scan of fact.carrier.scanEvents) {
      out.push(body(`  ${scan.at}  ${scan.description}, ${scan.place}`));
    }
  }

  out.push(heading("Refunds"));
  if (facts.refunds === null) out.push(body("Refunds: Not available"));
  else if (facts.refunds.length === 0) out.push(body("No refunds on this payment."));
  for (const refund of facts.refunds ?? []) {
    out.push(body(`Refund ${refund.id}: ${refund.amount.display}, ${refund.status}`));
    out.push(body(`  Time: ${refund.time ?? "Not available"}`));
  }

  out.push(heading("Countersign decisions"));
  if (facts.decisions === null) out.push(body("Decisions: Not available"));
  else if (facts.decisions.length === 0) out.push(body("No decisions on this payment."));
  for (const decision of facts.decisions ?? []) {
    const amount = decision.amount ? ` ${decision.amount.display}` : "";
    out.push(body(`${decision.at}  ${decision.actionWords}${amount}: ${decision.decisionWords}`));
    if (decision.claimWords !== null) out.push(body(`  Claim: ${decision.claimWords}`));
    for (const reason of decision.reasons) {
      out.push(body(`  ${reason.code}: ${reason.words}`));
    }
  }

  out.push(heading("Audit log"));
  if (facts.audit === null) {
    out.push(body("No audit-log entries name this payment, or the log couldn't be read."));
  } else {
    const { audit } = facts;
    out.push(
      body(`Entries in the export: ${audit.entryCount}`),
      body(`Chain: ${audit.intact ? "intact" : "broken"}`),
      body(audit.head ? `Head: #${audit.head.seq} ${audit.head.hash}` : "Head: none"),
      body(`Export file: ${audit.exportName}`),
      body(`Export SHA-256: ${audit.exportSha256}`),
      body(RECOMPUTE_LINE),
    );
  }
  return out;
}

// Splits a line into pieces that fit the width, at spaces when it can.
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = text.split(" ");
  const pieces: string[] = [];
  let current = "";
  const fits = (candidate: string) => font.widthOfTextAtSize(candidate, size) <= width;
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current !== "") pieces.push(current);
    // A word longer than the line is split by characters.
    let rest = word;
    while (!fits(rest)) {
      let cut = rest.length - 1;
      while (cut > 1 && !fits(rest.slice(0, cut))) cut -= 1;
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    current = rest;
  }
  pieces.push(current);
  return pieces;
}

/** The evidence PDF's bytes for these facts, made at `now`. */
export async function buildEvidencePdf(facts: EvidenceFacts, now: Date): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const title = winAnsi(`Evidence for dispute ${facts.dispute.id}`);
  pdf.setTitle(title);
  pdf.setAuthor("Countersign");
  pdf.setCreator("Countersign");
  pdf.setProducer("Countersign");
  pdf.setCreationDate(now);
  pdf.setModificationDate(now);

  const width = A4[0] - 2 * MARGIN;
  let page = pdf.addPage(A4);
  let y = A4[1] - MARGIN;
  let full = false;
  for (const line of lines(facts, now)) {
    const font = line.bold ? bold : regular;
    const height = line.size * LEADING;
    y -= line.gap ?? 0;
    for (const piece of wrap(winAnsi(line.text), font, line.size, width)) {
      if (y - height < MARGIN) {
        if (pdf.getPageCount() >= PDF_MAX_PAGES) {
          full = true;
          break;
        }
        page = pdf.addPage(A4);
        y = A4[1] - MARGIN;
      }
      y -= height;
      page.drawText(piece, { x: MARGIN, y, size: line.size, font });
    }
    if (full) break;
  }
  if (full) {
    // The last line of the last page says the rest is in the export file.
    page.drawText("More records are in the export file.", {
      x: MARGIN,
      y: MARGIN / 2,
      size: BODY,
      font: regular,
    });
  }
  return pdf.save({ useObjectStreams: false });
}
