import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const sharedSource = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));

export default defineConfig({
	resolve: {
		// The API contract lives with the server; the browser imports it through
		// this alias so there is exactly one definition of the types.
		alias: { '@rfmail/shared': sharedSource }
	},
	server: {
		// `npm run dev` in apps/web talks to a backend started separately.
		proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false } }
	},
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({ fallback: 'index.html' })
		})
	]
});
