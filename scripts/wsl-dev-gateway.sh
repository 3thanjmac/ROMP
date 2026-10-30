#!/bin/bash
# Local development on Windows: mirror this checkout into WSL (Debian) and (re)start a dev gateway
# on 127.0.0.1:7681 with authentication disabled. Run from Windows:
#   wsl -d Debian -u ethan -- bash /mnt/c/Users/ethan/Documents/Code/ROMP/scripts/wsl-dev-gateway.sh
# Then run `pnpm dev:web` on Windows (Vite on 5173 proxies to 7681).
# Port 7680 is avoided because Windows Delivery Optimization owns it on the host.
# WSL stops the distro when no wsl.exe process is attached; keep one open (e.g. `wsl -d Debian -- sleep infinity`).
set -euo pipefail
src="$(cd "$(dirname "$0")/.." && pwd)"
dest=/opt/romp-dev
# The Linux pnpm must come first: Windows pnpm leaks in through PATH interop and breaks installs.
export PATH=/usr/local/share/pnpm/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
export XDG_RUNTIME_DIR=/run/user/$(id -u)

mkdir -p "$dest"
rsync -rlt -O --delete --exclude node_modules --exclude dist --exclude .vite --exclude .shots "$src/" "$dest/"
(cd "$dest" && pnpm install --frozen-lockfile >/tmp/romp-dev-install.log 2>&1) || { tail -20 /tmp/romp-dev-install.log; exit 1; }

mkdir -p ~/.config/romp
cat >~/.config/romp/gateway-dev.toml <<EOF
listen = "127.0.0.1:7681"
dev = true
omp = "$HOME/.bun/bin/omp"
EOF

systemctl --user stop romp-gateway-dev 2>/dev/null || true
systemctl --user reset-failed romp-gateway-dev 2>/dev/null || true
systemd-run --user --unit=romp-gateway-dev --collect \
	--working-directory="$dest/packages/gateway" \
	--setenv=PATH="$PATH" \
	bun src/main.ts --config "$HOME/.config/romp/gateway-dev.toml"
sleep 2
curl -fsS http://127.0.0.1:7681/api/me && echo
