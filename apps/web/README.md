# rfmail web client

SvelteKit 3 client for rfmail, built as a static SPA (`adapter-static`,
`fallback: 'index.html'`) and served by the backend from `apps/web/build`.
Scaffolded with
`npx sv@1.7.0 create --template minimal --types ts --no-install apps/web`.

```sh
npm run build      # writes build/ (the backend serves it)
npm run check      # svelte-check: 0 errors, 0 warnings is the gate
npm run dev        # dev server; /api is proxied to a backend on 127.0.0.1:8080
```

API types come from `@rfmail/shared` (aliased to `packages/shared/src/index.ts`
in `vite.config.ts`), so the client and the server share one definition of the
contract. See the repository root `README.md` for the whole picture.
