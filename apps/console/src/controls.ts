// Graphite class recipes for the console (Graphite Design/DESIGN.md, ADR 0045). Plain strings with
// no dependencies, so view modules, ui.tsx and client components can all use them.
//
// Tailwind v4 resolves two utilities for one property by stylesheet order, not by their order in
// the attribute, so a recipe never sets one property twice and callers append only layout classes
// (flex-1, w-full, self-start, ml-auto, md:hidden), never padding, height, radius, gap or font size.

export type ButtonSize = "sm" | "md" | "lg" | "xl";
export type ButtonVariant = "primary" | "secondary" | "tertiary" | "transparent" | "danger-subtle";

const BUTTON_BASE =
  "inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium motion-safe:transition motion-safe:duration-200 motion-safe:ease-out motion-safe:active:scale-[0.97] disabled:cursor-not-allowed";

// DESIGN.md Button sizes: 28, 32, 36 and 44px tall; 10, 14, 16 and 20px side padding; the start
// padding drops by the icon offset when a button leads with an icon; icon-only buttons are square.
// No extra-small size: it's under the 28px hit target.
const BUTTON_SIZES: Record<
  ButtonSize,
  { plain: string; leading: string; only: string; gap: string; text: string }
> = {
  sm: {
    plain: "h-7 px-2.5 rounded-lg",
    leading: "h-7 pr-2.5 pl-2 rounded-lg",
    only: "size-7 rounded-lg",
    gap: "gap-1.5",
    text: "text-caption-lg",
  },
  md: {
    plain: "h-8 px-3.5 rounded-lg",
    leading: "h-8 pr-3.5 pl-2.5 rounded-lg",
    only: "size-8 rounded-lg",
    gap: "gap-1.5",
    text: "text-body-sm",
  },
  lg: {
    plain: "h-9 px-4 rounded-lg",
    leading: "h-9 pr-4 pl-3 rounded-lg",
    only: "size-9 rounded-lg",
    gap: "gap-1.5",
    text: "text-body-sm",
  },
  xl: {
    plain: "h-11 px-5 rounded-lg",
    leading: "h-11 pr-5 pl-4 rounded-lg",
    only: "size-11 rounded-xl",
    gap: "gap-2",
    text: "text-body-sm",
  },
};

// DESIGN.md Button variants. Solid fills get a 2px focus offset so the ring stays visible.
const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-inverted-solid text-on-inverted-foreground hover:bg-inverted-solid-hover active:bg-inverted-solid-active focus-visible:outline-offset-2 disabled:bg-disabled disabled:text-disabled-foreground",
  secondary:
    "bg-component-on-container-strong text-primary-foreground shadow-default hover:bg-component-on-container-strong-hover disabled:bg-disabled disabled:text-disabled-foreground disabled:shadow-none",
  tertiary:
    "bg-component text-secondary-foreground hover:bg-component-hover disabled:bg-disabled disabled:text-disabled-foreground",
  transparent:
    "text-secondary-foreground hover:bg-transparent-hover hover:text-primary-foreground active:bg-transparent-active disabled:text-disabled-foreground",
  "danger-subtle":
    "bg-danger-subtle text-danger-foreground hover:bg-danger-subtle-hover disabled:bg-disabled disabled:text-disabled-foreground",
};

// DESIGN.md Button: one class from each part, so no property appears twice.
export function button(
  variant: ButtonVariant,
  size: ButtonSize = "md",
  options: { icon?: "leading" | "only" } = {},
): string {
  const parts = BUTTON_SIZES[size];
  const box =
    options.icon === "only" ? parts.only : options.icon === "leading" ? parts.leading : parts.plain;
  return [BUTTON_BASE, box, parts.gap, parts.text, BUTTON_VARIANTS[variant]].join(" ");
}

