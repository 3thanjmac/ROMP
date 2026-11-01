import { expect, test } from "bun:test";
import { base64url, encryptPayload, fromBase64url, generateVapidKeys, Vapid } from "../src/webpush.ts";

test("encryption reproduces the RFC 8291 section 5 example byte for byte", async () => {
	const senderPublic = fromBase64url(
		"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
	);
	const privateKey = await crypto.subtle.importKey(
		"jwk",
		{
			kty: "EC",
			crv: "P-256",
			d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
			x: base64url(senderPublic.subarray(1, 33)),
			y: base64url(senderPublic.subarray(33, 65)),
		},
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		["deriveBits"],
	);
	const body = await encryptPayload(
		new TextEncoder().encode("When I grow up, I want to be a watermelon"),
		"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
		"BTBZMqHH6r4Tts7J_aSIgg",
		{ salt: fromBase64url("DGv6ra1nlYgDCS1FRnbzlw"), sender: { privateKey, publicKey: senderPublic } },
	);
	expect(base64url(body)).toBe(
		"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
	);
});

test("the VAPID token is an ES256 JWT for the push service origin that verifies with the advertised key", async () => {
	const keys = await generateVapidKeys();
	const header = await (await Vapid.load(keys)).authorization("https://web.push.apple.com/abc/def", "https://romp.example.ts.net");
	const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
	expect(match).not.toBeNull();
	const [, head = "", body = "", signature = "", k = ""] = match ?? [];
	expect(k).toBe(keys.publicKey);
	const claims = JSON.parse(Buffer.from(body, "base64url").toString());
	expect(claims.aud).toBe("https://web.push.apple.com");
	expect(claims.sub).toBe("https://romp.example.ts.net");
	expect(claims.exp * 1000 - Date.now()).toBeLessThanOrEqual(24 * 3600 * 1000);
	const publicKey = await crypto.subtle.importKey("raw", fromBase64url(k), { name: "ECDSA", namedCurve: "P-256" }, false, [
		"verify",
	]);
	const valid = await crypto.subtle.verify(
		{ name: "ECDSA", hash: "SHA-256" },
		publicKey,
		fromBase64url(signature),
		new TextEncoder().encode(`${head}.${body}`),
	);
	expect(valid).toBe(true);
});
