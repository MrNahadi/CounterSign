import { CircleAlert, LoaderCircle } from "lucide-react";
import { Fragment, type HTMLAttributes, type ReactNode, useId } from "react";
import {
  CARD,
  CARD_DESCRIPTION,
  CARD_FILL,
  CARD_GAP,
  CARD_NESTED,
  CARD_TITLE,
  DESCRIPTION,
  PAGE_PAD,
  PAGE_TITLE,
  PAGE_WIDTH,
  SECTION_TITLE,
  SECTIONS,
} from "../src/controls";

// Small pieces shared by the console's screens, built from Graphite's Badge, inline code, Spinner,
// Card and page layout specs. No server-only imports, so client components can use them.

export type Tone = "neutral" | "positive" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "bg-component text-secondary-foreground",
  positive: "bg-positive-subtle text-on-positive-subtle-foreground",
  warning: "bg-warning-subtle text-on-warning-subtle-foreground",
  danger: "bg-danger-subtle text-on-danger-subtle-foreground",
};

export function Badge({
  tone,
  live = false,
  children,
}: {
  tone: Tone;
  live?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-caption-base font-medium ${TONES[tone]}`}
    >
      {live ? (
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
        />
      ) : null}
      {children}
    </span>
  );
}

// A reason code or tool name wraps only after an underscore (a `<wbr>` there), or moves whole to
// its own line; it breaks mid-word only when it can't fit a line by itself.
function breakAtUnderscores(children: ReactNode): ReactNode {
  if (typeof children !== "string" || !children.includes("_")) return children;
  const parts = children.split("_");
  return parts.map((part, i) =>
    i < parts.length - 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string never reorder
      <Fragment key={i}>
        {part}_<wbr />
      </Fragment>
    ) : (
      part
    ),
  );
}

export const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded-sm bg-component px-1 py-0.5 font-mono text-code-sm leading-body-sm wrap-anywhere">
    {breakAtUnderscores(children)}
  </code>
);

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <LoaderCircle
      size={size}
      strokeWidth={size > 16 ? 1.75 : 1.5}
      aria-hidden="true"
      className="motion-safe:animate-[spin_800ms_linear_infinite]"
    />
  );
}

export function Working({ label }: { label: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-body-sm text-secondary-foreground">
      <Spinner />
      {label}
    </p>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-body-sm text-secondary-foreground">
      <CircleAlert size={16} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

// The page inside the main container: Graphite's container padding, then a centred column at the
// page's width (content 1120px, narrow 768px, form 672px).
export function Page({
  width = "content",
  children,
}: {
  width?: keyof typeof PAGE_WIDTH;
  children: ReactNode;
}) {
  return (
    <div data-graphite="page" className={PAGE_PAD}>
      <div className={`mx-auto flex w-full flex-col ${PAGE_WIDTH[width]}`}>{children}</div>
    </div>
  );
}

// The page title (Heading 6), its actions on the same row and its description 8px below; 28px to
// the first content. `before` holds a breadcrumb.
export function PageHeader({
  title,
  description,
  actions,
  before,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  before?: ReactNode;
}) {
  return (
    <header className="mb-7 flex flex-col gap-2">
      {before}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className={`mr-auto ${PAGE_TITLE}`}>{title}</h1>
        {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
      </div>
      {description ? <p className={DESCRIPTION}>{description}</p> : null}
    </header>
  );
}

// Page sections, 80px apart from 900px up and 56px below.
export function Sections({ children }: { children: ReactNode }) {
  return <div className={SECTIONS}>{children}</div>;
}

// A page section: heading and description 8px apart, then 28px to the content. With no title it
// has no heading block and no top margin, and `label` names it for screen readers.
export function Section({
  id,
  title,
  description,
  actions,
  label,
  children,
}: {
  id?: string;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  label?: string;
  children: ReactNode;
}) {
  const generated = useId();
  const headingId = id ? `${id}-heading` : generated;
  if (!title) {
    return (
      <section id={id} aria-label={label}>
        {children}
      </section>
    );
  }
  return (
    <section id={id} aria-labelledby={headingId}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id={headingId} className={`mr-auto ${SECTION_TITLE}`}>
            {title}
          </h2>
          {actions}
        </div>
        {description ? <p className={DESCRIPTION}>{description}</p> : null}
      </div>
      <div className="mt-7">{children}</div>
    </section>
  );
}

const CARD_VARIANTS = { ring: CARD, fill: CARD_FILL, nested: CARD_NESTED } as const;

// Graphite's Card: a ring card on container, a card-fill group or a small nested card.
export function Card({
  as: Tag = "div",
  variant = "ring",
  gap,
  className = "",
  children,
  ...rest
}: {
  as?: "div" | "section" | "article";
  variant?: keyof typeof CARD_VARIANTS;
  gap?: keyof typeof CARD_GAP;
  // Layout only (self-start, md:hidden, min-w-0). Never padding, gap, radius, fill or shadow:
  // Tailwind can't let them beat the card's own, so those come from `variant` and `gap`.
  className?: string;
  children: ReactNode;
} & Pick<
  HTMLAttributes<HTMLElement>,
  "id" | "role" | "aria-label" | "aria-labelledby" | "aria-live"
>) {
  const blockGap = CARD_GAP[gap ?? (variant === "nested" ? "tight" : "default")];
  return (
    <Tag
      data-graphite={variant === "nested" ? "card-nested" : "card"}
      className={`${CARD_VARIANTS[variant]} ${blockGap} ${className}`.trim()}
      {...rest}
    >
      {children}
    </Tag>
  );
}

// A card's title (16px semibold) and its description on its own line 4px below.
export function CardHeading({
  title,
  description,
  as: Heading = "h2",
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  as?: "h2" | "h3";
  id?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Heading id={id} className={CARD_TITLE}>
        {title}
      </Heading>
      {description ? <p className={CARD_DESCRIPTION}>{description}</p> : null}
    </div>
  );
}
