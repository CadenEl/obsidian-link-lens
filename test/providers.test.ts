import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDERS, type ProviderConfig } from "../src/config";
import { buildArgs, ProviderSet, runProvider, writeProviderScripts } from "../src/providers";

const provider = (overrides: Partial<ProviderConfig>): ProviderConfig => ({
	id: "p",
	name: "P",
	enabled: true,
	pattern: "^https://example\\.com/(?<id>\\d+)$",
	command: ["node", "-e", "process.stdout.write(JSON.stringify({title: process.argv[1]}))", "{id}"],
	timeoutSeconds: 5,
	...overrides,
});
const context = { pluginDir: "/plugin", vaultDir: process.cwd(), extraPath: "" };

describe("ProviderSet", () => {
	it("returns the first enabled match with its named groups", () => {
		const set = new ProviderSet([provider({ id: "off", enabled: false }), provider({ id: "a" }), provider({ id: "b" })]);
		const match = set.match("https://example.com/42");
		expect(match?.provider.id).toBe("a");
		expect(match?.groups).toEqual({ id: "42" });
		expect(set.match("https://example.com/x")).toBeNull();
	});

	it("routes default providers", () => {
		const set = new ProviderSet(DEFAULT_PROVIDERS);
		expect(set.match("https://example.atlassian.net/browse/PROJ-123")).toMatchObject({ provider: { id: "jira" }, groups: { site: "example.atlassian.net", key: "PROJ-123" } });
		expect(set.match("https://github.com/example-org/widgets/pull/42")).toMatchObject({
			provider: { id: "github" },
			groups: { owner: "example-org", repo: "widgets", kind: "pull", number: "42" },
		});
		expect(set.match("https://github.com/o/r/pull/7/files#diff")?.groups.number).toBe("7");
		expect(set.match("https://github.com/o/r/blob/main/x.ts")).toBeNull();
		expect(set.match("https://example.atlassian.net/wiki/spaces/DOCS/pages/1")).toBeNull();
	});

	it("gives links with identical commands one key", () => {
		const set = new ProviderSet(DEFAULT_PROVIDERS);
		const key = (url: string) => set.match(url)?.key;
		const pr = key("https://github.com/o/r/pull/42");
		expect(key("https://github.com/o/r/pull/42/files")).toBe(pr);
		expect(key("https://github.com/o/r/pull/42#issuecomment-1")).toBe(pr);
		expect(key("https://github.com/o/r/pull/43")).not.toBe(pr);
		expect(key("https://github.com/o/r/issues/42")).not.toBe(pr);
	});

	it("keeps URL variants apart when the command uses {url}", () => {
		const set = new ProviderSet([provider({ pattern: "^https://example\\.com/(?<id>\\d+)", command: ["echo", "{url}"] })]);
		expect(set.match("https://example.com/1#a")?.key).not.toBe(set.match("https://example.com/1#b")?.key);
	});
});

describe("buildArgs", () => {
	it("fills placeholders inside arguments without quoting", () => {
		expect(buildArgs(["{a}", "--x={b}", "{a}{b}"], { a: "it's", b: "$(rm)" })).toEqual(["it's", "--x=$(rm)", "it's$(rm)"]);
	});

	it("rejects unknown placeholders", () => {
		expect(() => buildArgs(["{missing}"], {})).toThrow("{missing}");
	});
});

