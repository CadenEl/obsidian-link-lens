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
// Asks for check counts by state rather than every check's record, which on a PR with many
// checks is most of the response. This is the shape gh itself uses for check counts.
const PR_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      title state isDraft reviewDecision author { login } baseRefName headRefName updatedAt additions deletions body
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts {
        checkRunCountsByState { state count }
        statusContextCountsByState { state count }
      } } } } }
    }
  }
}`;
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

/**
 * Summarizes check run and commit status counts by state, such as "5 passed, 1 skipped".
 * Unfinished states, such as QUEUED or IN_PROGRESS, count as pending.
 */
export function summarizeChecks(stateCounts = []) {
	const counts = { passed: 0, failed: 0, pending: 0, skipped: 0 };
	for (const { state, count } of stateCounts) {
		if (PASSED.has(state)) counts.passed += count;
		else if (FAILED.has(state)) counts.failed += count;
		else if (state === "SKIPPED") counts.skipped += count;
		else counts.pending += count;
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
	const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
	const checks = summarizeChecks([...(contexts?.checkRunCountsByState ?? []), ...(contexts?.statusContextCountsByState ?? [])]);
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
	const options = { env, maxBuffer: 8 * 1024 * 1024 };
	if (args.kind === "issues") {
		const { stdout } = await run("gh", ["issue", "view", args.number, "-R", `${args.owner}/${args.repo}`, "--json", ISSUE_FIELDS], options);
		process.stdout.write(JSON.stringify(issuePreview(args, JSON.parse(stdout))));
		return;
	}
	// -f passes owner and repo as strings even when they look like numbers; -F makes number an Int.
	const query = ["api", "graphql", "-f", `query=${PR_QUERY}`, "-f", `owner=${args.owner}`, "-f", `repo=${args.repo}`, "-F", `number=${args.number}`];
	const { stdout } = await run("gh", query, options);
	const pr = JSON.parse(stdout).data?.repository?.pullRequest;
	if (!pr) throw new Error(`Could not find pull request ${args.owner}/${args.repo}#${args.number}.`);
	process.stdout.write(JSON.stringify(prPreview(args, pr)));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${(error.stderr || error.message || String(error)).trim()}\n`);
		process.exit(1);
	});
}
