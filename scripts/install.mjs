// Copies the built plugin into a vault: node scripts/install.mjs <vault-path>
// Leaves data.json alone, so saved settings survive reinstalls.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const vault = process.argv[2] ?? process.env.LINK_LENS_VAULT;
if (!vault) throw new Error("Usage: node scripts/install.mjs <vault-path> (or set LINK_LENS_VAULT)");
if (!existsSync(join(vault, ".obsidian"))) throw new Error(`${vault} has no .obsidian folder.`);
const target = join(vault, ".obsidian", "plugins", "link-lens");
mkdirSync(join(target, "providers"), { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) cpSync(file, join(target, file));
cpSync("providers", join(target, "providers"), { recursive: true });
console.log(`Installed Link Lens to ${resolve(target)}`);
