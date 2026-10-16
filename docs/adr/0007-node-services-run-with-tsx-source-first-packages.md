# 0007. Node services and scripts run from TypeScript source with tsx; workspace packages have no build step

Status: accepted
Decided-by: answerer (researched)
Question: Phase 1 constitution, Q7. How should the Node services (gate, resolve-agent, scripts such as seed and bench) run in dev and on Render: tsx, Node native type stripping, or a tsc build? Workspace packages import each other's TS sources.
Decision:
- Pin `tsx` 4.23.15. Every Node entry point runs from source with tsx: the gate, resolve-agent, seed, bench and db migrate. Dev uses `tsx watch src/server.ts`. On Render the start command is `tsx src/server.ts`.
- Nothing is compiled. Workspace packages export their source (`"exports": { ".": "./src/index.ts" }`). Next apps consume them through `transpilePackages`.
- Type checking is a separate step, `tsc --noEmit`.
Basis:
- Node's type stripping is stable in Node 26, with limits: only erasable syntax, mandatory file extensions in imports, tsconfig `paths` ignored, and Node "refuses to handle TypeScript files inside folders under a `node_modules` path": https://nodejs.org/api/typescript.html. Each of those limits is an edge an unattended loop can trip on.
- A tsc build would need project references plus `dist` outputs and a build order for every package.
- `tsx` 4.23.15 has engines `>=18.0.0` and uses esbuild ~0.28 (npm registry).
Consequences:
- Put `tsx` in `dependencies`, not `devDependencies`, in each service workspace, so a production install still has it.
- The shared base tsconfig sets `"module": "preserve"`, `"moduleResolution": "bundler"`, `"noEmit": true`, `"strict": true`, `"isolatedModules": true`, `"verbatimModuleSyntax": true` and `"erasableSyntaxOnly": true`. That bans enums and parameter properties, which keeps native type stripping available later.
- No tsconfig `paths`: import workspace packages by name. This also avoids a Next.js 16 type-check bug with `paths` in a shared base tsconfig.
- Every `package.json` has `"type": "module"`.
- Vitest runs TypeScript directly and needs nothing extra.
