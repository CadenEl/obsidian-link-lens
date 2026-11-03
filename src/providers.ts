import { type ChildProcess, spawn } from "node:child_process";
import { delimiter } from "node:path";
import type { ProviderConfig } from "./config";
import { parsePreview, type Preview } from "./preview";

export interface ProviderMatch {
	provider: ProviderConfig;
	url: string;
	groups: Record<string, string>;
	/** Cache key for the run. Links whose commands fill in identically share it. */
	key: string;
}

export interface RunContext {
	pluginDir: string;
	vaultDir: string;
	extraPath: string;
}

/** Enabled providers in settings order; the first pattern that matches a URL wins. */
export class ProviderSet {
	private readonly compiled: { provider: ProviderConfig; regex: RegExp }[];

	constructor(providers: ProviderConfig[]) {
		this.compiled = providers.filter((p) => p.enabled).map((provider) => ({ provider, regex: new RegExp(provider.pattern) }));
	}

	match(url: string): ProviderMatch | null {
		for (const { provider, regex } of this.compiled) {
			const found = regex.exec(url);
			if (!found) continue;
			const groups: Record<string, string> = {};
			for (const [name, value] of Object.entries(found.groups ?? {})) groups[name] = value ?? "";
			return { provider, url, groups, key: runKey(provider, url, groups) };
		}
		return null;
	}
}

/**
 * Identifies a run by its filled-in command, so links that differ only in parts the command
 * ignores, such as a pull request URL with "/files" or "#issuecomment-1", share one run.
 * The plugin and vault folders are the same for every run, so they're left blank.
 */
function runKey(provider: ProviderConfig, url: string, groups: Record<string, string>): string {
	try {
		return JSON.stringify([provider.id, ...buildArgs(provider.command, { ...groups, url, pluginDir: "", vaultDir: "" })]);
	} catch {
		// An unknown placeholder fails every run of this provider, so the URL is as good a key as any.
		return JSON.stringify([provider.id, url]);
	}
}

/** Fills {placeholder} tokens in each argument. Arguments are passed without a shell, so values need no quoting. */
export function buildArgs(command: string[], values: Record<string, string>): string[] {
	return command.map((arg) =>
		arg.replace(/\{(\w+)\}/g, (_token, name: string) => {
			if (!Object.hasOwn(values, name)) throw new Error(`Unknown placeholder {${name}} in the command.`);
			return values[name];
		}),
	);
}

const MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 2000;

/** `extraArgs` are appended after placeholders are filled, so their text is passed exactly as given. */
export function runProvider(match: ProviderMatch, context: RunContext, extraArgs: string[] = []): Promise<Preview> {
	let args: string[];
	try {
		args = buildArgs(match.provider.command, {
			...match.groups,
			url: match.url,
			pluginDir: context.pluginDir,
			vaultDir: context.vaultDir,
		});
	} catch (error) {
		return Promise.reject(error);
	}
	const [file, ...rest] = [...args, ...extraArgs];
	const path = [context.extraPath, process.env.PATH].filter(Boolean).join(delimiter);
	const timeoutMs = match.provider.timeoutSeconds * 1000;
	return new Promise((resolve, reject) => {
		// A process group of its own lets a timeout stop the CLIs a provider script starts, not just the script.
		const child = spawn(file, rest, {
			cwd: context.vaultDir,
			env: { ...process.env, PATH: path },
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let size = 0;
		let failure: string | null = null;
		let forceKill: ReturnType<typeof setTimeout> | undefined;
		const stop = (reason: string) => {
			if (failure) return;
			failure = reason;
			killTree(child, "SIGTERM");
			forceKill = setTimeout(() => {
				killTree(child, "SIGKILL");
				// A process outside the group (or orphaned on Windows) can hold the pipes open
				// forever, which delays "close". Stop waiting so the cache slot frees.
				child.stdout.destroy();
				child.stderr.destroy();
				reject(new Error(reason));
			}, KILL_GRACE_MS);
		};
		const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_OUTPUT_BYTES) stop("The provider printed more than 1 MB.");
			else chunks.push(chunk);
		};
		child.stdout.on("data", collect(stdout));
		child.stderr.on("data", collect(stderr));
		const timer = setTimeout(() => stop(`Timed out after ${match.provider.timeoutSeconds}s.`), timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			clearTimeout(forceKill);
			reject(new Error(`Could not run ${file}: ${error.message}`));
		});
		// "close" waits for every process holding the output pipes, so the cache's slot frees only once they've all exited.
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			clearTimeout(forceKill);
			// Anything that ignored SIGTERM without holding the pipes is still running; finish it before freeing the slot.
			if (failure) killTree(child, "SIGKILL");
			const err = Buffer.concat(stderr).toString("utf8").trim();
			if (failure) reject(new Error(failure));
			else if (code !== 0) reject(new Error((err || `Exited with ${signal ?? `code ${code}`}.`).slice(0, 500)));
			else {
				try {
					resolve(parsePreview(Buffer.concat(stdout).toString("utf8"), match.url));
				} catch (parseError) {
					reject(parseError);
				}
			}
		});
	});
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) return;
	if (process.platform === "win32") {
		// Windows has no process groups to signal; taskkill /T ends the process and its descendants.
		spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch {
		// The whole group has already exited.
	}
}
