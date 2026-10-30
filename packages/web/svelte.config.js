/** @type {import("@sveltejs/vite-plugin-svelte").SvelteConfig} */
export default {
	vitePlugin: {
		// Runes everywhere in our own code; dependencies keep whatever mode they were written for.
		dynamicCompileOptions({ filename }) {
			if (!filename.includes("node_modules")) return { runes: true };
		},
	},
};
