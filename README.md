# Client Reel Builder — Premiere Pro UXP Plugin

A Premiere Pro panel that builds a branded vertical product reel from a
handful of clips. The client picks her clips, types the intro and outro
text, and clicks one button — the plugin duplicates a pre-built master
sequence, lays the clips in, and triggers the render.

Status: **first build written, not yet tested against Premiere.**

---

## Requires Premiere Pro 25.6.x — not 26

Premiere 26 does not load plugins. Not this one, not Adobe's own sample
one, not the older CEP kind either. UDT connects and validates the plugin
fine, then the load silently times out. Install **Premiere Pro 25.6** from
the Creative Cloud desktop app (Premiere Pro → **⋯** → **Other Versions**).

This applies to the client's machine too. If she updates to 26, the panel
stops appearing.

---

## One-time setup in Premiere (do this before loading the plugin)

The plugin doesn't invent the look of the reel — it assembles pieces you
build by hand, once. There are three of them.

### 1. The master sequence

Make a sequence in your Premiere project, name it `MASTER` (any name works,
as long as it matches the name in the panel's Setup drawer), and set it to
**1080×1920, 30fps**.

Give it **two video tracks and one audio track**, and leave them empty:

| Track | What the plugin puts there |
|-------|----------------------------|
| V1 | opening card → your clips → closing card, end to end |
| V2 | the watermark, stretched across the whole reel |
| A1 | the clips' own sound |

The plugin **copies** this sequence on every build and works on the copy.
The master is never modified. If it can't find the master by name, the
build stops with an error rather than quietly building something wrong.

### 2. The two text cards (`.mogrt` files)

Design the opening card in Premiere's **Essential Graphics** panel — font,
colour, background, animation, however you want it — with a text layer for
the wording. Then **Export as Motion Graphics Template** to a `.mogrt` file.
Do the same for the closing card.

The reason it's a `.mogrt` rather than a layer inside the master: a `.mogrt`
exposes its text as a parameter that the plugin can actually set. A
hand-drawn text layer doesn't, and there's no way to reach into one from a
plugin. This also means you can restyle the cards any time by re-exporting
the `.mogrt` — no code change needed.

*If the client's words end up in the wrong text layer,* open the debug
console — the plugin logs every parameter the `.mogrt` exposes, by name.

### 3. An export preset (`.epr`)

In Premiere, set up an export the way you want it (H.264, vertical) and save
the settings as a preset. That writes an `.epr` file. Point the panel at it
in the Setup drawer.

This one is optional. Without it the reel is still built and left open in
Premiere — only the automatic render is skipped.

---

## What it does (once built)

- Output is 1080×1920 vertical, 30fps
- Runtime floats — clips play at their full native length, nothing is
  trimmed or stretched to hit a target duration
- Intro text card → product clips (cross-dissolve between each) → outro
  text card
- Watermark sits on its own track, bottom-right, for the whole runtime
- Original clip audio is kept by default; there's a toggle to mute it

Every build works on a **duplicate** of the master sequence. The master
itself is never touched.

---

## Setup (Dan)

```
git clone https://github.com/danharris923/adobe-clipper.git
```

There's no build step and no dependencies — it's a plain UXP plugin. The
files in the repo root *are* the plugin.

## Loading the plugin in Premiere (UDT)

The plugin runs unpacked in dev mode via Adobe's **UXP Developer Tool**
(UDT), which watches a folder on disk and hot-reloads the panel.

1. Install the UXP Developer Tool from the Adobe Creative Cloud desktop app
   (Marketplace tab → search "UXP Developer Tool").
2. Open Premiere Pro (25.6.0 or newer — the plugin declares that as its
   minimum) and leave it running. UDT can only talk to a host app that's
   already open.
3. In UDT, click **Add Plugin** and select this repo's `manifest.json`.
4. The plugin appears in the UDT list. Click **⋯ → Load** to push it into
   Premiere.
5. In Premiere, open it from **Window → Extensions → Client Reel Builder**.

While it's loaded, **⋯ → Watch** makes UDT reload the panel automatically
whenever a file changes, and **⋯ → Debug** opens the dev console — that's
where the plugin's log output shows up.

## Getting updates to the client

The client never touches git or a terminal. Her machine runs the same
files out of a shared sync folder (Dropbox/Drive/OneDrive) that mirrors
this repo's working directory, loaded through UDT the same way. Pushing
updated files to the sync folder is all it takes; git is purely for Dan's
own history and rollback.