// DESIGN.md Iconography: icon size by button size, and stroke 1.5 up to 16px, 1.75 at 20px.
export const ICON = { sm: 14, md: 16, lg: 16, xl: 20 } as const;
export const STROKE = (size: number) => (size > 16 ? 1.75 : 1.5);

// DESIGN.md Button, link variant: inline actions in text.
export const LINK = "font-medium text-brand-foreground hover:underline";

// DESIGN.md Input and textarea: 12px side padding, inset focus ring, inset danger ring on error.
const INPUT_BASE =
  "w-full min-w-0 rounded-lg bg-component-on-container-strong px-3 text-primary-foreground shadow-default placeholder:text-tertiary-foreground focus-visible:outline-offset-[-1px] aria-invalid:inset-ring aria-invalid:inset-ring-danger-border-default";
// DESIGN.md Input: 14px text.
export const INPUT = `${INPUT_BASE} text-body-sm`;
// DESIGN.md Input in mono, for the approver key field. Used instead of INPUT, never with it.
export const INPUT_MONO = `${INPUT_BASE} font-mono text-code-sm`;
// DESIGN.md Input heights: 36px by default, 32px in a toolbar, 44px on touch layouts.
export const INPUT_HEIGHT = { default: "h-9", toolbar: "h-8", touch: "h-11" } as const;
// DESIGN.md Textarea: at least 112px, 10 by 12px padding, 22px line height.
export const TEXTAREA = `${INPUT} min-h-28 resize-y py-2.5 leading-code-sm`;
// DESIGN.md Spacing: 8px between label, field and helper.
export const FIELD = "flex flex-col gap-2";
// DESIGN.md Spacing: 20px between form fields.
export const FORM = "flex flex-col gap-5";
// DESIGN.md Input: labels 14px medium.
export const LABEL = "text-body-sm font-medium text-primary-foreground";
// DESIGN.md Input: helper text 13px.
export const HELP = "text-caption-lg text-secondary-foreground";
// DESIGN.md Input: the error line 13px in danger-foreground.
export const FIELD_ERROR = "text-caption-lg text-danger-foreground";

// DESIGN.md Segmented control: sunken track, radius-xl, 2px padding; 32px overall.
export const SEGMENTED =
  "inline-flex max-w-full shrink-0 overflow-x-auto rounded-xl bg-sunken p-0.5";
const SEGMENT_BASE =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-body-sm font-medium motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out";
// DESIGN.md Segmented control: segments 28px tall with 12px side padding.
export const SEGMENT = `${SEGMENT_BASE} h-7 px-3`;
// DESIGN.md Segmented control, icon-only segment (the theme control). Used instead of SEGMENT.
export const SEGMENT_ICON = `${SEGMENT_BASE} size-7`;
// DESIGN.md Segmented control: the active segment.
export const SEGMENT_ON = "bg-component-on-sunken text-primary-foreground shadow-default";
// DESIGN.md Segmented control: idle segments.
export const SEGMENT_OFF = "text-secondary-foreground hover:text-primary-foreground";

// DESIGN.md Card: container with the ring, radius-3xl, 24px padding. The gap comes from CARD_GAP.
export const CARD = "flex flex-col rounded-3xl bg-container p-(--card-padding) shadow-border";
// DESIGN.md Card: card fill when grouping content inside a container.
export const CARD_FILL = "flex flex-col rounded-3xl bg-card p-(--card-padding)";
// DESIGN.md Card: small nested cards, radius-2xl and 16px padding.
export const CARD_NESTED = "flex flex-col rounded-2xl bg-card p-4";
// DESIGN.md Card: 20px between blocks; 12px for a message's parts and nested cards.
export const CARD_GAP = { default: "gap-5", tight: "gap-3" } as const;
// DESIGN.md Card: the title is 16px semibold with heading tracking.
export const CARD_TITLE = "text-body-base font-semibold tracking-heading text-primary-foreground";
// DESIGN.md Card: the description is 13px secondary-foreground on its own line.
export const CARD_DESCRIPTION = "text-caption-lg text-secondary-foreground";
// DESIGN.md Spacing: cards in a stack or grid 24px apart.
export const STACK = "flex flex-col gap-(--grid-gap)";

