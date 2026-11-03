import { describe, expect, it } from "vitest";
import { excerpt, issuePreview, parseArgs, prPreview, summarizeChecks } from "../providers/github-gh.mjs";

describe("github-gh provider", () => {
	it("picks the gh login by owner, falling back to the default", () => {
		const flags = ["--account", "ExampleOrg=work-login", "--default-account", "personal-login"];
		expect(parseArgs(["exampleorg", "r", "pull", "3", ...flags]).login).toBe("work-login");
		expect(parseArgs(["someone-else", "r", "pull", "3", ...flags]).login).toBe("personal-login");
		expect(parseArgs(["o", "r", "issues", "3"]).login).toBeNull();
	});

	it.each([[["o", "r", "blob", "3"]], [["o", "r", "pull", "x"]], [["o", "r", "pull", "3", "--account"]], [["o", "r", "pull", "3", "--account", "bad"]], [["o", "r", "pull", "3", "--nope", "x"]]])(
		"rejects bad arguments %j",
		(argv) => {
			expect(() => parseArgs(argv)).toThrow();
		},
	);

	it("summarizes check run and status context counts", () => {
		expect(
			summarizeChecks([
				{ state: "SUCCESS", count: 3 },
				{ state: "NEUTRAL", count: 1 },
				{ state: "SKIPPED", count: 1 },
				{ state: "IN_PROGRESS", count: 2 },
				{ state: "QUEUED", count: 1 },
				{ state: "FAILURE", count: 1 },
				{ state: "ERROR", count: 1 },
				{ state: "EXPECTED", count: 1 },
			]),
		).toBe("4 passed, 2 failed, 4 pending, 1 skipped");
		expect(summarizeChecks([])).toBe("");
	});

	it("drops template comments from the body excerpt", () => {
		expect(excerpt("<!-- fill me -->\n\nFixes X.\n\n## Testing\n\nRan it.", 15)).toBe("Fixes X.\n\n…");
	});

	it("builds pull request and issue previews", () => {
		const args = { owner: "example-org", repo: "widgets", number: "42" };
		const contexts = { checkRunCountsByState: [{ state: "SUCCESS", count: 2 }], statusContextCountsByState: [{ state: "FAILURE", count: 1 }] };
		const pr = { title: "Add CSV export", state: "MERGED", isDraft: false, reviewDecision: "APPROVED", author: { login: "example-user" }, baseRefName: "main", headRefName: "feature/csv-export", commits: { nodes: [{ commit: { statusCheckRollup: { contexts } } }] }, additions: 10, deletions: 2, updatedAt: "2026-01-15T09:30:00Z", body: "" };
		expect(prPreview(args, pr)).toEqual({
			title: "Add CSV export",
			subtitle: "example-org/widgets#42 · Pull request",
			badge: { text: "Merged", tone: "purple" },
			fields: [
				{ label: "Author", value: "example-user" },
				{ label: "Branch", value: "feature/csv-export → main" },
				{ label: "Review", value: "Approved" },
				{ label: "Checks", value: "2 passed, 1 failed" },
				{ label: "Changes", value: "+10 −2" },
				{ label: "Updated", value: "2026-01-15" },
			],
			body: undefined,
		});
		// A commit with no checks has a null rollup.
		const unchecked = { ...pr, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } };
		expect(prPreview(args, unchecked).fields.map((field) => field.label)).not.toContain("Checks");
		expect(prPreview(args, { ...pr, isDraft: true, state: "OPEN" }).badge).toEqual({ text: "Draft", tone: "neutral" });
		expect(prPreview(args, { ...pr, isDraft: true, state: "CLOSED" }).badge).toEqual({ text: "Closed", tone: "red" });
		expect(prPreview(args, { ...pr, isDraft: false, state: "OPEN" }).badge).toEqual({ text: "Open", tone: "green" });
		expect(issuePreview(args, { title: "Bug", state: "CLOSED", stateReason: "NOT_PLANNED", author: { login: "a" }, assignees: [{ login: "b" }], labels: [{ name: "export" }], body: "Steps" })).toMatchObject({
			badge: { text: "Not planned", tone: "neutral" },
			fields: [{ label: "Author", value: "a" }, { label: "Assignees", value: "b" }, { label: "Labels", value: "export" }],
			body: "Steps",
		});
	});
});
