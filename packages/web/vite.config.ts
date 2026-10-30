import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// The gateway serves /api, /ws, /proxy and /absproxy; in dev, Vite forwards them with the original Host
// header so the gateway's WebSocket Origin check (Origin host == Host) still passes.
// Default 7681: on Windows dev hosts port 7680 belongs to Delivery Optimization (DoSvc).
const gateway = process.env.ROMP_GATEWAY ?? "http://127.0.0.1:7681";

export default defineConfig({
	plugins: [svelte()],
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