// DESIGN.md Table: a table card with a ring, clipped.
export const TABLE_CARD = "flex flex-col overflow-hidden rounded-3xl bg-container shadow-border";
// DESIGN.md Spacing: the toolbar above a table, 14px by 20px padding, 12px gap.
export const TOOLBAR =
  "flex flex-wrap items-center gap-3 border-b border-border-subtle px-5 py-3.5";
// DESIGN.md Table: 14px body text.
export const TABLE = "w-full border-collapse text-body-sm";
// DESIGN.md Table: the line under the header row.
export const TABLE_HEAD_ROW = "border-b border-border-default";
// DESIGN.md Table: 1px border-subtle dividers.
export const TABLE_BODY = "divide-y divide-border-subtle";
// DESIGN.md Table: header 44px, 13px medium sentence case in secondary-foreground.
export const TH =
  "h-(--table-header-height) px-4 text-left align-middle text-caption-lg font-medium whitespace-nowrap text-secondary-foreground";
// DESIGN.md Table: transparent-hover on hover.
export const TR =
  "hover:bg-transparent-hover motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out";
// DESIGN.md Table: rows at least 56px, 16px side padding, single lines centred (18px top padding).
export const TD = "h-(--table-row-height) px-4 py-4.5 align-top";
// DESIGN.md Table: a 13px second line 2px below (secondary-foreground, brief §11).
export const SUB_LINE = "mt-0.5 block text-caption-lg text-secondary-foreground";
// DESIGN.md Table: numbers right-aligned and tabular.
export const NUMBER = "text-right whitespace-nowrap tabular-nums";
// DESIGN.md Table: IDs, hashes, types and refs in mono 13px, on the 14px text's line height.
export const MONO = "font-mono text-code-sm leading-body-sm";
// DESIGN.md Table: mono values that may break anywhere (hashes).
export const MONO_BREAK = `${MONO} break-all`;

// DESIGN.md Spacing: main container padding, 32/16/64 below 900px and 48/56/96 from 900px.
export const PAGE_PAD = "px-4 pt-8 pb-16 wide:px-14 wide:pt-12 wide:pb-24";
// DESIGN.md Spacing: content 1120px, the narrow page 768px, forms 672px.
export const PAGE_WIDTH = {
  content: "max-w-(--content-max)",
  narrow: "max-w-3xl",
  form: "max-w-2xl",
} as const;
// DESIGN.md Spacing: page sections 80px apart, 56px below 900px.
export const SECTIONS = "flex flex-col gap-14 wide:gap-(--section-gap)";
// Page titles stay Heading 6 at 600 (requirements, deliberate departures).
export const PAGE_TITLE = "text-heading-6 font-semibold tracking-heading text-primary-foreground";
// DESIGN.md Spacing: a section title reads like a card title.
export const SECTION_TITLE = CARD_TITLE;
// DESIGN.md Spacing: page and section descriptions at 14px secondary-foreground.
export const DESCRIPTION = "text-body-sm text-secondary-foreground";

// DESIGN.md Color: inline alerts, subtle fill with its text token, radius-xl, 12 by 16px padding.
export const ALERT = {
  warning:
    "flex items-start gap-2 rounded-xl bg-warning-subtle px-4 py-3 text-body-sm text-on-warning-subtle-foreground",
  danger:
    "flex items-start gap-2 rounded-xl bg-danger-subtle px-4 py-3 text-body-sm text-on-danger-subtle-foreground",
  positive:
    "flex items-start gap-2 rounded-xl bg-positive-subtle px-4 py-3 text-body-sm text-on-positive-subtle-foreground",
  neutral:
    "flex items-start gap-2 rounded-xl bg-card px-4 py-3 text-body-sm text-primary-foreground",
} as const;
