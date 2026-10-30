import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, parseProviders, parseSettings } from "../src/config";

const valid = { id: "x", pattern: "^https://x/(?<n>\\d+)$", command: ["echo", "{n}"] };

describe("parseProviders", () => {
	it("fills optional fields", () => {
		expect(parseProviders([valid])).toEqual([{ ...valid, name: "x", enabled: true, timeoutSeconds: 20 }]);
	});

	it.each([
		[{}, "JSON array"],
		[[1], "Provider 1 must be an object"],
		[[{ ...valid, id: "" }], "needs an \"id\""],
		[[valid, valid], "reuses the id"],
		[[{ ...valid, pattern: "(" }], "invalid pattern"],
		[[{ ...valid, command: [] }], "\"command\" array"],
		[[{ ...valid, command: ["a", 1] }], "\"command\" array"],
		[[{ ...valid, timeoutSeconds: 0 }], "timeoutSeconds"],
	])("rejects %j", (raw, message) => {
		expect(() => parseProviders(raw)).toThrow(message);
	});

	it("accepts the default providers", () => {
		expect(parseProviders(DEFAULT_SETTINGS.providers)).toEqual(DEFAULT_SETTINGS.providers);
	});
});

describe("parseSettings", () => {
	it("uses defaults for missing or invalid values", () => {
		expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
		expect(parseSettings({ providers: "nope", cacheMinutes: -1, showBadges: "yes", hoverDelayMs: 0 })).toEqual({ ...DEFAULT_SETTINGS, hoverDelayMs: 0 });
	});

	it("keeps saved values", () => {
		const settings = parseSettings({ providers: [valid], extraPath: "/bin", cacheMinutes: 5, showBadges: false, hoverDelayMs: 100 });
		expect(settings).toMatchObject({ extraPath: "/bin", cacheMinutes: 5, showBadges: false, hoverDelayMs: 100 });
		expect(settings.providers.map((p) => p.id)).toEqual(["x"]);
	});
});
