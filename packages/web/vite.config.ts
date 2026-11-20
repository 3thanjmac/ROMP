import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";

// The gateway serves /api, /ws, /proxy and /absproxy; in dev, Vite forwards them with the original Host
// header so the gateway's WebSocket Origin check (Origin host == Host) still passes.
// Default 7681: on Windows dev hosts port 7680 belongs to Delivery Optimization (DoSvc).
const gateway = process.env.ROMP_GATEWAY ?? "http://127.0.0.1:7681";

/**
 * The gateway sends root-absolute requests made by a page under /proxy/<port>/ back under that prefix, and frame
 * navigations outside it under the last proxied port (`refererProxyPort`/`cookieProxyPort` in
 * packages/gateway/src/proxy.ts). In dev those requests reach Vite instead, so do the same here; otherwise a framed
 * page that escaped its prefix gets ROMP's own index.html and the browser pane nests ROMP inside itself.
 */
function proxiedPageRedirect(): Plugin {
	return {
		name: "romp-proxied-page-redirect",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				if (req.url?.startsWith("/proxy/") || req.url?.startsWith("/absproxy/")) return next();
				const framed = req.headers["sec-fetch-dest"] === "iframe";
				const port =
					/^https?:\/\/[^/]+\/proxy\/([1-9]\d{0,4})\//.exec(req.headers.referer ?? "")?.[1] ??
					(framed ? /(?:^|;\s*)romp-proxy-port=([1-9]\d{0,4})(?:;|$)/.exec(req.headers.cookie ?? "")?.[1] : undefined);
				if (!port) return next();
				res.writeHead(307, { location: `/proxy/${port}${req.url ?? "/"}`, "cache-control": "no-store" });
				res.end();
			});
		},
	};
}

export default defineConfig({
	plugins: [proxiedPageRedirect(), svelte()],
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			"/api": { target: gateway },
			"/ws": { target: gateway, ws: true },
			"/proxy": { target: gateway, ws: true },
			"/absproxy": { target: gateway, ws: true },
		},
	},
	build: {
		target: "es2023",
		sourcemap: true,
	},
});
