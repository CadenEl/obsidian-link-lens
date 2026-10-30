#!/usr/bin/env node
// Link Lens provider: previews a GitHub pull request or issue with the GitHub CLI (gh).
// Usage: node github-gh.mjs <owner> <repo> <pull|issues> <number> [--account OWNER=LOGIN]... [--default-account LOGIN]
// --account picks the gh login for an owner; without one, gh's active login is used.
// Prints preview JSON on stdout. Errors go to stderr with exit code 1.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const BODY_LIMIT = 600;
const PR_FIELDS = "title,state,isDraft,reviewDecision,author,baseRefName,headRefName,statusCheckRollup,updatedAt,additions,deletions,body";
const ISSUE_FIELDS = "title,state,stateReason,author,assignees,labels,updatedAt,body";
const REVIEW = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", REVIEW_REQUIRED: "Review required" };
const PASSED = new Set(["SUCCESS", "NEUTRAL"]);
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

export function parseArgs(argv) {
	const [owner, repo, kind, number, ...rest] = argv;
	if (!owner || !repo || !["pull", "issues"].includes(kind) || !/^\d+$/.test(number ?? "")) {
		throw new Error("Usage: github-gh.mjs <owner> <repo> <pull|issues> <number> [--account OWNER=LOGIN]... [--default-account LOGIN]");
	}
	const accounts = new Map();
	let defaultAccount = null;
	for (let i = 0; i < rest.length; i += 2) {
		const [flag, value] = [rest[i], rest[i + 1]];
		if (!value) throw new Error(`${flag} needs a value.`);
		if (flag === "--account") {
			const [accountOwner, login] = value.split("=");
			if (!accountOwner || !login) throw new Error(`--account expects OWNER=LOGIN, got "${value}".`);
			accounts.set(accountOwner.toLowerCase(), login);
		} else if (flag === "--default-account") defaultAccount = value;
		else throw new Error(`Unknown option ${flag}.`);
	}
	return { owner, repo, kind, number, login: accounts.get(owner.toLowerCase()) ?? defaultAccount };
}

/** Summarizes check runs and commit statuses, such as "5 passed, 1 skipped". */
export function summarizeChecks(rollup = []) {
	const counts = { passed: 0, failed: 0, pending: 0, skipped: 0 };
	for (const check of rollup) {
		const outcome = check.__typename === "StatusContext" ? check.state : check.status === "COMPLETED" ? check.conclusion : "PENDING";
		if (PASSED.has(outcome)) counts.passed++;
		else if (FAILED.has(outcome)) counts.failed++;
		else if (outcome === "SKIPPED") counts.skipped++;
		else counts.pending++;
	}
	return Object.entries(counts)
		.filter(([, n]) => n > 0)
		.map(([name, n]) => `${n} ${name}`)
		.join(", ");
}

/** Keeps whole paragraphs up to the limit and drops HTML comments that PR templates leave behind. */
export function excerpt(markdown, limit = BODY_LIMIT) {
	const blocks = (markdown ?? "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.split(/\n\s*\n/)
		.map((block) => block.trim())
		.filter(Boolean);
	const kept = [];
	let length = 0;
	for (const block of blocks) {
		if (kept.length && length + block.length > limit) {
			kept.push("…");
			break;
		}
		kept.push(block.length > limit ? `${block.slice(0, limit).trimEnd()}…` : block);
		length += block.length;
	}
	return kept.join("\n\n");
}

export function prPreview({ owner, repo, number }, pr) {
	// GitHub keeps isDraft on closed drafts, so the final state wins.
	const badge =
		pr.state === "MERGED"
			? { text: "Merged", tone: "purple" }
			: pr.state === "CLOSED"
				? { text: "Closed", tone: "red" }
				: pr.isDraft
					? { text: "Draft", tone: "neutral" }
					: { text: "Open", tone: "green" };
	const fields = [
		{ label: "Author", value: pr.author?.login ?? "unknown" },
		{ label: "Branch", value: `${pr.headRefName} → ${pr.baseRefName}` },
	];
	if (REVIEW[pr.reviewDecision]) fields.push({ label: "Review", value: REVIEW[pr.reviewDecision] });
	const checks = summarizeChecks(pr.statusCheckRollup);
	if (checks) fields.push({ label: "Checks", value: checks });
	fields.push({ label: "Changes", value: `+${pr.additions} −${pr.deletions}` });
	if (pr.updatedAt) fields.push({ label: "Updated", value: pr.updatedAt.slice(0, 10) });
	return { title: pr.title, subtitle: `${owner}/${repo}#${number} · Pull request`, badge, fields, body: excerpt(pr.body) || undefined };
}

export function issuePreview({ owner, repo, number }, issue) {
	const badge =
		issue.state === "OPEN"
			? { text: "Open", tone: "green" }
			: { text: issue.stateReason === "NOT_PLANNED" ? "Not planned" : "Closed", tone: issue.stateReason === "NOT_PLANNED" ? "neutral" : "purple" };
	const fields = [{ label: "Author", value: issue.author?.login ?? "unknown" }];
	if (issue.assignees?.length) fields.push({ label: "Assignees", value: issue.assignees.map((a) => a.login).join(", ") });
	if (issue.labels?.length) fields.push({ label: "Labels", value: issue.labels.map((l) => l.name).join(", ") });
	if (issue.updatedAt) fields.push({ label: "Updated", value: issue.updatedAt.slice(0, 10) });
	return { title: issue.title, subtitle: `${owner}/${repo}#${number} · Issue`, badge, fields, body: excerpt(issue.body) || undefined };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const env = { ...process.env };
	if (args.login) env.GH_TOKEN = (await run("gh", ["auth", "token", "--user", args.login])).stdout.trim();
	const repo = `${args.owner}/${args.repo}`;
	const isPull = args.kind === "pull";
	const command = isPull ? ["pr", "view", args.number, "-R", repo, "--json", PR_FIELDS] : ["issue", "view", args.number, "-R", repo, "--json", ISSUE_FIELDS];
	const { stdout } = await run("gh", command, { env, maxBuffer: 8 * 1024 * 1024 });
	const data = JSON.parse(stdout);
	process.stdout.write(JSON.stringify(isPull ? prPreview(args, data) : issuePreview(args, data)));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${(error.stderr || error.message || String(error)).trim()}\n`);
		process.exit(1);
	});
}
