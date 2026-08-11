# Automa

A free, open source macOS app that fills out job applications on your own
machine. No account, no server, no telemetry.

**[Download the latest release](https://github.com/darielgu/automa-app/releases/latest)** ·
[Website](https://darielgu.github.io/automa-app/)

---

## What it does

- Pulls the public [SimplifyJobs](https://github.com/SimplifyJobs) internship and
  new-grad boards — about 33,000 listings — into a local database you can search
  instantly, online or off.
- Drives a real browser inside the app window and fills the application while you
  watch. Purpose-built adapters for **Greenhouse, Lever, Ashby, Workday and Work
  at a Startup**.
- Records every run with the fields it filled and the evidence that it did or did
  not submit, then puts finished applications on a tracker board.
- Ships a one-click demo profile and a built-in practice application, so you can
  see the whole thing work before entering anything real.

## Installing

Download the DMG for your Mac and drag Automa to Applications.

The app is unsigned, because an Apple Developer certificate costs $99 a year and
this project is free. macOS will refuse the first launch. To get past it once:

**Right-click the app → Open → Open.**

Or in a terminal:

```bash
xattr -dr com.apple.quarantine /Applications/Automa.app
```

Verify your download against `SHA256SUMS.txt` on the release page if you like:

```bash
shasum -a 256 ~/Downloads/Automa-mac-arm64.dmg
```

## How honest is it?

About **59% of currently active listings** are on an ATS with a purpose-built
adapter. The rest are company career sites, where the generic adapter fills what
it can and often needs you to finish. The app labels this per job rather than
implying one click is always enough.

Automa also will not claim a submission it cannot prove. It reports "confirmed"
only on real evidence — a confirmation page, a success URL, or the form
demonstrably gone — and otherwise says "pending confirmation".

### What it will never do

Questions about citizenship, sponsorship, work authorization, disability,
veteran status, race, ethnicity, gender, age, criminal history or security
clearance are **never** answered by a language model. Automa uses the answer you
entered, or it stops and asks you. Guessing on those is not a feature.

## Your data

There is no backend. Your profile, resume and answers live in
`~/Library/Application Support/Automa` in a single SQLite file readable only by
you, and are sent only to the application you chose to apply to. Job listings
come from a public JSON file on GitHub, fetched at most once an hour.

An LLM API key is optional. Without one, Automa answers deterministically from
your profile. If you add a key it is stored encrypted with macOS Keychain
protection and used only for free-text questions.

## Development

Requires Node 22.5 or newer.

```bash
npm install
npm run build
npm run check     # type-check every workspace
npm test          # unit tests
npm run dev -w @automa/desktop   # run the app
```

Build the DMGs:

```bash
npm run dist -w @automa/desktop  # -> apps/desktop/release/
```

### Layout

| Path | What it is |
|---|---|
| `apps/desktop` | The Electron app: main process, IPC, local database, UI |
| `packages/engine` | The automation engine and its per-ATS adapters |
| `packages/job-feed-core` | Shared job-feed normalizer, used by the app and the optional scraper |
| `packages/shared` | Types shared across the app |
| `supabase/` | Optional hosted mirror of the job feed. Not required. |
| `docs/` | The website |

### How the automation works

The app opens a `WebContentsView` inside its own window and attaches Playwright
to Electron's own Chromium over the Chrome DevTools Protocol. That means
**no browser is ever downloaded** — `playwright-core` is used purely as a client,
and the browser you are automating is the one you can see.

There are no native modules. The database is `node:sqlite`, which is built into
the Node runtime Electron ships, so there is no ABI rebuild step and no
per-architecture binary to get wrong.

### Tests

```bash
npm test                                    # normalizer + engine logic
npm run test:dom -w @automa/automation-engine   # adapter tests that need a browser
npm run test -w @automa/desktop                 # local database layer
```

`test:dom` needs a Playwright browser: `npx playwright install chromium`.

## Contributing

Issues and pull requests are welcome. Two rules that are not negotiable:

1. Never make the automation guess a protected question.
2. Never report a submission as confirmed without evidence.

## License

MIT. See [LICENSE](LICENSE).

Not affiliated with SimplifyJobs, Greenhouse, Lever, Ashby, Workday or
Y Combinator. Job listings belong to their respective sources.
