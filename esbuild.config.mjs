import { builtinModules } from "node:module";
import esbuild from "esbuild";

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
});
if (watch) await context.watch();
else {
	await context.rebuild();
	await context.dispose();
}
