"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// While a run is queued or running, re-renders the inbox from Resolve every `intervalMs`, and
// stops once nothing is working.
export function RefreshWhileWorking({
  active,
  intervalMs,
}: {
  active: boolean;
  intervalMs: number;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);
  return null;
}
