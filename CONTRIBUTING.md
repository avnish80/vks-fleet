# Contributing

Thanks for your interest. Issues and pull requests are welcome; for anything large, open an issue first so we can agree on the approach.

## Try it without a lab

**Settings → Demo mode** shows a fictional fleet (two orgs, four clusters with realistic problems, a Supervisor with vCenter data). **Demo fleet size** scales it to 12, 20 or 50 clusters. Nothing is ever changed in demo mode; dry runs work.

## Build

The plugin is built by CI (`.github/workflows/build.yml`), which scaffolds a Headlamp plugin project, copies `src/` into it and builds. Locally:

```bash
mkdir -p build && cd build
npx @kinvolk/headlamp-plugin create vks-fleet
cd vks-fleet && rm -rf src && cp -r ../../src ./src && npm install
npm run start        # development build, watching for changes
npm run build        # dist/main.js
```

Point Headlamp's plugins folder at the build (for example `-plugins-dir`), or copy `dist/main.js` and `package.json` into `<plugins>/vks-fleet/`.

## Tests

```bash
npx tsx --test tests/*.test.ts                                   # the plugin (Node's test runner)
python3 -m unittest discover -s deploy/collector -p 'test_*.py'  # the vCenter collector
```

Tests run against pure functions and the demo fleet: no cluster, no network. A change to how something is read or judged should come with a test, ideally one that reproduces what was seen in a real environment.

## Code layout

- `src/*.ts`: pure logic (reading, parsing, rules, issues, plans). No React, no Headlamp imports, so it's testable.
- `src/components/*.tsx`: pages and dialogs.
- `src/api/`: the only place that talks to Headlamp's API proxy (with a request limiter).
- `src/demo/`: the demo fleet, served through the same client interface as a real cluster.
- `deploy/`: in-cluster deployment (kustomize and Helm), the refresher, the vCenter collector and the jump-server scripts.

## Conventions

- **Plain language in the UI:** say what's wrong, why it matters, and what to do, in that order. No jargon an operator wouldn't use.
- **Never guess:** when something can't be read, say so ("sign in to check", "not collected") rather than showing a default.
- **Changes go through an action plan** (`src/actions.ts`): checks, a dry run, a confirmation, and the audit stamp.
- **Scale:** assume 20 to 50 clusters. Summaries first; full tables in dialogs or behind "show all".
- **Themes:** colours come from the theme (light and dark).

## Pull requests

Keep them focused, include tests, and describe what you saw and how you verified the change.
