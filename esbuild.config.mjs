import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import esbuild from "esbuild";

// Obsidian installs only main.js, manifest.json, and styles.css, so main.js carries the bundled
// provider scripts and writes them next to itself on load.
const providerScripts = Object.fromEntries(
	readdirSync("providers")
		.filter((name) => name.endsWith(".mjs"))
		.map((name) => [name, readFileSync(`providers/${name}`, "utf8")]),
);

const watch = process.argv.includes("--watch");
const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	// Obsidian supplies these at runtime; bundling a second copy of CodeMirror breaks editor extensions.
	external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
	format: "cjs",
	platform: "node",
	target: "es2022",
	logLevel: "info",
	sourcemap: watch ? "inline" : false,
	outfile: "main.js",
	define: { PROVIDER_SCRIPTS: JSON.stringify(providerScripts) },
});
if (watch) await context.watch();
else {
	await context.rebuild();
	await context.dispose();
}
