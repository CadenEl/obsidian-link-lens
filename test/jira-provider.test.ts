import { describe, expect, it } from "vitest";
import { adfToBlocks, checkSite, excerpt, lookup, move, parseArgs, toPreview } from "../providers/jira-acli.mjs";

const doc = {
	type: "doc",
	content: [
		{ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Steps" }] },
		{ type: "paragraph", content: [{ type: "text", text: "Export a large file." }, { type: "hardBreak" }, { type: "text", text: "It stops at 10 MB." }] },
		{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "CSV only" }] }] }] },
		{ type: "mediaSingle", content: [] },
	],
};

describe("jira-acli provider", () => {
	it("turns ADF into Markdown blocks", () => {
		expect(adfToBlocks(doc)).toEqual(["**Steps**", "Export a large file. It stops at 10 MB.", "- CSV only"]);
		expect(adfToBlocks(null)).toEqual([]);
	});

	it("keeps whole blocks within the limit", () => {
		expect(excerpt(["aaaa", "bbbb", "cccc"], 9)).toBe("aaaa\n\nbbbb\n\n…");
		expect(excerpt(["x".repeat(20)], 5)).toBe("xxxxx…");
	});

	it("refuses links to a site acli isn't signed in to", () => {
		const status = "✓ Authenticated\n  Site: example.atlassian.net\n  Authentication Type: oauth\n";
		expect(() => checkSite("example.atlassian.net", status)).not.toThrow();
		expect(() => checkSite("Example.atlassian.net", status)).not.toThrow();
		expect(() => checkSite("other.atlassian.net", status)).toThrow("signed in to example.atlassian.net, not other.atlassian.net");
		expect(() => checkSite("example.atlassian.net", "not logged in")).toThrow("Could not tell");
	});

	it("waits for the issue lookup before failing on the site check", async () => {
		let viewDone = false;
		const run = async (_cmd: string, args: string[]) => {
			if (args[1] === "auth") throw Object.assign(new Error("auth failed"), { stderr: "not logged in" });
			await new Promise((resolve) => setTimeout(resolve, 50));
			viewDone = true;
			return { stdout: "{}" };
		};
		await expect(lookup("example.atlassian.net", "X-1", [], run)).rejects.toThrow("auth failed");
		expect(viewDone).toBe(true);
	});

	it("rejects a wrong site even when the issue lookup succeeds", async () => {
		const run = async (_cmd: string, args: string[]) => ({ stdout: args[1] === "auth" ? "Site: example.atlassian.net" : JSON.stringify({ fields: { summary: "S" } }) });
		await expect(lookup("other.atlassian.net", "X-1", [], run)).rejects.toThrow("not other.atlassian.net");
		await expect(lookup("example.atlassian.net", "X-1", [], run)).resolves.toMatchObject({ title: "S" });
	});

	it("builds a preview from acli JSON", () => {
		const issue = {
			fields: {
				summary: "Export fails on large files",
				status: { name: "To Do", statusCategory: { key: "new" } },
				issuetype: { name: "Task" },
				assignee: null,
				parent: { key: "PROJ-100", fields: { summary: "Data export" } },
				priority: { name: "Medium" },
				updated: "2026-01-15T09:30:00.000-0500",
				description: doc,
			},
		};
		expect(toPreview("PROJ-123", issue)).toEqual({
			title: "Export fails on large files",
			subtitle: "PROJ-123 · Task · Unassigned",
			badge: { text: "To Do", tone: "neutral" },
			fields: [
				{ label: "Parent", value: "PROJ-100 Data export" },
				{ label: "Priority", value: "Medium" },
				{ label: "Updated", value: "2026-01-15" },
			],
			body: "**Steps**\n\nExport a large file. It stops at 10 MB.\n\n- CSV only",
			actions: { label: "Move to", choices: [], allowOther: true },
		});
		expect(toPreview("X-1", { fields: {} }, ["In Progress", "Done"]).actions).toEqual({ label: "Move to", choices: ["In Progress", "Done"], allowOther: true });
		expect(toPreview("X-1", { fields: { status: { name: "Done", statusCategory: { key: "done" } } } })).toMatchObject({ title: "X-1", badge: { tone: "green" }, body: undefined });
		expect(toPreview("X-1", { fields: { issuetype: { name: "Bug" }, assignee: { displayName: "Pat Example" } } }).subtitle).toBe("X-1 · Bug · Pat Example");
	});

	it("parses statuses and an action", () => {
		expect(parseArgs(["example.atlassian.net", "PROJ-1", "--status", "In Progress", "--status", "Done", "--action", "In Review"])).toEqual({
			site: "example.atlassian.net",
			key: "PROJ-1",
			statuses: ["In Progress", "Done"],
			action: "In Review",
		});
		expect(() => parseArgs(["site", "PROJ-1,PROJ-2"])).toThrow("Usage");
		expect(() => parseArgs(["site", "PROJ-1", "--action"])).toThrow("needs a value");
		expect(() => parseArgs(["site", "PROJ-1", "--nope", "x"])).toThrow("Unknown option");
	});

	describe("move", () => {
		const issue = (status: string) => JSON.stringify({ fields: { summary: "S", status: { name: status, statusCategory: { key: "indeterminate" } } } });
		const fakeAcli = (statusAfter: string, site = "example.atlassian.net") => {
			const calls: string[][] = [];
			const run = async (_cmd: string, args: string[]) => {
				calls.push(args);
				if (args[1] === "auth") return { stdout: `Site: ${site}` };
				if (args[1] === "workitem" && args[2] === "transition") return { stdout: "" };
				return { stdout: issue(statusAfter) };
			};
			return { calls, run };
		};

		it("moves the issue and returns the refreshed preview", async () => {
			const { calls, run } = fakeAcli("In Progress");
			await expect(move("example.atlassian.net", "PROJ-1", "In Progress", ["Done"], run)).resolves.toMatchObject({ badge: { text: "In Progress" }, actions: { choices: ["Done"] } });
			expect(calls).toContainEqual(["jira", "workitem", "transition", "--key", "PROJ-1", "--status", "In Progress", "--yes"]);
		});

		it("checks the site before changing anything", async () => {
			const { calls, run } = fakeAcli("In Progress", "other.atlassian.net");
			await expect(move("example.atlassian.net", "PROJ-1", "In Progress", [], run)).rejects.toThrow("signed in to other.atlassian.net");
			expect(calls.some((args) => args[2] === "transition")).toBe(false);
		});

		it("reports a move Jira didn't make", async () => {
			const { run } = fakeAcli("To Do");
			await expect(move("example.atlassian.net", "PROJ-1", "Done", [], run)).rejects.toThrow('PROJ-1 is still To Do. Jira may not allow moving it to "Done"');
		});
	});
});
