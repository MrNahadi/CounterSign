import { createServer } from "node:http";

// Resolve's agent harness. Protected mode reaches money only through the gate; baseline mode
// talks to PayPal's own MCP server. Until phase 8 this only answers a health check.
const port = Number(process.env.PORT ?? 8788);

createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404).end();
}).listen(port, "0.0.0.0", () => {
  console.log(`resolve-agent listening on port ${port}`);
});
