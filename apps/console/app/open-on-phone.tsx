import { DESCRIPTION } from "../src/controls";
import { QR_COPY, type QrView } from "../src/qr-view";
import { Section } from "./ui";

// The approvals page's URL as a QR code, shared by the approvals board and the start page. No
// hooks or browser code, so server and client components can both render it.

/** The approvals URL as a QR code, from 768px up: foreground modules on a container background. */
export function OpenOnPhone({ qr }: { qr: QrView }) {
  return (
    <div className="hidden md:block">
      <Section id="open-on-phone" title={QR_COPY.heading}>
        <div className="flex flex-col items-start gap-3">
          <svg
            role="img"
            aria-label={qr.label}
            viewBox={`0 0 ${qr.size} ${qr.size}`}
            shapeRendering="crispEdges"
            className="size-40 rounded-lg bg-container text-primary-foreground shadow-border"
          >
            <title>{qr.label}</title>
            {qr.rects.map((rect) => (
              <rect
                key={`${rect.x}-${rect.y}`}
                x={rect.x}
                y={rect.y}
                width={rect.width}
                height={1}
                className="fill-current"
              />
            ))}
          </svg>
          <p className={DESCRIPTION}>{QR_COPY.line}</p>
        </div>
      </Section>
    </div>
  );
}
