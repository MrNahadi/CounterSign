import { serve } from "./serve";

// Resolve's agent service. Protected mode reaches money only through the gate; baseline mode
// talks to PayPal's own MCP server. Everything comes from the environment (see serve.ts).
await serve(process.env);
