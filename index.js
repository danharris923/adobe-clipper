/* =====================================================================
 * Client Reel Builder — main logic
 * =====================================================================
 *
 * WHAT THIS DOES, IN ONE PARAGRAPH
 * Finds a hand-built "master" sequence in the open Premiere project,
 * makes a copy of it, and builds the reel on the copy: opening card,
 * then every clip end to end at its full length, then closing card, with
 * a short dissolve at each join and the watermark stretched across the
 * whole thing. Then it hands the finished sequence to Adobe Media Encoder.
 * The master itself is never modified.
 *
 * THINGS TO KNOW BEFORE READING THE CODE
 *
 * 1. `require("premierepro")` gives you the Premiere API object. Almost
 *    everything on it is async and returns a Promise, so there's `await`
 *    everywhere.
 *
 * 2. Premiere will not let you change a project directly. Instead you
 *    *describe* a change as an "Action", collect your Actions into a
 *    "compound action", and hand the whole bundle to
 *    `project.executeTransaction(...)`. Premiere then applies them as a
 *    single undoable step — one Ctrl+Z undoes the entire build, which is
 *    exactly what we want. That's why you'll see this shape over and over:
 *
 *        project.lockedAccess(() => {
 *          project.executeTransaction((compound) => {
 *            compound.addAction(someAction);
 *          }, "Label shown in the undo menu");
 *        });
 *
 *    `lockedAccess` freezes the project so nothing shifts under us while
 *    we're reading and writing. Actions built outside a transaction tend
 *    to fail with unhelpful errors, so keep them inside.
 *
 * 3. Time is a `TickTime`, not a number of seconds. Premiere counts in
 *    "ticks" (254016000000 per second) so that any frame rate divides
 *    evenly and rounding never drifts. Build them with
 *    `TickTime.createWithSeconds(n)` and read them back with `.seconds`.
 *
 * 4. Track indexes are ZERO-BASED. Video track index 0 is what the UI
 *    calls V1. This trips everyone up once.
 * ===================================================================== */

const ppro = require("premierepro");
const uxp = require("uxp");


/* =====================================================================
 * SECTION 1 — Logging
 * =====================================================================
 * Every meaningful step logs a line. Open the debug console in the UXP
 * Developer Tool (⋯ → Debug) to watch a build happen.
 *
 * UXP's console supports the `%c` CSS trick, so we colour-code by
 * severity — the same idea as colorama in Python, just a different
 * mechanism. Scanning for a red line in a wall of grey is much faster
 * than reading every line.
 */

const LOG_STYLES = {
  step:    "color:#8ab4f8; font-weight:bold",  // a new phase of the build
  info:    "color:#b0b0b0",                    // routine detail
  success: "color:#5aa85a; font-weight:bold",  // something worked
  warn:    "color:#d4a13c; font-weight:bold",  // odd, but not fatal
  error:   "color:#d45c5c; font-weight:bold",  // the build is over
};

function log(level, message, detail) {
  const tag = level.toUpperCase().padEnd(7);
  const style = LOG_STYLES[level] || LOG_STYLES.info;
  if (detail === undefined) {
    console.log(`%c[${tag}] ${message}`, style);
  } else {
    console.log(`%c[${tag}] ${message}`, style, detail);
  }
}

const logStep    = (m, d) => log("step", m, d);
const logInfo    = (m, d) => log("info", m, d);
const logSuccess = (m, d) => log("success", m, d);
const logWarn    = (m, d) => log("warn", m, d);
const logError   = (m, d) => log("error", m, d);


/* =====================================================================
 * SECTION 2 — Settings you might want to tune
 * ===================================================================== */

// How long the dissolve at each join lasts, in frames (30fps ⇒ 10 = 1/3 s).
// A dissolve has to "borrow" frames from the clips on either side of the
// cut, so a longer dissolve eats more of your footage. 10 frames is enough
// to stop the cut feeling abrupt without reading as a deliberate effect.
// This is the one number to change if the transitions feel wrong.
const TRANSITION_FRAMES = 10;

// How long each text card sits on screen.
const CARD_SECONDS = 2.5;

// The sequence is 30fps (that comes from the master, we don't set it here).
// We only need the number to convert frames → seconds for the dissolve.
const SEQUENCE_FPS = 30;

/* The track layout the master sequence MUST have.
 *
 * Remember these are zero-based, so:
 *   video track 0 = V1 → the cards and the clips, laid end to end
 *   video track 1 = V2 → the watermark, alone, so nothing can cover it
 *   audio track 0 = A1 → the clips' own sound
 *
 * The watermark gets its own track precisely so that no matter how many
 * clips get added or how long they are, nothing can ever land on top of it.
 */
const VIDEO_TRACK_CONTENT = 0;
const VIDEO_TRACK_WATERMARK = 1;
const AUDIO_TRACK_CONTENT = 0;


/* =====================================================================
 * SECTION 3 — Panel state
 * =====================================================================
 * `settings` are the once-per-machine choices; they survive a restart via
 * localStorage. `clips` is the running order, rebuilt on every pick.
 */

