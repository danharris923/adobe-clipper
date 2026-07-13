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

## This is a CEP panel, on Premiere 25.6. Both parts are hard constraints.

**Premiere Pro 25.6.x, CEP (not UXP). Do not "modernise" either.**

The whole of 2026-07-12 was spent discovering this, so don't re-derive it:

**UXP does not work.** Every UXP plugin times out on load — ours, *and
Adobe's own untouched "Create Plugin" starter template*. Tested on 26.3.0,
26.5.0 Beta, and 25.6.6, from both `C:` and `D:`, with developer mode on at
the app level (Preferences → Plugins) and the machine level
(`C:\Program Files\Common Files\Adobe\UXP\Developer\settings.json` =
`{"developer": true}`), on a fresh UDT 2.2.1.2. UDT's `Validate` succeeds
against the host every time; only `Load` fails. Tell-tale sign:
`%APPDATA%\Adobe\UXP` is never created — the UXP host never initialises.

**CEP does work, but only on 25.6.** Proven, not assumed: Premiere's own
Learning Panel is a CEP panel, and there's a live `CEPHtmlEngine12-PPRO-
25.6.6-...` log on disk from it running. Premiere **26** loads neither CEP
nor UXP, so 26 is out entirely.

Consequences that matter:

- A UXP version of this plugin was written and then deleted. If Adobe ever
  fixes UXP, don't start from scratch — it's in git history at commit
  `ec0c027^` (`git show ec0c027^:index.js`). But confirm a plugin actually
  loads before believing any release note.
- **The client's machine must also run 25.6.x**, and Creative Cloud
  auto-update to 26 will silently break the panel. Turning off auto-update
  for Premiere on her machine is part of the handoff, not an optional
  nicety.
- Adobe is retiring CEP. This buys time; it isn't forever.

---

## Tech stack & structure

Plain CEP — no bundler, no framework, no build step. Do not introduce build
tooling (webpack, vite, etc.) unless it becomes genuinely necessary; keep
this simple.

```
adobe-cliper/
├── CSXS/manifest.xml     # CEP extension manifest (the equivalent of UXP's manifest.json)
├── index.html            # panel UI markup
├── css/styles.css        # panel look and feel
├── js/CSInterface.js     # Adobe's bridge library — vendored, do not edit
├── js/main.js            # panel logic: collect input, call the .jsx, show results
├── jsx/reelbuilder.jsx   # ExtendScript — everything that actually touches Premiere
├── install.ps1           # registry flag + junction into Premiere's extensions folder
├── README.md
├── CLAUDE.md             # this file
└── backups/              # backup policy below — gitignored, local only
```

**The split matters.** `js/main.js` runs in a Chromium window and cannot
touch Premiere. `jsx/reelbuilder.jsx` runs inside Premiere and does all the
real work. They talk over `evalScript`, and **everything crossing that
bridge is a string** — hence the JSON encode/decode on both sides.

Two traps that will cost you an hour if you forget them:

- **`reelbuilder.jsx` is ExtendScript: JavaScript frozen around 1999.** No
  `let`/`const`, no arrow functions, no `Array.forEach`, no `JSON`. Modern
  syntax fails with baffling errors. `js/main.js` is a modern browser and
  has none of these limits — the two files look similar and are not.
- **Time units are inconsistent in Premiere's own API.** `overwriteClip()`
  takes SECONDS; `importMGT()` takes TICKS (1/254016000000 s). The `secs()`
  and `ticks()` helpers exist so you never have to remember which. Don't
  "tidy" them into one.

Verify API calls against the Premiere ExtendScript reference
(ppro-scripting.docsforadobe.dev) — don't guess. Transitions are the
exception: they're only reachable via the undocumented **QE DOM**
(`app.enableQE()`), which is isolated in `addTransitions()` precisely
because it's the thing most likely to break in a future Premiere.

---

## Git / version control setup

This repo is the single source of truth for the plugin files. The client's
machine runs the panel **unpacked and unsigned**, straight out of a folder
on disk (`install.ps1` junctions Premiere's extensions folder at it) — so
the workflow is:

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
- Adobe Marketplace packaging/listing — this stays an internal, unsigned
  panel installed by `install.ps1`, not published anywhere
- Signing the extension. Only needed for public distribution; the
  PlayerDebugMode flag covers our case.

---

## Where this stands

The panel is written and installs. **It has never been run against
Premiere** — the entire QA checklist above is still outstanding, and the
sequence-building logic has never executed once.

The two things most likely to need fixing on a first real build:

1. **The `.mogrt` text landing in the wrong layer.** Premiere exposes a
   template's parameters under whatever names *you* gave the layers, which
   the code can't know in advance — so it takes the first text parameter it
   finds and logs every parameter name it sees. If the wording lands
   somewhere odd, that log names the right target.
2. **The QE DOM transitions.** Undocumented and version-sensitive. Failure
   there is designed to be non-fatal: hard cuts and a warning, not a dead
   build.

Before any of it can run, these must exist in the Premiere project (see
README): the `MASTER` sequence, and the two `.mogrt` cards.
