import { fileURLToPath } from "node:url";
import type { RunMode } from "./runs";
import { type FileMessage, loadMessageFile, type Photo } from "./scenario-file";

// The demo scenarios the console's start page launches through `POST /scenarios/:id` (ADR 0043).
// Resolve alone decides which IDs and modes exist. Each file holds one simulated message from
// illustrative people; its photos sit beside it.

export type LauncherScenario = { id: string; file: string; modes: readonly RunMode[] };

export const LAUNCHER_SCENARIOS: readonly LauncherScenario[] = [
  {
    id: "beat-3-attack-email",
    file: "beat-3-attack-email.json",
    modes: ["protected", "baseline"],
  },
  { id: "beat-4-stalled-parcel", file: "beat-4-stalled-parcel.json", modes: ["protected"] },
  { id: "beat-5-damaged", file: "beat-5-damaged.json", modes: ["protected"] },
];

export const SCENARIOS_DIR = new URL("../scenarios/", import.meta.url);

export function findScenario(id: string): LauncherScenario | null {
  return LAUNCHER_SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}

/**
 * The scenario's one message and its photos, or null for an unknown ID. A file that doesn't load
 * or doesn't hold exactly one message is a packaging error, so it throws.
 */
export function loadScenario(id: string): { message: FileMessage; photos: Photo[] } | null {
  const scenario = findScenario(id);
  if (scenario === null) return null;
  const loaded = loadMessageFile(fileURLToPath(new URL(scenario.file, SCENARIOS_DIR)));
  if (!loaded.ok) throw new Error(`Scenario ${id} doesn't load: ${loaded.error}`);
  const [message, ...rest] = loaded.loaded.file.messages;
  const [photos] = loaded.loaded.photos;
  if (message === undefined || photos === undefined || rest.length > 0) {
    throw new Error(`Scenario ${id} must hold exactly one message.`);
  }
  return { message, photos };
}
