# Link Lens

An Obsidian plugin that previews external links when you hover over them and puts a status dot after each one. Your link text stays as written: `[PROJ-123](https://…/browse/PROJ-123)` still reads "PROJ-123", and the dot's color shows the issue's status.

Previews come from **providers**: a URL pattern and a command. Link Lens runs the command, reads what it prints, and caches the result. Any CLI or script can be a provider, so supporting a new kind of link takes one command and one settings entry.

Two providers come with the plugin:

| Provider | Links | Needs |
| --- | --- | --- |
| `jira` | `https://<site>.atlassian.net/browse/KEY-123` | [`acli`](https://developer.atlassian.com/cloud/acli/), signed in to that site |
| `github` | `https://github.com/<owner>/<repo>/pull/N` and `/issues/N` | [`gh`](https://cli.github.com/), signed in |

Both reuse the CLI's existing login, so Link Lens stores no tokens.

## Requirements

- Obsidian 1.5 or later, on desktop. Link Lens runs local programs, so it doesn't work on mobile.
- [Node.js](https://nodejs.org/), which runs the bundled providers.
- `acli`, `gh`, or both, signed in, for the links you want previewed.

## Install

Link Lens isn't in Obsidian's community plugin list yet. To install it, build it from a clone of this repository with Node.js 22.12 or later (not 23):

```sh
npm install
npm run build
npm run install-vault -- /path/to/your/vault
```

`install-vault` copies `main.js`, `manifest.json`, `styles.css`, and the `providers` folder into `<vault>/.obsidian/plugins/link-lens/`. It leaves your saved settings alone, so you can rerun it to update. Then reload Obsidian and turn on **Link Lens** under **Settings → Community plugins**.

## Use

Hover over a link to see its preview. The preview starts small: the title, the status, and a subtitle such as the key and assignee. Click anywhere in it except the link, or the arrow in its corner, to open the details: fields, a description excerpt, and actions such as moving a Jira issue to another status. The next preview opens the way you left the last one.

Dots show in Reading view and Live Preview. In Live Preview, a link you've just typed or scrolled to gets its dot after you pause for 400 ms, so typing a URL doesn't run its provider on every keystroke. When a cached result expires, its dot keeps the last status until the link loads again.

## Settings

- **Status badges:** show the dot after each link. Hover over the dot to see the status as text.
- **Hover delay:** milliseconds before a preview appears.
- **Cache minutes:** how long a result is reused before its provider runs again. Failures are retried after at most a minute. **Clear cache** drops every result.
- **PATH additions:** folders searched for programs before the app's own PATH, separated by `:` on macOS and Linux or `;` on Windows. Apps opened from the Dock don't get your shell's PATH, so this defaults to `/opt/homebrew/bin:/usr/local/bin`.
- **Providers:** the provider list as JSON. Changes save when the box loses focus, and invalid JSON is rejected with the reason.
- **Test a link:** runs the matching provider without the cache and shows its parsed output or error.

## Providers

This is the bundled GitHub provider:

```json
{
  "id": "github",
  "name": "GitHub pull requests and issues (gh)",
  "enabled": true,
  "pattern": "^https://github\\.com/(?<owner>[^/]+)/(?<repo>[^/]+)/(?<kind>pull|issues)/(?<number>\\d+)(?:[/?#].*)?$",
  "command": ["node", "{pluginDir}/providers/github-gh.mjs", "{owner}", "{repo}", "{kind}", "{number}"],
  "timeoutSeconds": 20
}
```

- **`pattern`** is a JavaScript regular expression tested against the link's URL. The first enabled provider that matches handles the link.
- **`command`** is the program and its arguments. It runs directly, not through a shell, so values never need quoting and can't inject commands. These placeholders are filled in:
  - `{url}`: the whole link URL.
  - `{pluginDir}`: this plugin's folder, where the bundled provider scripts live.
  - `{vaultDir}`: the vault folder, which is also the working directory.
  - `{name}`: any named group from `pattern`, such as `{owner}` above.
- **`timeoutSeconds`** stops a command that hangs. It defaults to 20.

Links whose commands come out the same share one result. `…/pull/42` and `…/pull/42/files` both fill in to the same `github-gh.mjs` arguments, so the provider runs once for both. Link Lens runs at most four provider commands at a time for previews and dots.

### Output

A provider prints either JSON or plain text on stdout.

**Plain text** is rendered as Markdown under the URL. The quickest provider is any command that already prints something useful.

**JSON** gives a structured preview. Only `title` is required:

```json
{
  "title": "Export fails on files over 10 MB",
  "subtitle": "PROJ-123 · Bug · Pat Example",
  "badge": { "text": "In Progress", "tone": "blue" },
  "fields": [
    { "label": "Parent", "value": "PROJ-100 Data export" }
  ],
  "body": "**Problem**\n\nThe export stops partway through once a file passes 10 MB…"
}
```

- `badge.tone` is one of `neutral`, `blue`, `green`, `yellow`, `red`, or `purple`, and defaults to `neutral`. A link whose preview has no badge gets no dot.
- `body` is Markdown, shown under the fields in a scrollable area.
- `actions` offers a change the provider can make:

  ```json
  "actions": { "label": "Move to", "choices": ["In Progress", "Done"], "allowOther": true }
  ```

  The preview shows `label` with a menu of `choices`, plus a text box when `allowOther` is true. Choosing one reruns the provider's command with `--action <choice>` appended. The provider makes the change and prints the refreshed preview, which also updates the link's dots. To refuse, exit non-zero with the reason on stderr, which the preview shows. A choice that matches the current badge text is hidden.

**Errors:** exit with a non-zero code and print the reason to stderr. The preview shows it.

### Add a provider

1. Write a command that takes values from the URL as arguments and prints the output above. [`providers/jira-acli.mjs`](providers/jira-acli.mjs) and [`providers/github-gh.mjs`](providers/github-gh.mjs) are standalone examples to copy. Each calls one CLI and reshapes its JSON.
2. Add an entry to **Providers** in settings with a `pattern` for the URLs and a `command` that runs it.
3. Paste a URL into **Test a link** to check it.

For example, once you've written a `confluence-acli.mjs` script that looks a page up with `acli`, Confluence pages could use an entry like this:

```json
{
  "id": "confluence",
  "name": "Confluence pages (acli)",
  "pattern": "^https://[^/]+\\.atlassian\\.net/wiki/spaces/[^/]+/pages/(?<id>\\d+)",
  "command": ["node", "/path/to/confluence-acli.mjs", "{id}"]
}
```

### Jira statuses

`jira-acli.mjs` offers a **Move to** menu. `acli` can't list the statuses a project's workflow allows, so the menu shows the ones you pass with `--status`, in order, plus **Other…** for any name. Jira decides whether a move is allowed. The provider reads the issue again afterward and reports a move that didn't happen.

```json
"command": ["node", "{pluginDir}/providers/jira-acli.mjs", "{site}", "{key}",
            "--status", "To Do", "--status", "In Progress", "--status", "Done"]
```

### GitHub accounts

`github-gh.mjs` uses gh's active login unless you pick one per owner:

```json
"command": ["node", "{pluginDir}/providers/github-gh.mjs", "{owner}", "{repo}", "{kind}", "{number}",
            "--account", "MyOrg=work-login", "--default-account", "personal-login"]
```

It gets each login's token with `gh auth token --user <login>`.

## Security

Provider commands run with your user account's permissions. Settings live in the vault at `.obsidian/plugins/link-lens/data.json`, so anyone who can edit a vault you sync or share can change what Link Lens runs on your computer. Check the provider list before you turn the plugin on in a vault you didn't set up.

## Contributing

Bug reports, fixes, and new providers are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, tests, and trying changes in Obsidian.

## License

[MIT](LICENSE)
