# Client Reel Builder — Premiere Pro UXP Plugin

A Premiere Pro panel that builds a branded vertical product reel from a
handful of clips. The client picks her clips, types the intro and outro
text, and clicks one button — the plugin duplicates a pre-built master
sequence, lays the clips in, and triggers the render.

Status: **scaffolding.** No plugin logic written yet.

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
