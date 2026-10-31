#!/usr/bin/env bash
# ROMP system install for Debian 13. Run as root from the repo checkout at /opt/romp:
#   sudo /opt/romp/deploy/install.sh
# Idempotent: re-run after pulling a new version to rebuild and restart services.
set -euo pipefail

ROMP_SRC="${ROMP_SRC:-/opt/romp}"
ROMP_ROOT="${ROMP_ROOT:-/srv/romp}"
MERGIRAF_VERSION="${MERGIRAF_VERSION:-0.20.0}"

[[ $EUID -eq 0 ]] || { echo "install.sh must run as root" >&2; exit 1; }
[[ -f "$ROMP_SRC/pnpm-workspace.yaml" ]] || { echo "ROMP checkout not found at $ROMP_SRC (set ROMP_SRC)" >&2; exit 1; }

step() { printf '\n==> %s\n' "$*"; }

step "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl unzip ca-certificates rsync nodejs gnupg sudo >/dev/null

step "GitHub CLI (pr landing mode)"
if ! command -v gh >/dev/null; then
	install -d -m 0755 /etc/apt/keyrings
	curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
	chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		>/etc/apt/sources.list.d/github-cli.list
	apt-get update -qq
	apt-get install -y -qq gh >/dev/null
fi

step "Bun (system-wide in /usr/local)"
if ! command -v bun >/dev/null; then
	curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash >/dev/null
fi
bun --version

step "pnpm"
if ! command -v pnpm >/dev/null; then
	# The installer ends with `pnpm setup`, which refuses to run when SUDO_USER is set.
	curl -fsSL https://get.pnpm.io/install.sh | env -u SUDO_USER PNPM_HOME=/usr/local/share/pnpm SHELL=/bin/bash sh - >/dev/null
	ln -sf /usr/local/share/pnpm/bin/pnpm /usr/local/bin/pnpm
fi
pnpm --version

step "tsgo (TypeScript language server in the shared OMP settings)"
if ! command -v tsgo >/dev/null; then
	BUN_INSTALL=/usr/local bun add --global @typescript/native-preview >/dev/null
fi
tsgo --version

step "mergiraf $MERGIRAF_VERSION"
if ! mergiraf --version 2>/dev/null | grep -q "$MERGIRAF_VERSION"; then
	case "$(uname -m)" in
		x86_64) arch=x86_64 ;;
		aarch64) arch=aarch64 ;;
		*) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
	esac
	curl -fsSL "https://codeberg.org/mergiraf/mergiraf/releases/download/v${MERGIRAF_VERSION}/mergiraf_${arch}-unknown-linux-gnu.tar.gz" \
		| tar -xz -C /usr/local/bin mergiraf
fi
mergiraf --version

step "romp group and service user"
groupadd -f romp
id romp >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/romp --shell /bin/bash --gid romp romp

step "OMP for the merge queue's conflict-resolver agent"
sudo -iu romp bash -lc 'command -v omp >/dev/null || [ -x ~/.bun/bin/omp ] || curl -fsSL https://omp.sh/install | sh'

step "Build ROMP"
chgrp -R romp "$ROMP_SRC"
chmod -R g+rX "$ROMP_SRC"
(cd "$ROMP_SRC" && pnpm install --frozen-lockfile && pnpm build)

step "Commands on PATH"
install -m 0755 "$ROMP_SRC/deploy/bin/romp" /usr/local/bin/romp
install -m 0755 "$ROMP_SRC/deploy/bin/romp-gateway" /usr/local/bin/romp-gateway
install -m 0644 "$ROMP_SRC/deploy/profile.d/romp-setup.sh" /etc/profile.d/romp-setup.sh

step "ROMP root at $ROMP_ROOT"
ROMP_ROOT="$ROMP_ROOT" romp init

step "Merge queue service"
install -m 0644 "$ROMP_SRC/deploy/systemd/romp-queue.service" /etc/systemd/system/romp-queue.service
systemctl daemon-reload
systemctl enable --now romp-queue.service
systemctl restart romp-queue.service

step "Shared OMP settings ($ROMP_SRC/deploy/omp-defaults)"
# The queue's service user plus every ROMP user; each can opt out with `romp omp-defaults off`.
for member in romp $(getent group romp | cut -d: -f4 | tr ',' ' '); do
	echo "$member:"
	sudo -iu "$member" romp omp-defaults sync | sed 's/^/  /' || echo "  sync failed for $member" >&2
done

step "Restart running gateways"
for unit_user in $(loginctl list-users --no-legend | awk '{print $2}'); do
	home="$(getent passwd "$unit_user" | cut -d: -f6)"
	if [[ -f "$home/.config/systemd/user/romp-gateway.service" ]]; then
		runuser -u "$unit_user" -- env XDG_RUNTIME_DIR="/run/user/$(id -u "$unit_user")" \
			systemctl --user restart romp-gateway.service || true
	fi
done

cat <<EOF

ROMP installed.
Next, for each person who will use it:
  sudo $ROMP_SRC/deploy/add-user.sh <linux-user> <tailscale-login> <gateway-port> <https-port>
The merge queue runs as the romp user. Give it credentials once:
  sudo -iu romp gh auth login        # GitHub pushes/PRs (or an SSH deploy key in /var/lib/romp/.ssh)
  sudo -iu romp omp setup            # sign in to a provider and pick models, so the queue can resolve conflicts with an agent
EOF
