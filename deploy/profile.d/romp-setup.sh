# ROMP: the first time someone opens an interactive login shell (a ROMP terminal, ssh) before picking
# AI models, offer OMP's setup wizard: provider sign-in (Anthropic, OpenRouter, ...) and model roles.
# Model choices are personal; shared OMP settings never include them. Installed to /etc/profile.d.
romp_setup_prompt() {
	case $- in *i*) ;; *) return ;; esac
	[ -t 0 ] && [ -t 1 ] || return
	romp_marker="$HOME/.config/romp/omp-setup.done"
	[ -e "$romp_marker" ] && return
	romp_omp=$(command -v omp 2>/dev/null) || romp_omp="$HOME/.bun/bin/omp"
	[ -x "$romp_omp" ] || return
	mkdir -p "$HOME/.config/romp"
	if grep -q '^modelRoles:' "$HOME/.omp/agent/config.yml" 2>/dev/null; then
		: >"$romp_marker"
		return
	fi
	printf 'ROMP: choose your AI providers and models now? [Y/n] '
	read -r romp_answer || romp_answer=n
	: >"$romp_marker"
	case $romp_answer in
	[Nn]*) echo "Run 'omp setup' whenever you are ready." ;;
	*) "$romp_omp" setup ;;
	esac
}
romp_setup_prompt
unset -f romp_setup_prompt
unset romp_marker romp_omp romp_answer
