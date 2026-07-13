# Project Brief: Client Reel Builder — Premiere Pro UXP Plugin

## What this is

A UXP plugin for Adobe Premiere Pro that lets a non-technical client build a
branded product-reel video in Premiere without editing anything by hand.
The client picks her clips (typically 6–10, but there is no hard upper
limit), types intro/outro text, and clicks one button.
The plugin builds the sequence and triggers a render.

The client is NOT a Premiere power user. Every button, label, and error
message in the panel UI needs to be plain-language. Assume zero editing
vocabulary on her end.

This is being built by Dan, a self-taught full-stack dev (Python/PHP/JS)
who is NOT an Adobe/Premiere developer and has never written a UXP plugin
before. Explanations of *why* something works a certain way, not just
*what* to type, are expected throughout this project — treat this like
you're teaching, not just executing.

---

## Hard requirements — read this before writing any code

### Output format
- Sequence: 1080×1920 vertical, 30fps
- Runtime floats naturally — there is NO fixed total duration. Clips play
  at their native/full length. Do not build any fixed-duration or
  per-clip-timing logic. This was a mistake in an earlier (non-Claude)
  attempt at this project and must NOT be repeated.

### Structure
- Intro text card — fixed short duration (~2–3s), editable text field in the UI
- Product clips (typically 6–10, but any number is allowed — do NOT cap
  this) — stitched end-to-end at native length, in the order selected in
  the UI, with a transition (cross-dissolve default) at every clip boundary
- Outro text card — fixed short duration (~2–3s), editable text field
- Watermark — client's image asset, bottom-right corner, visible for the
  ENTIRE runtime regardless of how long the final video ends up being. Must
  live on its own track so nothing else can ever cover it.

### Text cards are .mogrt files — not layers in the master
The intro/outro cards are Motion Graphics Templates, designed once in
Premiere's Essential Graphics panel and exported as `.mogrt`. The plugin
inserts them with `SequenceEditor.insertMogrtFromPath()` and sets their
wording through component parameters.

This is not a stylistic choice — it's the only supported path. UXP exposes
no API for rewriting the text of a hand-built Essential Graphics layer, so
a card living inside the master sequence could be placed but never worded.
A `.mogrt` exposes its text as a real parameter. Do not attempt to reach
into graphics internals to avoid this.

### Transitions eat frames — this is accepted, not a bug
A cross-dissolve needs overlapping footage ("handles") to blend. Clips used
at full native length have none by definition. Premiere resolves this by
pulling the clips slightly into each other, so the finished reel runs a
little shorter than the sum of its clips. That trade was made deliberately:
Dan chose dissolves over hard cuts, kept short (default 10 frames /
~0.33s at 30fps — see `TRANSITION_FRAMES` in index.js) so the loss is
small and the cut just reads as "not jarring."

Consequently the UI's runtime figure is an ESTIMATE and must be labelled as
one. The true length is only known after the transitions are applied.

### Track layout the master MUST have
The plugin depends on this contract. Validation blocks the build if the
master has too few video tracks.

| Track | Zero-based index | Holds |
|-------|------------------|-------|
| V1 | 0 | intro card → product clips → outro card, end to end |
| V2 | 1 | watermark, alone, stretched to the full runtime |
| A1 | 0 | the clips' own source audio |

Note UXP track indexes are zero-based: video track 0 is the UI's "V1".

