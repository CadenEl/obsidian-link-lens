# Link Lens

An Obsidian plugin that shows a preview when you hover over an external link, plus a status dot after the link. Your link text stays as written: `[PROJ-123](https://…/browse/PROJ-123)` keeps reading "PROJ-123".

The preview starts small: the title, the status, and a subtitle, such as the key and assignee. Click anywhere in it except the link, or the arrow in its corner, to open the details, such as fields, a description excerpt, and actions like moving a Jira issue to another status. The next preview opens the way you left the last one.

Previews come from **providers**: a URL pattern and a command. Link Lens runs the command, reads what it prints, and caches the result. Any CLI or script can be a provider, so adding a new kind of link takes a command and one settings entry.

It ships with two providers:

| Provider | Links | Uses |
| --- | --- | --- |
| `jira` | `https://<site>.atlassian.net/browse/KEY-123`, for the site `acli` is signed in to | [`acli`](https://developer.atlassian.com/cloud/acli/) |
| `github` | `https://github.com/<owner>/<repo>/pull/N` and `/issues/N` | [`gh`](https://cli.github.com/) |

Both reuse the CLI's existing login, so Obsidian stores no tokens. Desktop only, since it runs local programs.

## Install

```sh
npm install
npm run build
npm run install-vault -- /path/to/vault
```

Then reload Obsidian and turn on **Link Lens** under Settings → Community plugins. Reinstalling keeps your saved settings.

## Settings

- **Status badges:** show a colored dot after each link, in Reading view and Live Preview. Hover the dot to see the status.
- **Hover delay:** milliseconds before a preview appears.
- **Cache minutes:** how long a result is reused. Failures are retried after at most a minute. **Clear cache** forgets everything.
- **PATH additions:** folders searched for programs before the app's own PATH, separated by `:` on macOS and Linux or `;` on Windows. Apps opened from the Dock don't get your shell's PATH, so this defaults to `/opt/homebrew/bin:/usr/local/bin`.
- **Providers:** the provider list as JSON. Changes save when the box loses focus, and invalid JSON is rejected with the reason.
- **Test a link:** runs the matching provider without the cache and shows its parsed output or error.

## Providers

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

- `badge.tone` is one of `neutral`, `blue`, `green`, `yellow`, `red`, or `purple`, and defaults to `neutral`. Links without a badge get no badge.
- `body` is Markdown, shown under the fields in a scrollable area.
- `actions` offers a change the provider can make:

  ```json
  "actions": { "label": "Move to", "choices": ["In Progress", "Done"], "allowOther": true }
  ```

  The preview shows `label` with a menu of `choices`, plus a text box when `allowOther` is true. Choosing one reruns the provider's command with `--action <choice>` appended. The provider makes the change and prints the refreshed preview, which also updates the item's dots. To refuse, exit non-zero with the reason on stderr, which the preview shows. A choice that matches the current badge text is hidden.

**Errors:** exit with a non-zero code and print the reason to stderr. The preview shows it.

### Adding a provider

1. Write a command that takes values from the URL as arguments and prints the output above. [`providers/jira-acli.mjs`](providers/jira-acli.mjs) and [`providers/github-gh.mjs`](providers/github-gh.mjs) are standalone examples to copy; each calls one CLI and reshapes its JSON.
2. Add an entry to **Providers** in settings with a `pattern` for the URLs and a `command` that runs it.
3. Paste a URL into **Test a link** to check it.

For example, Confluence pages could get an entry like this, once you've written a `confluence-acli.mjs` script that looks the page up with `acli`:

```json
{
  "id": "confluence",
  "name": "Confluence pages (acli)",
  "pattern": "^https://[^/]+\\.atlassian\\.net/wiki/spaces/[^/]+/pages/(?<id>\\d+)",
  "command": ["node", "/path/to/confluence-acli.mjs", "{id}"]
}
```

### Jira statuses

`jira-acli.mjs` offers a **Move to** menu. acli can't list the statuses a project's workflow allows, so the menu shows the ones you pass with `--status`, in order, plus **Other…** for any name. Jira decides whether a move is allowed. The provider re-reads the issue afterward and reports a move that didn't happen.

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

## Development

```sh
npm test         # unit tests, including the provider scripts
npm run build    # typecheck and bundle main.js
npm run dev      # rebuild on change
```

The bundled provider scripts depend only on Node's standard library.
