import { CARD_TITLE, HELP } from "../../../src/controls";
import { ThemeControl } from "../../theme-control";
import { RiskDeskSpike } from "./risk-desk-spike";

// Spike S9: AG Studio with the Graphite theme, a custom widget and a Gemini analyst. Not linked
// from the console; phase 16 builds the real Risk desk.
export const dynamic = "force-dynamic";

export default function RiskDeskSpikePage() {
  return (
    <div className="flex h-screen flex-col">
      <header data-graphite="spike-header" className="flex items-center justify-between px-6 py-4">
        <div className="flex items-baseline gap-2">
          <h1 className={CARD_TITLE}>Risk desk</h1>
          <span className={HELP}>Spike S9, sample data</span>
        </div>
        <ThemeControl />
      </header>
      <main className="mx-2 mb-2 min-h-0 flex-1 overflow-hidden rounded-2xl bg-container shadow-border">
        <RiskDeskSpike
          licenseKey={process.env.AG_STUDIO_LICENSE_KEY}
          aiEnabled={Boolean(process.env.GEMINI_API_KEY)}
        />
      </main>
    </div>
  );
}
