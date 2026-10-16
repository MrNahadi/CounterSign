import { appendFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { loadEnv } from "./env";

// Spike S6 callback receiver. Daraja posts C2B confirmations and async results here through
// the tunnel. Each callback is appended to spikes/out/daraja-callbacks.jsonl (git-ignored).
const env = loadEnv();
const port = Number(process.env.SPIKE_PORT ?? 8790);
const outDir = join(import.meta.dirname, "..", "out");
const outFile = join(outDir, "daraja-callbacks.jsonl");
mkdirSync(outDir, { recursive: true });

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return { unparsed: body };
  }
}

createServer((req, res) => {
  const [, pathSecret, kind] = (req.url ?? "").split("/");
  if (req.method !== "POST" || pathSecret !== env.CALLBACK_PATH_SECRET || !kind) {
    console.log(`${new Date().toISOString()} rejected ${req.method} (wrong path or method)`);
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => {
    body += chunk;
  });
  req.on("end", () => {
    const record = { receivedAt: new Date().toISOString(), kind, body: parse(body) };
    appendFileSync(outFile, `${JSON.stringify(record)}\n`);
    console.log(`${record.receivedAt} ${kind}\n${JSON.stringify(record.body, null, 2)}`);
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ ResultCode: 0, ResultDesc: "Accepted" }));
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`receiver listening on 127.0.0.1:${port}, writing ${outFile}`);
});
