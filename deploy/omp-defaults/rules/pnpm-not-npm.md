---
name: pnpm-not-npm
description: "Prefer pnpm exec/pnpm dlx over npx/npm unless the repo is locked to another package manager"
condition: ["\\bnpx\\s+[\\w@.-]", "\\bnpm\\s+(run|install|i|exec|ci|test|add|remove|ls)\\b"]
scope: "tool:bash"
---

Use pnpm, not `npx` or `npm`:

- `npx <bin>` → `pnpm exec <bin>`
- `npx <uninstalled-pkg>` → `pnpm dlx <pkg>`
- `npm run <script>` → `pnpm <script>`
- `npm install` / `npm ci` → `pnpm install --frozen-lockfile`
- `npm add|remove` → `pnpm add|remove`

Exception: a repo whose root has `package-lock.json`, `yarn.lock` or `bun.lock`/`bun.lockb` and no `pnpm-lock.yaml` is locked to that package manager. Use it there: installing with pnpm would add a second lockfile the project does not use.

If a repo script (`pnpm lint`, `pnpm check`) is too slow or times out, scope the underlying binary with `pnpm exec` on the changed paths; do not fall back to `npx`.
