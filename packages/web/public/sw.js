// ROMP service worker: shows agent push notifications (payload: @romp/protocol PushMessage) and routes a tap back
// to the app. It has no fetch handler on purpose: the app always loads from the gateway, so deploys apply on reload.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
	let message = {};
	try {
		message = event.data ? event.data.json() : {};
	} catch {
		// Show the generic notification below: iOS revokes subscriptions whose pushes show nothing.
	}
	const tag = typeof message.tag === "string" && message.tag ? message.tag : undefined;
	event.waitUntil(
		self.registration.showNotification(typeof message.title === "string" && message.title ? message.title : "ROMP", {
			body: typeof message.body === "string" ? message.body : "An agent needs your attention.",
			tag,
			// A newer notice for the same agent replaces the old one but still alerts.
			renotify: tag !== undefined,
			icon: "/icon-192.png",
			data: { agentId: message.agentId ?? null, cwd: message.cwd ?? null },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const { agentId, cwd } = event.notification.data ?? {};
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			const client = windows.find((c) => new URL(c.url).origin === self.location.origin);
			if (client) {
				if (agentId) client.postMessage({ type: "open-agent", agentId, cwd });
				try {
					await client.focus();
				} catch {
					// Focus is refused when the browser no longer counts this as a user action; the message still landed.
				}
				return;
			}
			const query = agentId ? `?${new URLSearchParams({ agent: agentId, cwd: cwd ?? "" })}` : "";
			await self.clients.openWindow(`/${query}`);
		})(),
	);
});