describe("runProvider", () => {
	const run = (overrides: Partial<ProviderConfig>, url = "https://example.com/7") => {
		const match = new ProviderSet([provider(overrides)]).match(url);
		if (!match) throw new Error("no match");
		return runProvider(match, context);
	};

	it("parses JSON from stdout", async () => {
		await expect(run({})).resolves.toMatchObject({ title: "7" });
	});

	it("passes url, pluginDir, and vaultDir", async () => {
		const command = ["node", "-e", "process.stdout.write(process.argv.slice(1).join('|'))", "{url}", "{pluginDir}", "{vaultDir}"];
		await expect(run({ command })).resolves.toMatchObject({ body: `https://example.com/7|/plugin|${process.cwd()}` });
	});

	it("appends extra arguments without filling placeholders in them", async () => {
		const match = new ProviderSet([provider({ command: ["node", "-e", "process.stdout.write(process.argv.slice(1).join('|'))", "{id}"] })]).match("https://example.com/5");
		if (!match) throw new Error("no match");
		await expect(runProvider(match, context, ["--action", "{id} $(x)"])).resolves.toMatchObject({ body: "5|--action|{id} $(x)" });
	});

	it("reports stderr when the command fails", async () => {
		await expect(run({ command: ["node", "-e", "console.error('not logged in'); process.exit(3)"] })).rejects.toThrow("not logged in");
	});

	it("reports a missing program", async () => {
		await expect(run({ command: ["definitely-not-a-program-xyz"] })).rejects.toThrow(/Could not run definitely-not-a-program-xyz: .*ENOENT/);
	});

	it("times out slow commands and stops the programs they started", async () => {
		const pidFile = join(mkdtempSync(join(tmpdir(), "link-lens-")), "pid");
		const script = `const c = require("node:child_process").spawn("sleep", ["30"], { stdio: "inherit" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
		await expect(run({ command: ["node", "-e", script], timeoutSeconds: 0.5 })).rejects.toThrow("Timed out");
		const pid = Number(readFileSync(pidFile, "utf8"));
		expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
	});

	it("kills descendants that ignore SIGTERM and let go of the output pipes", async () => {
		const pidFile = join(mkdtempSync(join(tmpdir(), "link-lens-")), "pid");
		const stubborn = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
		const script = `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(stubborn)}], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
		await expect(run({ command: ["node", "-e", script], timeoutSeconds: 0.5 })).rejects.toThrow("Timed out");
		const pid = Number(readFileSync(pidFile, "utf8"));
		await expect.poll(() => isAlive(pid), { timeout: 1000 }).toBe(false);
	});

	it("gives up waiting when a process outside the group keeps the output open", async () => {
		const pidFile = join(mkdtempSync(join(tmpdir(), "link-lens-")), "pid");
		const holder = "setInterval(() => {}, 1000);";
		const script = `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(holder)}], { stdio: "inherit", detached: true }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
		try {
			await expect(run({ command: ["node", "-e", script], timeoutSeconds: 0.3 })).rejects.toThrow("Timed out");
		} finally {
			const pid = Number(readFileSync(pidFile, "utf8"));
			if (isAlive(pid)) process.kill(pid, "SIGKILL");
		}
	});

	it("stops providers that print too much", async () => {
		await expect(run({ command: ["node", "-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"] })).rejects.toThrow("more than 1 MB");
	});

	it("reports a non-zero exit without stderr", async () => {
		await expect(run({ command: ["node", "-e", "process.exit(4)"] })).rejects.toThrow("Exited with code 4");
	});

	it("finds programs on the extra PATH", async () => {
		const match = new ProviderSet([provider({ command: ["node", "-e", "process.stdout.write(process.env.PATH.split(require('node:path').delimiter)[0])"] })]).match("https://example.com/1");
		if (!match) throw new Error("no match");
		await expect(runProvider(match, { ...context, extraPath: "/custom/bin" })).resolves.toMatchObject({ body: "/custom/bin" });
	});

	it("joins PATH additions with the platform delimiter", async () => {
		const command = ["node", "-e", "process.stdout.write(process.env.PATH)"];
		const match = new ProviderSet([provider({ command })]).match("https://example.com/1");
		if (!match) throw new Error("no match");
		const preview = await runProvider(match, { ...context, extraPath: "/custom/bin" });
		expect(preview.body?.startsWith(`/custom/bin${delimiter}`)).toBe(true);
	});
});

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("writeProviderScripts", () => {
	const withDir = async (test: (dir: string) => Promise<void>) => {
		const dir = mkdtempSync(join(tmpdir(), "link-lens-"));
		try {
			await test(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	it("writes missing and changed scripts and leaves matching ones alone", () =>
		withDir(async (dir) => {
			const providers = join(dir, "providers");
			mkdirSync(providers);
			writeFileSync(join(providers, "same.mjs"), "same");
			utimesSync(join(providers, "same.mjs"), 1, 1);
			writeFileSync(join(providers, "old.mjs"), "old");
			writeFileSync(join(providers, "mine.mjs"), "mine");
			await writeProviderScripts(dir, { "same.mjs": "same", "old.mjs": "new", "added.mjs": "added" });
			expect(statSync(join(providers, "same.mjs")).mtimeMs).toBe(1000);
			expect(readFileSync(join(providers, "old.mjs"), "utf8")).toBe("new");
			expect(readFileSync(join(providers, "added.mjs"), "utf8")).toBe("added");
			expect(readFileSync(join(providers, "mine.mjs"), "utf8")).toBe("mine");
		}));

	it("leaves a source checkout alone", () =>
		withDir(async (dir) => {
			writeFileSync(join(dir, "package.json"), "{}");
			await writeProviderScripts(dir, { "a.mjs": "a" });
			expect(existsSync(join(dir, "providers"))).toBe(false);
		}));
});