const SETTINGS_KEY = "reelBuilder.settings";

let settings = {
  masterName: "MASTER",
  watermarkPath: "",
  introMogrtPath: "",
  outroMogrtPath: "",
  presetPath: "",
  outputFolder: "",
};

// Each entry: { path, name, seconds, offline, vertical }
// `seconds` etc. start unknown and get filled in once Premiere has
// actually looked at the file (see inspectClips).
let clips = [];

function loadSettings() {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      settings = Object.assign(settings, JSON.parse(saved));
      logInfo("Loaded saved setup from last time.", settings);
    }
  } catch (err) {
    logWarn(`Couldn't read saved setup, starting fresh: ${err}`);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    logInfo("Setup saved.");
  } catch (err) {
    logWarn(`Couldn't save setup: ${err}`);
  }
}


/* =====================================================================
 * SECTION 4 — Talking to the client
 * =====================================================================
 * Two separate channels, on purpose:
 *   - the debug console gets the technical truth (logInfo etc.)
 *   - the panel gets plain English, no jargon, no stack traces
 * She should never need to open a console to understand what happened.
 */

const $ = (id) => document.getElementById(id);

function clearStatus() {
  $("status").innerHTML = "";
}

function say(kind, message) {
  const div = document.createElement("div");
  div.className = `msg ${kind}`;   // ok | warn | err | busy
  div.textContent = message;
  $("status").appendChild(div);
}


/* =====================================================================
 * SECTION 5 — Small helpers
 * ===================================================================== */

// TickTime from a plain number of seconds.
const secondsToTime = (s) => ppro.TickTime.createWithSeconds(s);

// How long the dissolve is, expressed in seconds.
const transitionSeconds = () => TRANSITION_FRAMES / SEQUENCE_FPS;

