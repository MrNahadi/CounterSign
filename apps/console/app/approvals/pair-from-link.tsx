"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FIELD_ERROR } from "../../src/controls";
import { pairFromLink } from "../../src/pair-link";

// Phone pairing (ADR 0044): when the approvals page opens from the start page's QR code, its
// fragment holds a single-use code. On mount this drops the fragment from the address bar and
// trades the code once; the console's route sets the sign-in's cookies, so a refresh shows the
// cards. A refused code shows the gate's sentence. With no code, it renders nothing.

export function PairFromLink({ quiet = false }: { quiet?: boolean }) {
  const router = useRouter();
  const started = useRef(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void pairFromLink({
      hash: window.location.hash,
      clearHash: () =>
        window.history.replaceState(
          window.history.state,
          "",
          `${window.location.pathname}${window.location.search}`,
        ),
      fetch: (input, init) => window.fetch(input, init),
    }).then((outcome) => {
      if (outcome === null) return;
      if (outcome.paired) router.refresh();
      else setMessage(outcome.message);
    });
  }, [router]);

  if (quiet || message === null) return null;
  return (
    <p role="alert" className={FIELD_ERROR}>
      {message}
    </p>
  );
}
