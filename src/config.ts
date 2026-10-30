import { isRecord } from "./preview";

export interface ProviderConfig {
	id: string;
	name: string;
	enabled: boolean;
	/** Regular expression matched against the whole link URL. Named groups become placeholders. */
	pattern: string;
	/** Program and arguments, run without a shell. Supports {url}, {pluginDir}, {vaultDir}, and named groups. */
	command: string[];
	timeoutSeconds: number;
}

export interface LinkLensSettings {
	providers: ProviderConfig[];
	/** Prepended to PATH, because apps opened from the Dock don't get the shell's PATH. */
	extraPath: string;
	cacheMinutes: number;
	showBadges: boolean;
	hoverDelayMs: number;
}

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
	{
		id: "jira",
		name: "Jira (acli)",
		enabled: true,
		pattern: "^https://(?<site>[^/]+\\.atlassian\\.net)/browse/(?<key>[A-Z][A-Z0-9]*-\\d+)$",
		command: ["node", "{pluginDir}/providers/jira-acli.mjs", "{site}", "{key}"],
		timeoutSeconds: 20,
	},
	{
		id: "github",
		name: "GitHub pull requests and issues (gh)",
		enabled: true,
		pattern: "^https://github\\.com/(?<owner>[^/]+)/(?<repo>[^/]+)/(?<kind>pull|issues)/(?<number>\\d+)(?:[/?#].*)?$",
		// Add "--account", "OWNER=LOGIN" pairs or "--default-account", "LOGIN" to choose a gh login per owner.
		command: ["node", "{pluginDir}/providers/github-gh.mjs", "{owner}", "{repo}", "{kind}", "{number}"],
		timeoutSeconds: 20,
	},
];

export const DEFAULT_SETTINGS: LinkLensSettings = {
	providers: DEFAULT_PROVIDERS,
	extraPath: "/opt/homebrew/bin:/usr/local/bin",
	cacheMinutes: 15,
	showBadges: true,
	hoverDelayMs: 300,
};

/** Validates a provider list from settings JSON. Throws an Error that names the bad provider. */
export function parseProviders(raw: unknown): ProviderConfig[] {
	if (!Array.isArray(raw)) throw new Error("Providers must be a JSON array.");
	const ids = new Set<string>();
	return raw.map((value, index) => {
		const where = `Provider ${index + 1}`;
		if (!isRecord(value)) throw new Error(`${where} must be an object.`);
		const { id, name, enabled, pattern, command, timeoutSeconds } = value;
		if (typeof id !== "string" || !id.trim()) throw new Error(`${where} needs an "id".`);
		if (ids.has(id)) throw new Error(`${where} reuses the id "${id}".`);
		ids.add(id);
		if (typeof pattern !== "string" || !pattern) throw new Error(`${where} needs a "pattern".`);
		try {
			new RegExp(pattern);
		} catch (error) {
			throw new Error(`${where} has an invalid pattern: ${(error as Error).message}`);
		}
		if (!Array.isArray(command) || command.length === 0 || !command.every((arg) => typeof arg === "string")) {
			throw new Error(`${where} needs a "command" array of strings.`);
		}
		if (timeoutSeconds !== undefined && (typeof timeoutSeconds !== "number" || !(timeoutSeconds > 0))) {
			throw new Error(`${where} has a non-positive "timeoutSeconds".`);
		}
		return {
			id,
			name: typeof name === "string" && name.trim() ? name : id,
			enabled: enabled !== false,
			pattern,
			command: [...command],
			timeoutSeconds: timeoutSeconds ?? 20,
		};
	});
}

/** Builds settings from saved data, falling back to defaults for anything missing or invalid. */
export function parseSettings(raw: unknown): LinkLensSettings {
	const data = isRecord(raw) ? raw : {};
	let providers = DEFAULT_SETTINGS.providers;
	if (data.providers !== undefined) {
		try {
			providers = parseProviders(data.providers);
		} catch (error) {
			console.warn("Link Lens: ignoring saved providers", error);
		}
	}
	return {
		providers,
		extraPath: typeof data.extraPath === "string" ? data.extraPath : DEFAULT_SETTINGS.extraPath,
		cacheMinutes: positiveNumber(data.cacheMinutes, DEFAULT_SETTINGS.cacheMinutes),
		showBadges: typeof data.showBadges === "boolean" ? data.showBadges : DEFAULT_SETTINGS.showBadges,
		hoverDelayMs: nonNegativeNumber(data.hoverDelayMs, DEFAULT_SETTINGS.hoverDelayMs),
	};
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && value > 0 ? value : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && value >= 0 ? value : fallback;
}
