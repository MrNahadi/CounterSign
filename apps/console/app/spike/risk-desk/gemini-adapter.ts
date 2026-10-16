import type { AgAiEvent, AgLlmAdapter, AgLlmRequest, AgLlmResponse } from "ag-studio";

// Spike S9: AG Studio's model adapter, running in the browser. It holds no key and calls no model:
// each turn is posted to the console's own route (app/api/risk-desk/turn), which calls Gemini.

type Line = { event?: AgAiEvent; response?: AgLlmResponse; error?: { message: string } };

export function geminiProxyAdapter(endpoint: string): AgLlmAdapter {
  return {
    executeTurn(request: AgLlmRequest, options) {
      let resolve: (response: AgLlmResponse) => void = () => {};
      let reject: (error: Error) => void = () => {};
      const complete = new Promise<AgLlmResponse>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // A failed turn is reported once, through `complete`; mark it observed for consumers that
      // stop reading the stream early.
      void complete.catch(() => {});

      async function* events(): AsyncGenerator<AgAiEvent> {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
            signal: options?.signal,
          });
          if (!res.ok || !res.body) throw new Error(`Risk desk route returned HTTP ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let finished = false;
          while (!finished) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const lines = buffer.split("\n");
            buffer = done ? "" : (lines.pop() ?? "");
            for (const raw of lines) {
              if (!raw.trim()) continue;
              const line = JSON.parse(raw) as Line;
              if (line.event) yield line.event;
              if (line.response) resolve(line.response);
              if (line.error) throw new Error(line.error.message);
            }
            finished = done;
          }
          reject(new Error("The turn ended without a response"));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }

      const stream = events();
      return { stream: { [Symbol.asyncIterator]: () => stream }, complete };
    },
  };
}
