/**
 * Opening links outside ROMP. An iOS home-screen app shows other origins in an in-app browser sheet, where the
 * clipboard does not work. The `x-safari-` URL scheme (iOS 17+) hands the link to Safari instead.
 * Same-origin links stay in the sheet: on iOS, Safari keeps separate cookies and lacks the app's LAN session.
 */

/** `navigator.standalone` exists only on iOS/iPadOS Safari and is true when launched from the home screen. */
const IOS_STANDALONE = (navigator as Navigator & { standalone?: boolean }).standalone === true;

function safariUrl(url: URL): string | null {
	if (!IOS_STANDALONE || url.origin === location.origin) return null;
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	return `x-safari-${url.href}`;
}

/** Opens `href` (absolute or relative to the app) in a new browser tab, or in Safari from an iOS home-screen app. */
export function openExternal(href: string): void {
	const url = new URL(href, location.href);
	const safari = safariUrl(url);
	if (safari) location.href = safari;
	else window.open(url.href, "_blank", "noopener,noreferrer");
}

/** Routes clicks on cross-origin `<a>` links to Safari in an iOS home-screen app; a no-op elsewhere. */
export function initExternalLinks(): void {
	if (!IOS_STANDALONE) return;
	document.addEventListener("click", (e) => {
		if (e.defaultPrevented || !(e.target instanceof Element)) return;
		const a = e.target.closest("a[href]");
		if (!(a instanceof HTMLAnchorElement)) return;
		const safari = safariUrl(new URL(a.href));
		if (!safari) return;
		e.preventDefault();
		location.href = safari;
	});
}
