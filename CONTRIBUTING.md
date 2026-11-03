# Contributing

Bug reports, fixes, and new providers are welcome. For a larger change, open an issue first so we can agree on the approach before you write it.

## Set up

You need Node.js 22.12 or later, but not 23, which Vitest doesn't support. CI uses Node 22.

```sh
npm install
npm test         # unit tests, including the bundled providers
npm run build    # typecheck and bundle main.js
npm run dev      # rebuild main.js whenever a file changes
```

## Try a change in Obsidian

Use a test vault, not the one you work in. Either copy a build into it:

```sh
npm run build
npm run install-vault -- /path/to/test-vault
```

or symlink this folder to `<test-vault>/.obsidian/plugins/link-lens` and leave `npm run dev` running. Either way, run **Reload app without saving** from the command palette to load the new build. You can set `LINK_LENS_VAULT` instead of passing the vault path each time.

## Where things live

- `src/main.ts`: plugin setup, hover previews, and Reading view dots
- `src/editor.ts`: Live Preview dots, as a CodeMirror view plugin
- `src/cache.ts`: the result cache and its limit of four runs at a time
- `src/providers.ts`: matching URLs to providers and running their commands
- `src/preview.ts`: parsing and checking what a provider prints
- `src/render.ts` and `styles.css`: the preview and dot UI
- `src/config.ts` and `src/settingsTab.ts`: settings and their defaults
- `providers/`: the bundled Jira and GitHub providers, plain Node scripts with no dependencies

## Tests

`npm test` covers everything that runs without Obsidian: the cache, link parsing, provider matching and process handling, the output contract, and both bundled providers. The provider tests never call the real `gh` or `acli`. `jira-acli.mjs` takes a `run` function that tests replace with a fake, and `github-gh.mjs` exports the functions that turn CLI output into a preview.

`main.ts`, `editor.ts`, `render.ts`, and `settingsTab.ts` import Obsidian's API, which only exists inside the app. Check changes to them by hand in a test vault, and say in your pull request what you tried.

## Pull requests

- Run `npm test` and `npm run build` first. CI runs both on every pull request.
- Keep a pull request to one change.
- Match the surrounding code: tabs, small functions, and comments that explain why rather than what.
- The bundled providers use only Node's standard library, so they run without `npm install`. Keep it that way.
