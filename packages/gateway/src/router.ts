export type Params = Record<string, string>;
export type Handler<C> = (ctx: C, params: Params) => Response | Promise<Response>;

interface Route<C> {
	method: string;
	segments: string[];
	handler: Handler<C>;
}

export type RouteMatch<C> = { handler: Handler<C>; params: Params } | { allowed: string[] } | null;

/** Exact-segment router; `:name` segments capture one URL-decoded path segment. */
export class Router<C> {
	private readonly routes: Route<C>[] = [];

	on(method: string, pattern: string, handler: Handler<C>): this {
		this.routes.push({ method, segments: pattern.split("/").slice(1), handler });
		return this;
	}

	match(method: string, pathname: string): RouteMatch<C> {
		const parts = pathname.split("/").slice(1);
		const allowed: string[] = [];
		for (const route of this.routes) {
			const params = matchSegments(route.segments, parts);
			if (!params) continue;
			if (route.method === method) return { handler: route.handler, params };
			allowed.push(route.method);
		}
		return allowed.length > 0 ? { allowed } : null;
	}
}

function matchSegments(pattern: string[], parts: string[]): Params | null {
	if (pattern.length !== parts.length) return null;
	const params: Params = {};
	for (let i = 0; i < pattern.length; i++) {
		const expected = pattern[i] ?? "";
		const actual = parts[i] ?? "";
		if (!expected.startsWith(":")) {
			if (expected !== actual) return null;
			continue;
		}
		if (actual === "") return null;
		try {
			params[expected.slice(1)] = decodeURIComponent(actual);
		} catch {
			return null;
		}
	}
	return params;
}
