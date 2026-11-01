"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { SEGMENT_ICON, SEGMENT_OFF, SEGMENT_ON, SEGMENTED } from "../src/controls";

type Theme = "system" | "light" | "dark";

const options = [
  { value: "system", label: "System theme", Icon: Monitor },
  { value: "light", label: "Light theme", Icon: Sun },
  { value: "dark", label: "Dark theme", Icon: Moon },
] as const;

function savedTheme(): Theme {
  try {
    const saved = localStorage.getItem("theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme) {
  const dark =
    theme === "system" ? matchMedia("(prefers-color-scheme: dark)").matches : theme === "dark";
  document.documentElement.classList.toggle("dark", dark);
}

// System / Light / Dark, as DESIGN.md asks. "System" clears the saved choice.
export function ThemeControl() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    setTheme(savedTheme());
  }, []);

  useEffect(() => {
    if (theme !== "system") return;
    const query = matchMedia("(prefers-color-scheme: dark)");
    const follow = () => applyTheme("system");
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [theme]);

  function choose(next: Theme) {
    setTheme(next);
    try {
      if (next === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", next);
    } catch {
      // Storage can be blocked; the choice still applies to this page.
    }
    applyTheme(next);
  }

  return (
    <fieldset aria-label="Theme" className={SEGMENTED}>
      {options.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-label={label}
          aria-pressed={theme === value}
          title={label}
          onClick={() => choose(value)}
          className={`${SEGMENT_ICON} ${theme === value ? SEGMENT_ON : SEGMENT_OFF}`}
        >
          <Icon size={14} strokeWidth={1.5} />
        </button>
      ))}
    </fieldset>
  );
}
