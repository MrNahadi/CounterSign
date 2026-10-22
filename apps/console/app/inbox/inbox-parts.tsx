import { type LucideIcon, Mail, MessageCircle, ShieldOff } from "lucide-react";
import Link from "next/link";
import {
  type MessageView,
  NO_CHECKS,
  type RunView,
  type StatusBadge,
  type ThreadListItem,
  type ThreadView,
  type ToolRow,
} from "../../src/inbox-view";
import { Badge, Code, Notice, Working } from "../ui";

// The inbox's pieces, built from Graphite's Badge, Card, inline code and Spinner specs.

const StatusBadgeView = ({ status }: { status: StatusBadge }) => (
  <Badge tone={status.tone} live={status.live}>
    {status.label}
  </Badge>
);

const CHANNEL_ICONS: Record<ThreadListItem["channel"], LucideIcon> = {
  email: Mail,
  chat: MessageCircle,
};

export function ThreadList({ items }: { items: ThreadListItem[] }) {
  if (items.length === 0) {
    return (
      <p className="p-4 text-body-sm text-secondary-foreground">
        No messages yet. Simulated customer messages will appear here.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-0.5 p-2">
      {items.map((item) => {
        const Icon = CHANNEL_ICONS[item.channel];
        return (
          <li key={item.id}>
            <Link
              href={item.href}
              aria-current={item.selected ? "true" : undefined}
              className={`flex gap-3 rounded-lg px-3 py-2.5 motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out ${
                item.selected ? "bg-brand-subtle" : "hover:bg-transparent-hover"
              }`}
            >
              <Icon
                size={16}
                strokeWidth={1.5}
                className="mt-0.5 shrink-0 text-secondary-foreground"
                aria-label={item.channelLabel}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-body-sm font-semimedium text-primary-foreground">
                    {item.sender}
                  </span>
                  <span className="shrink-0 text-caption-lg text-tertiary-foreground tabular-nums">
                    {item.time}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-body-sm text-secondary-foreground">
                    {item.title}
                  </span>
                  <StatusBadgeView status={item.status} />
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Message({ message }: { message: MessageView }) {
  return (
    <article className="rounded-2xl bg-card p-4">
      <header className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-body-sm font-medium">{message.sender}</span>
        <span className="shrink-0 text-caption-lg text-tertiary-foreground tabular-nums">
          {message.time}
        </span>
      </header>
      {message.subject ? (
        <p className="mt-1 text-body-sm font-medium text-secondary-foreground">{message.subject}</p>
      ) : null}
      <p className="mt-2 whitespace-pre-wrap break-words text-body-sm">{message.body}</p>
      {message.photos.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {message.photos.map((photo) => (
            <a key={photo.src} href={photo.src} target="_blank" rel="noreferrer">
              {/* biome-ignore lint/performance/noImgElement: photos come from Resolve through our own route, at their own size */}
              <img
                src={photo.src}
                alt={photo.alt}
                className="size-24 rounded-lg object-cover shadow-border"
              />
            </a>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function ToolCall({ row }: { row: ToolRow }) {
  return (
    <li className="flex flex-col gap-1.5 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Code>{row.name}</Code>
        {row.args.map((arg) => (
          <span key={arg.label} className="text-body-sm text-secondary-foreground">
            {arg.label}{" "}
            <span className="font-mono text-code-xs text-primary-foreground">{arg.value}</span>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {row.decision ? (
          <Badge tone={row.decision.tone}>{row.decision.label}</Badge>
        ) : (
          <span className="text-body-sm text-secondary-foreground">{row.result}</span>
        )}
        {row.noChecks ? (
          <Badge tone="warning">
            <ShieldOff size={12} strokeWidth={1.5} aria-hidden="true" />
            {NO_CHECKS}
          </Badge>
        ) : null}
      </div>
      {row.decision && row.decision.reasons.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {row.decision.reasons.map((reason) => (
            <li key={reason.code} className="text-body-sm text-secondary-foreground">
              {reason.words} <Code>{reason.code}</Code>
            </li>
          ))}
        </ul>
      ) : null}
      {row.decisionHref !== null ? (
        <Link
          href={row.decisionHref}
          className="self-start text-body-sm font-medium text-brand-foreground hover:underline"
        >
          Claims vs records
        </Link>
      ) : null}
      {row.refundId !== null && row.decision !== null ? (
        <p className="text-body-sm text-secondary-foreground">
          PayPal refund <Code>{row.refundId}</Code>
        </p>
      ) : null}
      {row.invoiceId !== null && row.decision !== null ? (
        <p className="text-body-sm text-secondary-foreground">
          PayPal invoice <Code>{row.invoiceId}</Code>
        </p>
      ) : null}
    </li>
  );
}

function Run({ run }: { run: RunView }) {
  const meta = [run.modeLabel, run.model, run.duration].filter((part) => part !== null);
  return (
    <section aria-label="Resolve's run" className="flex flex-col gap-3">
      {run.reply !== null ? (
        <article className="rounded-2xl p-4 shadow-border">
          <header className="text-body-sm font-medium">Resolve</header>
          <p className="mt-2 whitespace-pre-wrap break-words text-body-sm">{run.reply}</p>
        </article>
      ) : null}
      {run.outcome !== null ? <Notice>{run.outcome}</Notice> : null}
      {run.working ? <Working label="Resolve is working on this message." /> : null}
      <div className="rounded-2xl bg-card px-4 pt-3 pb-1">
        <header className="flex flex-wrap items-center gap-2">
          <h3 className="text-body-sm font-medium">What Resolve did</h3>
          <StatusBadgeView status={run.status} />
          <span className="text-caption-lg text-secondary-foreground tabular-nums">
            {meta.join(" · ")}
          </span>
        </header>
        {run.toolRows.length === 0 ? (
          <p className="py-3 text-body-sm text-secondary-foreground">No tool calls.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {run.toolRows.map((row) => (
              <ToolCall key={row.id} row={row} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function ThreadDetail({ view }: { view: ThreadView }) {
  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="text-body-base font-semibold">{view.title}</h2>
        <p className="text-body-sm text-secondary-foreground">
          {view.sender} · {view.channelLabel} · Simulated
        </p>
      </header>
      {view.entries.map((entry) =>
        entry.kind === "message" ? (
          <Message key={entry.message.id} message={entry.message} />
        ) : (
          <Run key={entry.run.id} run={entry.run} />
        ),
      )}
    </div>
  );
}
