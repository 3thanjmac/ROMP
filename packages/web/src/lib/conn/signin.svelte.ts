/**
 * Set when the gateway answers 401 `login_required`: the page was opened over the LAN (not Tailscale) and has no
 * session yet, or the session ended. The app then shows the sign-in screen instead of the workspace.
 */
class SignIn {
	required = $state(false);
}

export const signIn = new SignIn();
