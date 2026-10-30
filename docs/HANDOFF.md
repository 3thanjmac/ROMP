# ROMP status

Milestone 1 is built and verified locally in WSL (Debian 13). Next step: deploy to the TrueNAS VM following `docs/deploy.md`.

## Verified
- `pnpm check` (tsc for protocol/core/gateway, svelte-check for web): 0 errors. `pnpm test`: core 16, gateway 45, web 42, all passing. `pnpm build` succeeds.
- `deploy/install.sh` and `deploy/add-user.sh` run cleanly on Debian 13 (WSL): queue service active, per-user gateway as a systemd user unit, Tailscale-login allowlist (allowed login 200, unknown 403), SPA served, repos API backed by `/srv/romp`.
- Gateway smoke (real WebSocket client): terminals with replay, files API incl. 409 conflict and trash/restore, `/proxy` and `/absproxy` incl. WebSocket, layout state, live omp agent turn, agent resume after gateway restart, auth on/off.
- Git automation: two real Linux users each created and shipped a task; `romp queue run-once` as `romp` landed both upstream. mergiraf merges, true conflict flow, failing tests, hub-only repos, crash recovery covered by tests. Live omp: `git commit` blocked by the extension, checkpoint after each run, `/ship`, generated commit message.
- Web UI in the browser against the live gateway at 390x844, 820x1180, 1280x800, dark and light: terminal, files/editor, browser pane, tasks create/ship, scroll/tile toggle, shortcuts, layout persistence, agent pane (streaming, bash tool card, stop, queued follow-up, reload restores transcript, 2-client count). Screenshots in `.shots/` (gitignored).

## Not yet verified
- `pr` landing mode (needs `gh` auth and a GitHub repo with auto-merge).
- Queue conflict resolver via `omp -p`, conflict-message injection into a live agent, auto re-ship after failure (logic and unit coverage only).
- After a PR is squash-merged on GitHub, continuing the same task can conflict with its own landed change (push mode handles this).
- On-screen phone keyboard vs terminal extra-keys row (needs a real phone).
- Overview swipe-to-close and drag-to-reorder gestures.
- Stop now sends `abort_and_restore_queue` (returns queued messages to the composer); only plain `abort` was exercised live.
- Web bundle is one 1.1 MB chunk (CodeMirror languages); code-splitting is a later optimization.

## Local development on Windows
- Gateway: `wsl -d Debian -u ethan -- bash /mnt/c/Users/ethan/Documents/Code/ROMP/scripts/wsl-dev-gateway.sh` (syncs to `/opt/romp-dev`, runs on 127.0.0.1:7681, auth off). Keep a `wsl -d Debian -- sleep infinity` open, or WSL stops the distro.
- Web: `pnpm dev:web` (Vite on 5173, proxies to 7681; set `ROMP_GATEWAY` to override).
- In WSL shells, put `/usr/local/share/pnpm/bin` first on PATH; the Windows pnpm leaks in via interop.
- WSL test state: `/opt/romp` is an installed copy (install.sh), `/srv/romp` has repo `demo` (upstream `/srv/upstream/demo.git`), user `alice` has a gateway on 7682. omp is logged in for `ethan` only.

## Key facts for deploy
- `romp` must be on PATH for every user (hub hooks call it); `install.sh` puts wrappers in `/usr/local/bin`.
- Gateway listens on loopback only and trusts Tailscale identity headers only from sockets owned by root (tailscaled) or itself.
- The `romp` user needs `gh auth login` (or an SSH key) to push, and an omp login for the conflict resolver.
- Agent working directories must be inside the gateway user's roots (home by default).