The watermark is placed by the plugin (from the UI's asset picker), not
inherited from the master — the master only has to provide the empty track
for it. It is stretched to the sequence's end time AFTER transitions are
applied, which is what guarantees full coverage at any clip count.

### Audio
- Default: keep each clip's original source audio
- UI toggle to mute all source audio instead
- No music track. Do not add one, do not stub one out "just in case."

### The master sequence pattern (important — do not skip)
- There is a hand-built "master" sequence in the Premiere project that
  carries the 1080×1920/30fps sequence settings and the empty track layout
  above. (It does NOT carry the text cards — see the .mogrt note — and it
  does not need the watermark pre-placed.)
- Premiere's UXP API has NO "duplicate sequence" method. The copy is made
  with `sequence.createCloneAction()` inside a transaction. The clone action
  does not hand back the new sequence, so the plugin snapshots every
  sequence GUID, clones, then diffs to find the new one. Do not "simplify"
  this by matching on a name like "MASTER Copy" — that name is localised
  and collides when copies already exist.
- The plugin must NEVER build directly onto the master. Every build
  operation duplicates the master sequence first, renames the duplicate
  (client name / date), and does all work on the duplicate.
- If the master sequence can't be found by name, the build must fail
  loudly with a clear error — never silently create a new blank sequence
  instead.

### Validation — block the build if:
- Intro text field is empty
- No product clips selected
- No watermark asset is set/found
- No active Premiere project
- The named master sequence can't be found in the project
- The intro/outro `.mogrt` card templates aren't set
- The master sequence has fewer video tracks than the layout above needs

### Validation — proceed but say so if:
- No export preset (`.epr`) or output folder is set. The reel still gets
  built; only the render is skipped, with a message telling the client to
  export by hand. A missing preset must never throw away a good build.

### Validation — warn (but allow build) if:
- Any selected clip appears offline/missing
- Any selected clip isn't vertical orientation

---

## Host version — this is a hard constraint, not a preference

**Premiere Pro 25.6.x. Do not develop or deploy against 26.x.**

Premiere 26 does not load extensions. Verified the hard way on 2026-07-12:

- UXP: every plugin times out on load — ours, *and Adobe's own untouched
  "Create Plugin" starter template*. Tested on 26.3.0 (release) and 26.5.0
  (Beta), from both `C:` and `D:`, with developer mode enabled at the app
  level (Preferences → Plugins) and the machine level
  (`C:\Program Files\Common Files\Adobe\UXP\Developer\settings.json` =
  `{"developer": true}`), on a freshly installed UDT 2.2.1.2. UDT's
  `Validate` succeeds against the host every time; only `Load` fails.
  Tell-tale sign: `%APPDATA%\Adobe\UXP` is never created.
- CEP (the older panel tech) is not a fallback — Premiere 26 doesn't load
  CEP panels either, and Adobe's answer to that is "rewrite in UXP." Do not
  spend time on a CEP port.

UXP is reported working on 25.6.2, which is why the manifest declares
`minVersion: 25.6.0`.

**The client's machine must therefore also run 25.6.x.** If she is ever
auto-updated to 26, the plugin stops loading and there is nothing in this
codebase that can fix it.

If a future Premiere release fixes this, that's great — but confirm a
plugin actually loads before assuming it, and don't raise `minVersion`
without testing.

---

## Tech stack & structure

This is a plain UXP plugin — no bundler, no framework needed for a project
this size. Do not introduce build tooling (webpack, vite, etc.) unless it
becomes genuinely necessary; keep this simple.

```
reel-builder-plugin/
├── manifest.json       # plugin identity, permissions, host app + min version
├── index.html          # panel UI markup
├── index.js            # UI wiring + Premiere UXP DOM calls (the actual logic)
├── styles.css           # panel look and feel
├── README.md            # setup + how to load in UDT
├── CLAUDE.md             # this file
└── backups/              # see backup policy below — gitignored, local only
```

Reference the official `@adobe/premierepro` TypeScript declarations for
correct method/property names — don't guess at the UXP DOM API surface,
verify against the installed Premiere version (25.6+ minimum) as you go.

---

## Git / version control setup

This repo is the single source of truth for the plugin files. The client's
machine runs the plugin in **dev/unpacked mode** via the UXP Developer
Tool (UDT), which watches a local folder — so the workflow is:

1. This repo lives in a synced folder on Dan's machine (his normal dev
   workflow) and ALSO gets synced to the client's machine via a shared
   Dropbox/Drive/OneDrive folder that mirrors the repo's working directory.
   (Git itself is not being asked of the client — she never touches a
   terminal. The sync folder handles getting updated files to her machine;
   git is for Dan's own history/rollback/branching.)
2. Standard git hygiene:
   - Meaningful commit messages, one logical change per commit
   - `.gitignore` should exclude `backups/`, any `.DS_Store`/`Thumbs.db`,
     and never commit real client watermark/media assets — use a clearly
     labeled placeholder asset in the repo instead
   - Tag stable, client-tested versions (e.g. `v0.1-first-successful-build`)
     so we can always roll back to a known-good state
3. Set up the repo with a clean initial commit containing this file, a
   `.gitignore`, and a stub `README.md` before any plugin code is written.

---

## Coding conventions — follow these exactly

- **Verbose debug logging everywhere.** Every meaningful step (clip
  selected, sequence duplicated, placeholder replaced, render triggered,
  validation failed, etc.) should log a clear, readable line explaining
  what just happened and why. Assume Dan will be reading these logs to
  understand what the plugin did, not just whether it crashed.
- **Colored console output where the environment allows it.** This is a
  JS/UXP project, not Python, so `colorama` doesn't apply directly here —
  but replicate the spirit of it: use `console.log` with CSS-style `%c`
  color formatting (or a small helper function) so INFO/WARN/ERROR/SUCCESS
  log lines are visually distinct in the UXP debug console. If any
  auxiliary Python tooling gets written for this project (e.g. a helper
  script outside the plugin itself), use `colorama` there as usual.
- **Backups before edits.** Before modifying any existing file in this
  project, copy the current version to `backups/<filename>_<YYYYMMDD_HHMMSS>.ext`
  first. Never overwrite without a backup.
- **Only touch the section being worked on.** Don't refactor, "clean up,"
  or restructure unrelated code while making a change. If you notice
  something that could be improved elsewhere, mention it separately rather
  than changing it inline.
- **Don't drop or "optimize" code unless explicitly asked.** No silent
  removal of code that looks unused, no collapsing/simplifying logic on
  your own initiative. If something looks wrong, flag it and ask rather
  than fixing it unprompted.
- **Explain as you go.** Comments in the code and explanations in your
  responses should assume the reader (Dan) is a strong scripter but not a
  professional software engineer and has never worked with Adobe's UXP API
  before. Don't assume familiarity with Premiere's object model — name
  things plainly (e.g. "this duplicates the sequence so we never touch the
  original template" rather than just calling the method with no context).

---

## UI elements (panel layout)

- Client display name field (used for the duplicated sequence name, e.g. "ClientName_2026-07-12")
- Intro text field
- Outro text field
- Product clip picker (multi-select, no maximum — typically 6–10 files)
- Watermark asset picker (defaults to the client's saved asset if already configured)
- "Keep original audio" toggle (default: ON)
- Timing summary — plain text readout of estimated total runtime once clips are picked, before build
- "Validate Setup" button — runs all validation checks and reports pass/fail in plain language, without building anything
- "Build & Render" button — runs validation, then executes the full build if validation passes

---

## QA checklist (test all of these before calling any version "done")

- [ ] Build with 6 clips
- [ ] Build with 10 clips
- [ ] Build with more than 10 clips — test with 12 (should build, NOT block)
- [ ] Build with empty intro text (should block)
- [ ] Build with an offline/missing clip (should warn, still allow build)
- [ ] Build with a landscape (non-vertical) clip mixed in (should warn, still allow build)
- [ ] Build with no watermark configured (should block)
- [ ] Build when master sequence is missing/renamed (should fail loudly, not silently create a blank sequence)
- [ ] Confirm watermark stays visible for full runtime regardless of final clip count/duration
- [ ] Confirm master sequence is untouched after multiple builds in a row

---

## Explicitly out of scope for this version

Do not build these unless separately asked:
- Stabilization / Warp Stabilizer automation
- Audio cleanup automation
- Any fixed/forced total duration logic
- Music track handling
- Adobe Marketplace packaging/listing — this stays as an internal dev-mode
  plugin loaded via UDT, not published anywhere

---

## First task

Set up the repo structure exactly as shown above, initialize git with a
clean first commit, and produce a first-draft `manifest.json` targeting
Premiere Pro (`premierepro`, minVersion `25.6.0`). Stop there and report
back before writing any `index.js` logic — confirm the manifest and repo
structure look right before moving on to the actual sequence-building code.