// "94" → "1m 34s". The client sees this, so it reads like English.
function humanDuration(totalSeconds) {
  const whole = Math.round(totalSeconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  if (mins === 0) return `${secs} seconds`;
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

// Windows and Premiere disagree about slashes, and Premiere sometimes
// hands paths back with different casing than you gave it. Normalising
// before comparing saves a lot of "why didn't it find my file" confusion.
const normalisePath = (p) => (p || "").replace(/\\/g, "/").toLowerCase();

// A filename-safe version of whatever she typed, for the sequence name.
const safeName = (s) => (s || "").trim().replace(/[\\/:*?"<>|]/g, "-");

// Today as 2026-07-12.
function todayStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}


/* =====================================================================
 * SECTION 6 — Finding things in the Premiere project
 * ===================================================================== */

async function getProject() {
  const project = await ppro.Project.getActiveProject();
  if (!project) {
    logError("No Premiere project is open.");
    return null;
  }
  logInfo(`Active project: ${project.name}`);
  return project;
}

/**
 * Find the master sequence by name.
 *
 * Deliberately case-insensitive and whitespace-tolerant, because "MASTER"
 * vs "Master " is not a mistake worth failing a build over. But if there's
 * no match at all we return null and the caller aborts loudly — we must
 * NEVER quietly build a fresh blank sequence instead, because then the
 * watermark, the format and the track layout would all silently vanish and
 * the client would get a broken video with no idea why.
 */
async function findMasterSequence(project, wantedName) {
  const sequences = await project.getSequences();
  const wanted = (wantedName || "").trim().toLowerCase();

  logInfo(
    `Looking for a sequence called "${wantedName}" among ${sequences.length} in the project.`,
    sequences.map((s) => s.name)
  );

  const match = sequences.find((s) => s.name.trim().toLowerCase() === wanted);
  if (!match) {
    logError(`No sequence named "${wantedName}" exists in this project.`);
    return null;
  }
  logSuccess(`Found the master sequence: "${match.name}"`);
  return match;
}

/**
 * Copy the master sequence, and hand back the copy.
 *
 * This is the heart of the "never touch the master" rule.
 *
 * The awkward bit: `createCloneAction()` makes the copy, but it doesn't
 * tell us *which* sequence the copy is — it returns nothing useful. So we
 * take a note of every sequence's GUID beforehand, clone, then look again
 * and find the GUID that wasn't there before. That's the copy.
 *
 * We could instead look for a sequence named "MASTER Copy", but that name
 * changes with Premiere's language, and gets a "2" stuck on the end if a
 * copy already exists. GUIDs don't lie.
 */
async function cloneSequence(project, master) {
  const before = new Set((await project.getSequences()).map((s) => s.guid));
  logInfo(`Project has ${before.size} sequences before the copy.`);

  let ok = false;
  project.lockedAccess(() => {
    ok = project.executeTransaction((compound) => {
      compound.addAction(master.createCloneAction());
    }, "Copy master sequence for reel build");
  });

  if (!ok) {
    logError("Premiere refused to copy the master sequence.");
    return null;
  }

  const after = await project.getSequences();
  const fresh = after.find((s) => !before.has(s.guid));
  if (!fresh) {
    logError("The copy was made but we can't find it — aborting rather than guessing.");
    return null;
  }

  logSuccess(`Copied the master. Working on the copy from here on: "${fresh.name}"`);
  return fresh;
}

/**
 * Rename the copy to something like "Acme Skincare_2026-07-12".
 *
 * A sequence is also a project item (the thing in the Project panel), and
 * it's the project item that carries the name. Renaming is cosmetic — if
 * it fails we log it and carry on rather than throwing away a good build.
 */
async function renameSequence(project, sequence, newName) {
  try {
    const item = await sequence.getProjectItem();
    let ok = false;
    project.lockedAccess(() => {
      ok = project.executeTransaction((compound) => {
        compound.addAction(item.createSetNameAction(newName));
      }, "Name the new reel sequence");
    });
    if (ok) logSuccess(`Named the new sequence "${newName}".`);
    else logWarn(`Couldn't rename the sequence — it'll keep Premiere's default name.`);
  } catch (err) {
    logWarn(`Couldn't rename the sequence (harmless): ${err}`);
  }
}

/**
 * Import files and hand back the matching project items.
 *
 * `importFiles` only returns true/false — it doesn't give you the items it
 * created. So afterwards we walk the project's root folder and match on the
 * file path on disk. Matching on path rather than name matters: two clips
 * in different folders can easily both be called "final.mp4".
 *
 * Re-importing a file Premiere already has is harmless; it won't duplicate.
 */
async function importAndFind(project, paths) {
  if (paths.length === 0) return new Map();

  logStep(`Importing ${paths.length} file(s) into the project…`);
  const root = await project.getRootItem();

  const ok = await project.importFiles(
    paths,
    true,   // suppressUI — don't pop dialogs at the client
    root,   // drop them in the project root
    false   // not an image sequence
  );
  if (!ok) logWarn("Premiere reported the import as unsuccessful — checking anyway.");

  // Now find them. getItems() is the top level only, which is where we
  // just put everything, so a flat walk is enough.
  const items = await root.getItems();
  const found = new Map();   // normalised path → ClipProjectItem
  const wanted = new Set(paths.map(normalisePath));

  for (const item of items) {
    const clipItem = ppro.ClipProjectItem.cast(item);
    if (!clipItem) continue;                 // folders, sequences, etc.
    try {
      const media = await clipItem.getMediaFilePath();
      const key = normalisePath(media);
      if (wanted.has(key)) found.set(key, clipItem);
    } catch {
      // Sequences and other non-media items throw here. Not interesting.
    }
  }

  for (const p of paths) {
    if (!found.has(normalisePath(p))) logWarn(`Couldn't find "${p}" after import.`);
  }

  logSuccess(`Located ${found.size} of ${paths.length} file(s) in the project.`);
  return found;
}


/* =====================================================================
 * SECTION 7 — Inspecting the chosen clips
 * =====================================================================
 * We need each clip's true length (to know where the next one starts, and
 * to show the runtime readout) and its shape (to warn about landscape
 * footage). Both mean importing the files first — the length lives in the
 * media, not in the filename.
 */

/**
 * The clip's full, native length.
 *
 * A project item has an in point and an out point. Untouched, they sit at
 * the very start and very end of the media, so out − in is the whole clip.
 * We never move them: the whole point of this plugin is that clips play at
 * their natural length, so we read the length rather than dictate it.
 */
async function getClipSeconds(clipItem) {
  const inPoint = await clipItem.getInPoint(ppro.Constants.MediaType.VIDEO);
  const outPoint = await clipItem.getOutPoint(ppro.Constants.MediaType.VIDEO);
  return outPoint.seconds - inPoint.seconds;
}

/**
 * Is this clip taller than it is wide?
 *
 * There's no direct "give me the resolution" call on a project item, so we
 * read the Project panel's own metadata columns — the same "Video Info"
 * text you'd see in a column in the Project panel, e.g. "1080 x 1920".
 *
 * This is best-effort. If we can't work out the shape we return null, and
 * the caller simply doesn't warn. That's fine: a wrong orientation is only
 * ever a warning, never a reason to block a build, so a missed warning is
 * a much smaller sin than a false alarm.
 */
async function isVertical(clipItem) {
  try {
    const raw = await ppro.Metadata.getProjectColumnsMetadata(clipItem);
    const columns = JSON.parse(raw);
    for (const col of columns) {
      const value = String(col.ColumnValue || "");
      const match = value.match(/(\d{2,5})\s*[x×]\s*(\d{2,5})/i);
      if (match) {
        const width = Number(match[1]);
        const height = Number(match[2]);
        logInfo(`Clip is ${width}x${height}.`);
        return height > width;
      }
    }
    logInfo("Couldn't read this clip's dimensions — skipping the shape check.");
    return null;
  } catch (err) {
    logInfo(`Couldn't read this clip's dimensions (${err}) — skipping the shape check.`);
    return null;
  }
}

/**
 * Import the chosen clips and fill in what we now know about each one:
 * how long it is, whether it's offline, whether it's vertical.
 *
 * Called after picking clips (to show the runtime readout), and again by
 * validation and by the build. It's cheap to repeat.
 */
async function inspectClips(project) {
  const found = await importAndFind(project, clips.map((c) => c.path));

  for (const clip of clips) {
    const item = found.get(normalisePath(clip.path));
    if (!item) {
      clip.offline = true;
      clip.seconds = 0;
      logWarn(`"${clip.name}" isn't in the project — treating it as missing.`);
      continue;
    }

    clip.item = item;
    clip.offline = await item.isOffline();
    if (clip.offline) {
      logWarn(`"${clip.name}" is offline — Premiere can see the clip but not the file.`);
    }

    clip.seconds = await getClipSeconds(item);
    clip.vertical = await isVertical(item);
    logInfo(`"${clip.name}" — ${clip.seconds.toFixed(2)}s, vertical: ${clip.vertical}`);
  }

  return clips.every((c) => !!c.item);
}


/* =====================================================================
 * SECTION 8 — Runtime readout
 * =====================================================================
 * Purely informational, shown before building so she isn't surprised.
 *
 * Note this is an ESTIMATE, and it says so. Each dissolve overlaps two
 * clips, so it *removes* roughly its own length from the running time —
 * we account for that here, but Premiere makes the final call about
 * exactly how many frames it can borrow at each join.
 */

function updateRuntime() {
  const el = $("runtime");

  if (clips.length === 0) {
    el.textContent = "Choose some clips to see how long the video will be.";
    return;
  }

  const unknown = clips.some((c) => c.seconds === undefined);
  if (unknown) {
    el.textContent = `${clips.length} clips chosen. Checking how long they are…`;
    return;
  }

  const clipTotal = clips.reduce((sum, c) => sum + (c.seconds || 0), 0);
  const cards = CARD_SECONDS * 2;

  // One join before each clip, plus one before the closing card.
  const joins = clips.length + 1;
  const lost = joins * transitionSeconds();

  const total = Math.max(0, clipTotal + cards - lost);

  el.textContent =
    `${clips.length} clips · about ${humanDuration(total)} in total ` +
    `(including the two ${CARD_SECONDS}s cards).`;

  logInfo(
    `Runtime estimate: clips ${clipTotal.toFixed(1)}s + cards ${cards}s ` +
    `− ${joins} dissolves (${lost.toFixed(1)}s) = ${total.toFixed(1)}s`
  );
}


/* =====================================================================
 * SECTION 9 — Validation
 * =====================================================================
 * Returns { blocks, warns } — both arrays of plain-English sentences.
 * A `block` stops the build. A `warn` is shown and the build continues.
 *
 * Note there is deliberately NO upper limit on the number of clips.
 */

async function validate() {
  const blocks = [];
  const warns = [];

  logStep("Checking the setup…");

  const project = await ppro.Project.getActiveProject();
  if (!project) {
    blocks.push("Premiere doesn't have a project open. Open your project first.");
    return { blocks, warns, project: null };   // nothing else is checkable
  }

  if (!$("introText").value.trim()) {
    blocks.push("The opening text is empty. Type what the first card should say.");
  }

  if (!settings.watermarkPath) {
    blocks.push("No watermark image is set. Open Setup and choose one.");
  }

  if (!settings.introMogrtPath || !settings.outroMogrtPath) {
    blocks.push("The opening and closing card templates aren't set. Open Setup and choose them.");
  }

  if (clips.length === 0) {
    blocks.push("No clips chosen. Pick the videos you want in the reel.");
  }

  const master = await findMasterSequence(project, settings.masterName);
  if (!master) {
    blocks.push(
      `Can't find a sequence called "${settings.masterName}" in this project. ` +
      `Check the name in Setup matches the sequence in Premiere exactly.`
    );
  } else {
    // The master has to have somewhere to put the watermark.
    const trackCount = await master.getVideoTrackCount();
    if (trackCount < VIDEO_TRACK_WATERMARK + 1) {
      blocks.push(
        `The master sequence only has ${trackCount} video track(s). ` +
        `It needs at least ${VIDEO_TRACK_WATERMARK + 1} — one for the clips, one for the watermark.`
      );
    }
  }

  // Clip-level checks need the clips imported, which is only worth doing
  // if we actually have some and a project to put them in.
  if (clips.length > 0) {
    await inspectClips(project);

    const missing = clips.filter((c) => c.offline);
    if (missing.length > 0) {
      warns.push(
        `${missing.length} clip(s) look like they've been moved or deleted: ` +
        `${missing.map((c) => c.name).join(", ")}. The reel will still build, ` +
        `but those parts may come out blank.`
      );
    }

    const sideways = clips.filter((c) => c.vertical === false);
    if (sideways.length > 0) {
      warns.push(
        `${sideways.length} clip(s) are wider than they are tall: ` +
        `${sideways.map((c) => c.name).join(", ")}. They'll still be used, ` +
        `but they'll have black bars above and below.`
      );
    }
  }

  if (blocks.length === 0) logSuccess("All checks passed.");
  else logError(`${blocks.length} problem(s) would stop the build.`, blocks);
  if (warns.length > 0) logWarn(`${warns.length} thing(s) worth knowing.`, warns);

  return { blocks, warns, project };
}


/* =====================================================================
 * SECTION 10 — Building the reel
 * ===================================================================== */

/**
 * Drop a text card on the timeline and type the words into it.
 *
 * The cards are .mogrt files (Motion Graphics Templates) — designed once in
 * Premiere's Essential Graphics panel and exported. That matters because a
 * .mogrt exposes its text as a *parameter* we can set from code, which a
 * hand-drawn text layer does not.
 *
 * Getting to that parameter means walking down through the clip on the
 * timeline: track item → its component chain (the stack of effects and
 * graphics on it) → each component → each of that component's parameters.
 * We set the first parameter that takes text.
 *
 * Every parameter name we find gets logged. If the text ever lands in the
 * wrong place, that log tells you exactly what the .mogrt is exposing.
 */
async function insertCard(project, sequence, mogrtPath, text, atSeconds) {
  logStep(`Adding a text card at ${atSeconds.toFixed(1)}s: "${text}"`);

  const editor = ppro.SequenceEditor.getEditor(sequence);
  let items = [];

  project.lockedAccess(() => {
    items = editor.insertMogrtFromPath(
      mogrtPath,
      secondsToTime(atSeconds),
      VIDEO_TRACK_CONTENT,
      -1                       // no audio track — a text card is silent
    );
  });

  if (!items || items.length === 0) {
    throw new Error(`Premiere couldn't add the card from ${mogrtPath}`);
  }
  const card = items[0];
  logInfo("Card added to the timeline.");

  // --- make it the right length ---------------------------------------
  const end = secondsToTime(atSeconds + CARD_SECONDS);
  project.lockedAccess(() => {
    project.executeTransaction((compound) => {
      compound.addAction(card.createSetEndAction(end));
    }, "Set text card length");
  });
  logInfo(`Card set to ${CARD_SECONDS}s long.`);

  // --- type the words into it ------------------------------------------
  try {
    const chain = await card.getComponentChain();
    const componentCount = await chain.getComponentCount();
    let done = false;

    for (let c = 0; c < componentCount && !done; c++) {
      const component = await chain.getComponentAtIndex(c);
      const paramCount = await component.getParamCount();

      for (let p = 0; p < paramCount && !done; p++) {
        const param = await component.getParam(p);
        logInfo(`  .mogrt exposes a parameter: "${param.displayName}"`);

        // Only text parameters accept a string. Ask what's in there now:
        // if it's currently a string, it's a text field.
        let current;
        try {
          current = await param.getValueAtTime(ppro.TickTime.TIME_ZERO);
        } catch {
          continue;   // not readable — not our field
        }
        if (typeof current !== "string") continue;

        project.lockedAccess(() => {
          project.executeTransaction((compound) => {
            const keyframe = param.createKeyframe(text);
            compound.addAction(param.createSetValueAction(keyframe, true));
          }, "Set text card wording");
        });
        logSuccess(`Typed the words into "${param.displayName}".`);
        done = true;
      }
    }

    if (!done) {
      logWarn(
        "Couldn't find a text field in this .mogrt — the card will show its " +
        "default wording. Check the parameter names logged just above."
      );
    }
  } catch (err) {
    logWarn(`Couldn't set the card's text (${err}) — it'll show its default wording.`);
  }

  return card;
}

/**
 * Lay the clips down end to end, each at its full natural length.
 *
 * We use OVERWRITE rather than INSERT. Insert ripples — it shoves
 * everything after it further down the timeline, and that would drag the
 * watermark along with it. Overwrite drops the clip exactly where we say
 * and touches nothing else. Since we're placing each clip at a spot we
 * computed ourselves, and nothing is ever there already, overwrite is both
 * safer and more predictable.
 *
 * The running `playhead` is just bookkeeping: "clip 3 starts where clip 2
 * ended". We are not deciding how long anything is — each clip's length
 * comes from the clip itself.
 */
async function layClips(project, sequence, startSeconds) {
  const editor = ppro.SequenceEditor.getEditor(sequence);
  const keepAudio = $("keepAudio").checked;
  let playhead = startSeconds;

  logStep(`Laying ${clips.length} clips end to end from ${startSeconds.toFixed(1)}s…`);

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    if (!clip.item) {
      logWarn(`Skipping "${clip.name}" — it isn't in the project.`);
      continue;
    }

    let ok = false;
    project.lockedAccess(() => {
      ok = project.executeTransaction((compound) => {
        compound.addAction(
          editor.createOverwriteItemAction(
            clip.item,
            secondsToTime(playhead),
            VIDEO_TRACK_CONTENT,
            keepAudio ? AUDIO_TRACK_CONTENT : -1   // -1 = don't place audio
          )
        );
      }, `Add clip ${i + 1}`);
    });

    if (!ok) throw new Error(`Premiere wouldn't place "${clip.name}" on the timeline.`);

    logInfo(
      `  ${i + 1}/${clips.length} "${clip.name}" at ${playhead.toFixed(2)}s ` +
      `(runs ${clip.seconds.toFixed(2)}s)`
    );
    playhead += clip.seconds;
  }

  logSuccess(`Clips laid down. Timeline now runs to ${playhead.toFixed(1)}s.`);
  return playhead;
}

/**
 * Soften every join with a short dissolve.
 *
 * A dissolve is added to the *start* of a clip, and it blends that clip
 * with whatever is immediately before it. So we walk the track and add one
 * to the start of every item except the very first — the opening card has
 * nothing before it to dissolve from.
 *
 * The honest caveat: a dissolve needs frames to work with, and we're using
 * every clip at its full length, so there are no spare frames past the
 * ends. Premiere resolves this by pulling the clips slightly into each
 * other. That's why the finished reel comes out a little shorter than the
 * clips added together, and it's why the runtime readout calls itself an
 * estimate. A failed transition is not worth killing a good build over, so
 * each one is attempted independently and a failure is only a warning.
 */
async function addTransitions(project, sequence) {
  logStep("Adding a short dissolve to each join…");

  const matchNames = await ppro.TransitionFactory.getVideoTransitionMatchNames();
  const dissolve = matchNames.find((n) => /cross\s*dissolve/i.test(n)) || matchNames[0];
  logInfo(`Using the transition "${dissolve}".`);

  const track = await sequence.getVideoTrack(VIDEO_TRACK_CONTENT);
  const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  logInfo(`${items.length} items on the timeline to join up.`);

  const options = ppro.AddTransitionOptions();
  options.setApplyToStart(true);                       // blend with what's before it
  options.setDuration(secondsToTime(transitionSeconds()));

  let added = 0;
  for (let i = 1; i < items.length; i++) {            // from 1: skip the first item
    try {
      const transition = await ppro.TransitionFactory.createVideoTransition(dissolve);
      let ok = false;
      project.lockedAccess(() => {
        ok = project.executeTransaction((compound) => {
          compound.addAction(items[i].createAddVideoTransitionAction(transition, options));
        }, "Add dissolve");
      });
      if (ok) added++;
      else logWarn(`  Join ${i} wouldn't take a dissolve — leaving it as a hard cut.`);
    } catch (err) {
      logWarn(`  Join ${i} wouldn't take a dissolve (${err}) — leaving it as a hard cut.`);
    }
  }

  logSuccess(`Added ${added} dissolve(s) out of ${items.length - 1} joins.`);
}

/**
 * Put the watermark on its own track and stretch it across everything.
 *
 * This runs LAST, on purpose. The dissolves shorten the timeline slightly,
 * so we can't know the true final length until they're in. By asking the
 * sequence for its own end time at this point, the watermark is guaranteed
 * to span the whole reel no matter how many clips there were or how the
 * transitions landed — which is exactly the requirement.
 */
async function layWatermark(project, sequence, watermarkItem) {
  const end = await sequence.getEndTime();
  logStep(`Stretching the watermark across the full ${end.seconds.toFixed(1)}s.`);

  const editor = ppro.SequenceEditor.getEditor(sequence);

  let ok = false;
  project.lockedAccess(() => {
    ok = project.executeTransaction((compound) => {
      compound.addAction(
        editor.createOverwriteItemAction(
          watermarkItem,
          ppro.TickTime.TIME_ZERO,
          VIDEO_TRACK_WATERMARK,
          -1                                  // an image has no audio
        )
      );
    }, "Add watermark");
  });
  if (!ok) throw new Error("Premiere wouldn't place the watermark.");

  // A still image comes in at whatever default length Premiere fancies
  // (usually 5s), so now stretch it to cover the whole reel.
  const track = await sequence.getVideoTrack(VIDEO_TRACK_WATERMARK);
  const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  if (items.length === 0) throw new Error("The watermark didn't land on its track.");

  project.lockedAccess(() => {
    project.executeTransaction((compound) => {
      compound.addAction(items[0].createSetEndAction(end));
    }, "Stretch watermark to full length");
  });

  logSuccess("Watermark covers the whole reel, on its own track.");
}

/**
 * Hand the finished sequence to Adobe Media Encoder.
 *
 * If no export preset has been set we stop short of rendering and say so —
 * the reel is still built and sitting in Premiere, ready to export by hand.
 * A missing preset shouldn't throw away a good build.
 */
async function render(project, sequence, name) {
  if (!settings.presetPath || !settings.outputFolder) {
    logWarn("No export preset or output folder set — built the reel but not rendering it.");
    say("warn",
      "Your reel is built and open in Premiere, but I didn't render it: " +
      "no export preset or output folder is set in Setup. You can export it " +
      "yourself from File → Export."
    );
    return;
  }

  logStep("Sending the reel to Adobe Media Encoder…");

  const encoder = ppro.EncoderManager.getManager();
  if (!encoder.isAMEInstalled) {
    logWarn("Adobe Media Encoder isn't installed — built the reel but can't render it.");
    say("warn",
      "Your reel is built, but Adobe Media Encoder isn't installed, so I " +
      "couldn't render it. You can export it from File → Export."
    );
    return;
  }

  const item = await sequence.getProjectItem();
  const clipItem = ppro.ClipProjectItem.cast(item);
  const output = `${settings.outputFolder}/${name}.mp4`;

  const queued = await encoder.encodeProjectItem(
    clipItem,
    output,
    settings.presetPath,
    0            // 0 = the whole sequence (not just in/out, not the work area)
  );

  if (queued) {
    await encoder.startBatchEncode();
    logSuccess(`Rendering to ${output}`);
    say("ok", `Rendering your video now. It'll appear here when it's done:\n${output}`);
  } else {
    logError("Media Encoder wouldn't accept the render.");
    say("err",
      "Your reel is built, but Media Encoder wouldn't start the render. " +
      "You can export it yourself from File → Export."
    );
  }
}

/**
 * The whole build, start to finish.
 */
async function build() {
  clearStatus();
  say("busy", "Working… this can take a minute. Don't close Premiere.");

  logStep("═══ BUILD STARTED ═══");

  // 1. Refuse to build anything that wouldn't come out right.
  const { blocks, warns, project } = await validate();

  for (const w of warns) say("warn", w);

  if (blocks.length > 0) {
    clearStatus();
    for (const w of warns) say("warn", w);
    for (const b of blocks) say("err", b);
    say("err", "Nothing was built. Fix the problems above and try again.");
    logError("═══ BUILD STOPPED — validation failed ═══");
    return;
  }

  try {
    // 2. Copy the master. Everything from here happens on the copy.
    const master = await findMasterSequence(project, settings.masterName);
    const sequence = await cloneSequence(project, master);
    if (!sequence) throw new Error("Couldn't copy the master sequence.");

    const name = `${safeName($("clientName").value) || "Reel"}_${todayStamp()}`;
    await renameSequence(project, sequence, name);

    // Make it the sequence on screen, so she can see it being built.
    await project.setActiveSequence(sequence);
    await project.openSequence(sequence);

    // 3. Bring in the watermark. (The clips are already imported —
    //    validation did that so it could measure them.)
    const assets = await importAndFind(project, [settings.watermarkPath]);
    const watermark = assets.get(normalisePath(settings.watermarkPath));
    if (!watermark) throw new Error("Couldn't import the watermark image.");

    // 4. Opening card → clips → closing card, one after another.
    await insertCard(project, sequence, settings.introMogrtPath,
                     $("introText").value.trim(), 0);

    const afterClips = await layClips(project, sequence, CARD_SECONDS);

    await insertCard(project, sequence, settings.outroMogrtPath,
                     $("outroText").value.trim(), afterClips);

    // 5. Soften the joins.
    await addTransitions(project, sequence);

    // 6. Watermark last, once the true length is settled.
    await layWatermark(project, sequence, watermark);

    const finalEnd = await sequence.getEndTime();
    logSuccess(`═══ BUILD FINISHED — "${name}", ${finalEnd.seconds.toFixed(1)}s ═══`);

    clearStatus();
    for (const w of warns) say("warn", w);
    say("ok", `Built "${name}" — ${humanDuration(finalEnd.seconds)} long.`);

    // 7. Render.
    await render(project, sequence, name);

  } catch (err) {
    logError(`═══ BUILD FAILED ═══ ${err}`);
    clearStatus();
    say("err", `Something went wrong and the reel wasn't finished: ${err.message || err}`);
    say("warn",
      "Your master sequence has not been changed. You can safely try again."
    );
  }
}


/* =====================================================================
 * SECTION 11 — The clip list in the panel
 * ===================================================================== */

function renderClipList() {
  const list = $("clipList");
  list.innerHTML = "";

  clips.forEach((clip, i) => {
    const row = document.createElement("li");

    const num = document.createElement("span");
    num.className = "num";
    num.textContent = `${i + 1}.`;

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = clip.name;

    // Order on screen = order in the video, so she needs to be able to
    // shuffle it without re-picking everything.
    const up = document.createElement("button");
    up.textContent = "↑";
    up.disabled = i === 0;
    up.addEventListener("click", () => moveClip(i, -1));

    const down = document.createElement("button");
    down.textContent = "↓";
    down.disabled = i === clips.length - 1;
    down.addEventListener("click", () => moveClip(i, +1));

    const remove = document.createElement("button");
    remove.textContent = "✕";
    remove.addEventListener("click", () => {
      logInfo(`Removed "${clip.name}" from the running order.`);
      clips.splice(i, 1);
      renderClipList();
      updateRuntime();
    });

    row.appendChild(num);
    row.appendChild(name);
    row.appendChild(up);
    row.appendChild(down);
    row.appendChild(remove);
    list.appendChild(row);
  });

  $("clipCount").textContent =
    clips.length === 0
      ? "No clips chosen yet."
      : `${clips.length} clip(s) — they'll play in this order.`;
}

function moveClip(index, direction) {
  const target = index + direction;
  if (target < 0 || target >= clips.length) return;
  [clips[index], clips[target]] = [clips[target], clips[index]];
  logInfo(`Moved "${clips[target].name}" to position ${index + 1}.`);
  renderClipList();
}


/* =====================================================================
 * SECTION 12 — File pickers
 * =====================================================================
 * UXP has no working <input type="file">. Everything goes through
 * uxp.storage.localFileSystem, which hands back file objects. The bit we
 * want is `nativePath` — the real path on disk, which is what Premiere's
 * import and mogrt calls expect.
 */

const fs = uxp.storage.localFileSystem;

async function pickClips() {
  const files = await fs.getFileForOpening({
    allowMultiple: true,
    types: ["mp4", "mov", "m4v", "avi", "mxf", "mpg", "mpeg", "wmv"],
  });
  if (!files || files.length === 0) {
    logInfo("Clip picker closed without choosing anything.");
    return;
  }

  clips = files.map((f) => ({ path: f.nativePath, name: f.name }));
  logSuccess(`${clips.length} clip(s) chosen.`, clips.map((c) => c.name));

  renderClipList();
  updateRuntime();

  // Measure them so the runtime readout is real rather than a guess. This
  // needs a project to import into; if there isn't one, the readout just
  // stays vague until she opens one, which is fine.
  const project = await ppro.Project.getActiveProject();
  if (project) {
    await inspectClips(project);
    updateRuntime();
  } else {
    logWarn("No project open yet, so I can't measure the clips.");
  }
}

async function pickFile(kind, extensions, settingKey, labelId) {
  const file = await fs.getFileForOpening({ types: extensions });
  if (!file) {
    logInfo(`${kind} picker closed without choosing anything.`);
    return;
  }
  settings[settingKey] = file.nativePath;
  $(labelId).textContent = file.nativePath;
  saveSettings();
  logSuccess(`${kind} set: ${file.nativePath}`);
}

async function pickOutputFolder() {
  const folder = await fs.getFolder();
  if (!folder) return;
  settings.outputFolder = folder.nativePath;
  $("outputPath").textContent = folder.nativePath;
  saveSettings();
  logSuccess(`Output folder set: ${folder.nativePath}`);
}


/* =====================================================================
 * SECTION 13 — Wiring it all up
 * ===================================================================== */

function applySettingsToPanel() {
  $("masterName").value = settings.masterName || "MASTER";
  $("watermarkPath").textContent = settings.watermarkPath || "Not set.";
  $("introMogrtPath").textContent = settings.introMogrtPath || "Not set.";
  $("outroMogrtPath").textContent = settings.outroMogrtPath || "Not set.";
  $("presetPath").textContent = settings.presetPath || "Not set.";
  $("outputPath").textContent = settings.outputFolder || "Not set.";
}

function init() {
  logStep("Client Reel Builder loaded.");

  loadSettings();
  applySettingsToPanel();
  renderClipList();
  updateRuntime();

  $("pickClips").addEventListener("click", pickClips);

  $("pickWatermark").addEventListener("click", () =>
    pickFile("Watermark", ["png", "jpg", "jpeg", "psd", "ai", "tif", "tiff"],
             "watermarkPath", "watermarkPath"));

  $("pickIntroMogrt").addEventListener("click", () =>
    pickFile("Opening card", ["mogrt"], "introMogrtPath", "introMogrtPath"));

  $("pickOutroMogrt").addEventListener("click", () =>
    pickFile("Closing card", ["mogrt"], "outroMogrtPath", "outroMogrtPath"));

  $("pickPreset").addEventListener("click", () =>
    pickFile("Export preset", ["epr"], "presetPath", "presetPath"));

  $("pickOutput").addEventListener("click", pickOutputFolder);

  $("masterName").addEventListener("change", (e) => {
    settings.masterName = e.target.value.trim();
    saveSettings();
  });

  // "Check my setup" runs exactly the same checks as the build, but stops
  // before touching anything. Same code path, so it can't drift out of sync
  // with what the build actually does.
  $("validate").addEventListener("click", async () => {
    clearStatus();
    say("busy", "Checking…");

    const { blocks, warns } = await validate();

    clearStatus();
    for (const w of warns) say("warn", w);
    for (const b of blocks) say("err", b);

    if (blocks.length === 0) {
      say("ok", warns.length === 0
        ? "Everything looks good. You're ready to build."
        : "Good enough to build — have a read of the notes above first.");
    } else {
      say("err", "Fix the problems above, then check again.");
    }
  });

  $("build").addEventListener("click", async () => {
    $("build").disabled = true;
    try {
      await build();
    } finally {
      $("build").disabled = false;   // always re-enable, even after a crash
    }
  });

  logSuccess("Panel ready.");
}

init();
