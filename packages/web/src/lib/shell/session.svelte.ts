/** Who is signed in and where the gateway runs (`GET /api/me`). */
import type { Me } from "@romp/protocol";
import { api, errorMessage } from "../api";

class Session {
	me: Me | null = $state(null);
	/** Set when /api/me failed and nothing is loaded yet. */
	error: string | null = $state(null);
}

export const session = new Session();

export async function loadMe(): Promise<void> {
	try {
		session.me = await api.me();
		session.error = null;
	} catch (err) {
		session.error = errorMessage(err);
	}
}
