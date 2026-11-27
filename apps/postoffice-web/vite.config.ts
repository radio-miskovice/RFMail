import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const sharedSource = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));

export default defineConfig({
	resolve: {
		// One definition of the API's types: the server's module, imported by the browser.
		alias: { '@rfmail/shared': sharedSource }
	},
	server: {
		// `npm run dev` here talks to a post office started separately.
		proxy: { '/api': { target: 'http://127.0.0.1:8090', changeOrigin: false } }
	},
	plugins: [
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({ fallback: 'index.html' })
		})
	]
});
