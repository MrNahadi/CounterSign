import express from "express";

// The gate's HTTP surface. Later phases add /mcp, the approval API, PayPal webhooks and Daraja callbacks.
export function createApp() {
  const app = express();
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}
