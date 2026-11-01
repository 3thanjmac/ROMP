#!/usr/bin/env bash
# Give a Linux user their own ROMP gateway. Run as root after install.sh:
#   sudo /opt/romp/deploy/add-user.sh <linux-user> <tailscale-login> <gateway-port> <https-port>
# Example (you):        add-user.sh you    you@github    7680 443
# Example (a friend):   add-user.sh alice  alice@github  7681 8443
# Tailscale Serve only offers HTTPS on ports 443, 8443 and 10000.
# A login of "-" sets the person up with no Tailscale login yet (LAN password sign-in only); run the
# script again with their login once they have one, and it is added to their existing gateway config.
set -euo pipefail

ROMP_SRC="${ROMP_SRC:-/opt/romp}"

[[ $EUID -eq 0 ]] || { echo "add-user.sh must run as root" >&2; exit 1; }
[[ $# -eq 4 ]] || { sed -n '2,8p' "$0" >&2; exit 1; }
user="$1" login="$2" port="$3" https_port="$4"
case "$https_port" in 443 | 8443 | 10000) ;; *) echo "https-port must be 443, 8443 or 10000" >&2; exit 1 ;; esac
[[ $login =~ ^[^[:space:]\"\\]+$ ]] || { echo "tailscale-login must not contain spaces, quotes or backslashes" >&2; exit 1; }

step() { printf '\n==> %s\n' "$*"; }
as_user() { sudo -iu "$user" bash -lc "$1"; }
user_systemctl() {
	local uid
	uid="$(id -u "$user")"
	runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user "$@"
}

step "Linux account $user"
id "$user" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$user"
usermod -aG romp "$user"
# A systemd user manager already running (the account was logged in, or set up earlier) keeps the groups it
# started with, and so does every gateway it starts: without romp, adding a repo fails writing to /srv/romp/hub.
uid="$(id -u "$user")"
romp_gid="$(getent group romp | cut -d: -f3)"
manager_pid="$(systemctl show -p MainPID --value "user@$uid.service" 2>/dev/null || echo 0)"
if [[ "$manager_pid" != 0 ]] && ! grep '^Groups:' "/proc/$manager_pid/status" | grep -qw "$romp_gid"; then
	echo "restarting $user's systemd user manager so its services join the romp group"
	systemctl restart "user@$uid.service"
fi
loginctl enable-linger "$user"
home="$(getent passwd "$user" | cut -d: -f6)"
# Lingering starts the user's systemd manager asynchronously; wait for its bus.
for _ in $(seq 1 50); do
	[[ -S "/run/user/$(id -u "$user")/bus" ]] && break
	sleep 0.2
done

step "OMP for $user"
as_user 'command -v omp >/dev/null || [ -x ~/.bun/bin/omp ] || curl -fsSL https://omp.sh/install | sh'

step "ROMP OMP extension"
as_user "mkdir -p ~/.omp/agent/extensions && ln -sfn '$ROMP_SRC/packages/core/omp-extension/romp.ts' ~/.omp/agent/extensions/romp.ts"

step "Shared OMP settings"
as_user 'romp omp-defaults sync'

step "Gateway config"
config="$home/.config/romp/gateway.toml"
if [[ "$login" == - ]]; then logins=""; else logins="\"$login\""; fi
if [[ ! -f "$config" ]]; then
	install -d -o "$user" -g "$user" "$home/.config/romp"
	cat >"$config" <<EOF
listen = "127.0.0.1:$port"
allow_logins = [$logins]
roots = ["~"]
shell = "/bin/bash"
omp = "$home/.bun/bin/omp"
web_dir = "$ROMP_SRC/packages/web/dist"
EOF
	chown "$user:$user" "$config"
else
	echo "keeping existing $config"
	current="$(grep -E '^allow_logins[[:space:]]*=' "$config" || true)"
	if [[ "$login" == - || "${current,,}" == *"\"${login,,}\""* ]]; then
		:
	elif [[ $current =~ ^allow_logins[[:space:]]*=[[:space:]]*\[[[:space:]]*(.*[^[:space:],])?[[:space:],]*\][[:space:]]*$ ]]; then
		listed="${BASH_REMATCH[1]}"
		awk -v line="allow_logins = [${listed:+$listed, }$logins]" '/^allow_logins[[:space:]]*=/ { $0 = line } 1' "$config" >"$config.new"
		chown "$user:$user" "$config.new"
		mv "$config.new" "$config"
		echo "added $login to allow_logins"
	else
		echo "could not add $login to allow_logins in $config; add it by hand" >&2
	fi
fi

step "Gateway service"
install -d -o "$user" -g "$user" "$home/.config/systemd/user"
install -o "$user" -g "$user" -m 0644 "$ROMP_SRC/deploy/systemd/romp-gateway.service" "$home/.config/systemd/user/romp-gateway.service"
user_systemctl daemon-reload
user_systemctl enable romp-gateway.service
user_systemctl restart romp-gateway.service

step "Tailscale Serve"
if command -v tailscale >/dev/null; then
	tailscale serve --bg --https="$https_port" "http://127.0.0.1:$port"
	tailscale serve status
else
	echo "tailscale not installed in this VM; after installing it run:"
	echo "  tailscale serve --bg --https=$https_port http://127.0.0.1:$port"
fi

if [[ -f /etc/romp/lan.env ]]; then
	step "LAN access"
	romp-lan sync
fi

cat <<EOF

$user is set up. Remaining manual steps:
  1. Pick AI providers and models: the first ROMP terminal $user opens offers OMP's setup wizard
     (or now: sudo -iu $user omp setup). Model choices are never shared between users.
  2. Set a git identity for commits:    sudo -iu $user git config --global user.name "Name"
                                        sudo -iu $user git config --global user.email "you@example.com"
EOF
if [[ -f /etc/romp/lan.env ]]; then
	echo "  3. Set the password for signing in on the LAN: sudo -iu $user romp-gateway passwd"
fi
if [[ "$login" == - ]]; then
	echo "No Tailscale login is allowed yet. Once $user has one, run: $0 $user <tailscale-login> $port $https_port"
	[[ -f /etc/romp/lan.env ]] || echo "LAN access is off (sudo romp-lan enable), so nobody can open this gateway until then."
fi
