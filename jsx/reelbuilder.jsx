/* =====================================================================
 * Client Reel Builder — ExtendScript host
 * =====================================================================
 *
 * This file runs INSIDE Premiere, in Premiere's own scripting engine.
 * The panel (js/main.js) can't touch Premiere directly — it can only ask
 * this file to do things, by name, passing strings. So everything that
 * actually moves a clip lives here.
 *
 * THINGS THAT WILL BITE YOU IF YOU DON'T KNOW THEM
 *
 * 1. This is ExtendScript, which is JavaScript frozen around 1999. There
 *    is no `let`, no `const`, no arrow functions, no `Array.forEach`, no
 *    `JSON`. Use `var`, plain `for` loops, and the JSON helpers below.
 *    If you paste in modern JS it will fail with baffling errors.
 *
 * 2. Time is inconsistent across the API, and this is not a joke:
 *      - overwriteClip() wants time in SECONDS
 *      - importMGT()     wants time in TICKS
 *    A "tick" is 1/254016000000th of a second. Premiere counts in ticks so
 *    that every frame rate divides evenly and rounding never drifts. The
 *    helpers `secs()` and `ticks()` below exist so you never have to think
 *    about which is which — but the mismatch is real, so don't "tidy" them
 *    into one.
 *
 * 3. Track indexes are ZERO-BASED. videoTracks[0] is what the UI calls V1.
 *
 * 4. Transitions are only reachable through the "QE DOM" — an old,
 *    undocumented, unsupported Premiere API. It has to be woken up with
 *    app.enableQE() first. It works, it's what everyone uses, and it is
 *    also the most likely thing here to break in a future Premiere. It's
 *    isolated in one function (addTransitions) for exactly that reason.
 *
 * The panel gets back a JSON string from every call. Log lines are
 * collected as we go and handed back too, so the panel can print them in
 * colour — ExtendScript has nowhere useful of its own to log to.
 * ===================================================================== */

var TICKS_PER_SECOND = 254016000000;

/* The track layout the master sequence MUST have. Zero-based:
 *   video 0 = V1 → cards and clips, end to end
 *   video 1 = V2 → watermark, alone, so nothing can ever cover it
 *   audio 0 = A1 → the clips' own sound
 */
var V_CONTENT = 0;
var V_WATERMARK = 1;
var A_CONTENT = 0;

var LOG = [];

function log(level, message) {
  LOG.push(level + "|" + message);
}


/* ---------------------------------------------------------------------
 * JSON, by hand
 * ExtendScript has no JSON object, so we roll the two bits we need.
 * Parsing is just eval — a JSON string is a valid JS object literal, and
 * the only thing we ever parse is our own panel's output.
 * ------------------------------------------------------------------- */

function parseJSON(str) {
  return eval("(" + str + ")");
}

function esc(s) {
  s = String(s);
  s = s.replace(/\\/g, "\\\\");
  s = s.replace(/"/g, '\\"');
  s = s.replace(/[\r\n]+/g, " ");
  return s;
}

function listToJSON(arr) {
  var out = [];
  for (var i = 0; i < arr.length; i++) out.push('"' + esc(arr[i]) + '"');
  return "[" + out.join(",") + "]";
}

// Every function in this file answers with this shape.
function reply(ok, message, blocks, warns) {
  return '{"ok":' + (ok ? "true" : "false") +
         ',"message":"' + esc(message) + '"' +
         ',"blocks":' + listToJSON(blocks || []) +
         ',"warns":' + listToJSON(warns || []) +
         ',"logs":' + listToJSON(LOG) + "}";
}


/* ---------------------------------------------------------------------
 * Time helpers — see note 2 at the top of this file.
 * ------------------------------------------------------------------- */

// A Time object at n seconds. Used for setting trackItem.end.
function secs(n) {
  var t = new Time();
  t.seconds = n;
  return t;
}

// Ticks, as a string, for importMGT.
function ticks(n) {
  return String(Math.round(n * TICKS_PER_SECOND));
}

// Windows/Premiere disagree about slashes and casing. Normalise before
// comparing, or you'll spend an hour wondering why a file "isn't there".
function normPath(p) {
  return String(p || "").replace(/\\/g, "/").toLowerCase();
}


/* ---------------------------------------------------------------------
 * Finding things in the project
 * ------------------------------------------------------------------- */

function findSequenceByName(name) {
  var wanted = String(name).replace(/^\s+|\s+$/g, "").toLowerCase();
  var seqs = app.project.sequences;
  var names = [];

  for (var i = 0; i < seqs.numSequences; i++) {
    var s = seqs[i];
    names.push(s.name);
    if (String(s.name).replace(/^\s+|\s+$/g, "").toLowerCase() === wanted) {
      log("success", 'Found the master sequence: "' + s.name + '"');
      return s;
    }
  }

  log("error", 'No sequence named "' + name + '". Project has: ' + names.join(", "));
  return null;
}

/**
 * Copy the master sequence and hand back the copy.
 *
 * This is the "never touch the master" rule made real.
 *
 * clone() returns only true/false — it does NOT hand back the new
 * sequence. So we note every sequence's ID first, clone, look again, and
 * take the ID that wasn't there before. Matching on a name like "MASTER
 * Copy" would break in a non-English Premiere and collide when a copy
 * already exists. IDs don't lie.
 */
function cloneSequence(master) {
  var before = {};
  var seqs = app.project.sequences;
  var i;

  for (i = 0; i < seqs.numSequences; i++) before[seqs[i].sequenceID] = true;
  log("info", "Project has " + seqs.numSequences + " sequences before the copy.");

  if (!master.clone()) {
    log("error", "Premiere refused to copy the master sequence.");
    return null;
  }

  seqs = app.project.sequences;
  for (i = 0; i < seqs.numSequences; i++) {
    if (!before[seqs[i].sequenceID]) {
      log("success", 'Copied the master. Working on the copy: "' + seqs[i].name + '"');
      return seqs[i];
    }
  }

  log("error", "The copy was made but we can't find it — stopping rather than guessing.");
  return null;
}

/**
 * Walk the whole project tree looking for a clip whose media file is at
 * `path`. Matching on the file path rather than the name matters: two
 * clips in different folders can easily both be called "final.mp4".
 */
function findItemByPath(bin, wantedPath) {
  for (var i = 0; i < bin.children.numItems; i++) {
    var item = bin.children[i];

    if (item.type === ProjectItemType.BIN) {
      var found = findItemByPath(item, wantedPath);
      if (found) return found;
    } else {
      var media = "";
      try { media = item.getMediaPath(); } catch (e) { media = ""; }
      if (media && normPath(media) === wantedPath) return item;
    }
  }
  return null;
}

/**
 * Import files, then find the project items they became.
 *
 * importFiles() only answers true/false — it doesn't give you the items it
 * created, so we import and then go looking. Re-importing something
 * Premiere already has is harmless; it won't duplicate it.
 */
function importAndFind(paths) {
  var found = [];
  var i;

  if (paths.length === 0) return found;

  log("step", "Importing " + paths.length + " file(s)…");
  app.project.importFiles(paths, true /* suppressUI */, app.project.rootItem, false);

  for (i = 0; i < paths.length; i++) {
    var item = findItemByPath(app.project.rootItem, normPath(paths[i]));
    if (!item) log("warn", 'Could not find "' + paths[i] + '" after importing it.');
    found.push(item);
  }

  return found;
}


/* ---------------------------------------------------------------------
 * Inspecting clips
 * ------------------------------------------------------------------- */

/**
 * The clip's full, native length.
 *
 * A project item has an in point and an out point. Left alone, they sit at
 * the very start and very end of the media, so out − in is the whole clip.
 * We never move them — the whole point of this plugin is that clips play
 * at their natural length, so we READ the length rather than dictate it.
 */
function clipSeconds(item) {
  try {
    return item.getOutPoint().seconds - item.getInPoint().seconds;
  } catch (e) {
    log("warn", "Couldn't read the length of " + item.name + ": " + e);
    return 0;
  }
}

/**
 * Is this clip taller than it is wide?
 *
 * There's no "give me the resolution" call, so we read the Project panel's
 * own metadata columns — the same "1080 x 1920" text you'd see in a column
 * in the Project panel.
 *
 * Best effort. If we can't tell, we return null and simply don't warn.
 * Orientation is only ever a warning, never a reason to block a build, so
 * a missed warning is a far smaller sin than a false alarm.
 */
function isVertical(item) {
  try {
    var raw = item.getProjectColumnsMetadata();
    var cols = parseJSON(raw);
    for (var i = 0; i < cols.length; i++) {
      var val = String(cols[i].ColumnValue || "");
      var m = val.match(/(\d{2,5})\s*[xX×]\s*(\d{2,5})/);
      if (m) {
        var w = Number(m[1]), h = Number(m[2]);
        log("info", item.name + " is " + w + "x" + h);
        return h > w;
      }
    }
  } catch (e) {
    // Fine. Skip the check.
  }
  return null;
}


/* ---------------------------------------------------------------------
 * Building
 * ------------------------------------------------------------------- */

/**
 * Drop a text card on the timeline and type the words into it.
 *
 * The cards are .mogrt files, designed once in Premiere's Essential
 * Graphics panel and exported. That matters: a .mogrt exposes its text as
 * a real parameter we can set. A hand-drawn text layer does not.
 *
 * getMGTComponent() gives us the parameters the template's creator chose
 * to expose. We set the first one that takes text — and we log every
 * parameter name we find, so if the words ever land in the wrong place,
 * that log tells you exactly what the template is offering.
 */
function insertCard(seq, mogrtPath, text, atSeconds, cardSeconds) {
  log("step", "Adding a text card at " + atSeconds.toFixed(1) + "s: \"" + text + "\"");

  var card = seq.importMGT(mogrtPath, ticks(atSeconds), V_CONTENT, -1);
  if (!card) throw new Error("Premiere couldn't add the card from " + mogrtPath);

  // Make it the right length.
  card.end = secs(atSeconds + cardSeconds);
  log("info", "Card set to " + cardSeconds + "s long.");

  // Type the words in.
  try {
    var comp = card.getMGTComponent();
    if (!comp) {
      log("warn", "This .mogrt exposes no parameters — the card will show its default wording.");
      return card;
    }

    var params = comp.properties;
    var done = false;

    for (var i = 0; i < params.numItems && !done; i++) {
      var p = params[i];
      log("info", '  .mogrt parameter: "' + p.displayName + '"');

      // Only text parameters take a string. If what's in there now is a
      // string, it's a text field.
      var current = null;
      try { current = p.getValue(); } catch (e) { continue; }

      if (typeof current === "string") {
        p.setValue(text, true);
        log("success", 'Typed the words into "' + p.displayName + '".');
        done = true;
      }
    }

    if (!done) {
      log("warn", "Couldn't find a text field in this .mogrt — it'll show its " +
                  "default wording. Check the parameter names logged above.");
    }
  } catch (e) {
    log("warn", "Couldn't set the card's text (" + e + ") — default wording will show.");
  }

  return card;
}

/**
 * Lay the clips down end to end, each at its full natural length.
 *
 * We OVERWRITE rather than INSERT. Insert ripples — it shoves everything
 * after it down the timeline, which would drag the watermark along too.
 * Overwrite drops the clip exactly where we say and touches nothing else.
 *
 * The running `playhead` is pure bookkeeping: "clip 3 starts where clip 2
 * ended". We are not deciding how long anything is — each clip's length
 * comes from the clip itself.
 */
function layClips(seq, clips, items, startSeconds, keepAudio) {
  var playhead = startSeconds;

  log("step", "Laying " + clips.length + " clips end to end from " +
              startSeconds.toFixed(1) + "s…");

  for (var i = 0; i < clips.length; i++) {
    var item = items[i];
    if (!item) {
      log("warn", 'Skipping "' + clips[i].name + '" — it isn\'t in the project.');
      continue;
    }

    var ok = seq.overwriteClip(
      item,
      String(playhead),               // seconds — see note 2 at the top
      V_CONTENT,
      keepAudio ? A_CONTENT : -1      // -1 = don't place any audio
    );
    if (!ok) throw new Error('Premiere wouldn\'t place "' + clips[i].name + '".');

    var len = clipSeconds(item);
    log("info", "  " + (i + 1) + "/" + clips.length + ' "' + clips[i].name +
                '" at ' + playhead.toFixed(2) + "s (runs " + len.toFixed(2) + "s)");
    playhead += len;
  }

  log("success", "Clips laid down. Timeline runs to " + playhead.toFixed(1) + "s.");
  return playhead;
}

/**
 * Soften every join with a short dissolve.
 *
 * THE HONEST CAVEAT: a dissolve needs frames to blend, and we use every
 * clip at its FULL length, so there are no spare frames past the ends.
 * Premiere resolves that by pulling the clips slightly into each other.
 * That's why the finished reel comes out a little shorter than the clips
 * added together, and why the runtime readout calls itself an estimate.
 * This was a deliberate choice — see CLAUDE.md.
 *
 * This is also the one function using the QE DOM: an old, undocumented
 * Premiere API that has to be woken up with app.enableQE(). It's the only
 * way to add a transition from a script. It's kept in here, alone, so that
 * when a future Premiere breaks it, there's exactly one place to look.
 *
 * A failed dissolve is never worth killing a good build over, so each one
 * is attempted independently and a failure is only a warning — you get a
 * hard cut at that join instead.
 */
function addTransitions(frames) {
  log("step", "Adding a " + frames + "-frame dissolve to each join…");

  try {
    app.enableQE();
  } catch (e) {
    log("warn", "Couldn't start Premiere's QE engine — no transitions. " +
                "The reel is fine, just hard cuts.");
    return;
  }

  var qeSeq = qe.project.getActiveSequence();
  if (!qeSeq) {
    log("warn", "QE can't see the sequence — no transitions, hard cuts instead.");
    return;
  }

  var dissolve = qe.project.getVideoTransitionByName("Cross Dissolve");
  if (!dissolve) {
    log("warn", "Couldn't find the Cross Dissolve transition — hard cuts instead.");
    return;
  }

  var track = qeSeq.getVideoTrackAt(V_CONTENT);
  var count = track.numItems;
  var added = 0;

  // A dissolve goes on the END of a clip and blends it with the next one.
  // So we walk every item except the last — the last has nothing after it.
  for (var i = 0; i < count - 1; i++) {
    try {
      var clip = track.getItemAt(i);
      var ok = clip.addTransition(
        dissolve,
        false,             // false = put it on the END of this clip
        String(frames),    // duration, in frames
        "0:00",            // offset
        0.5,               // 0.5 = centre the dissolve on the cut
        false,             // not single-sided
        false
      );
      if (ok) added++;
      else log("warn", "  Join " + (i + 1) + " wouldn't take a dissolve — hard cut there.");
    } catch (e) {
      log("warn", "  Join " + (i + 1) + " wouldn't take a dissolve (" + e + ") — hard cut.");
    }
  }

  log("success", "Added " + added + " dissolve(s) across " + (count - 1) + " joins.");
}

/**
 * Put the watermark on its own track and stretch it across everything.
 *
 * This runs LAST, deliberately. The dissolves shorten the timeline, so the
 * true final length isn't known until they're in. By asking the sequence
 * for its own end AT THIS POINT, the watermark is guaranteed to span the
 * whole reel no matter how many clips there were or how the transitions
 * landed. That's what makes "visible for the entire runtime, regardless"
 * actually true.
 */
function layWatermark(seq, watermarkItem) {
  var endSeconds = seq.end.seconds;
  log("step", "Stretching the watermark across the full " + endSeconds.toFixed(1) + "s.");

  var ok = seq.overwriteClip(watermarkItem, "0", V_WATERMARK, -1);
  if (!ok) throw new Error("Premiere wouldn't place the watermark.");

  var track = seq.videoTracks[V_WATERMARK];
  if (track.clips.numItems === 0) throw new Error("The watermark didn't land on its track.");

  // A still image comes in at whatever default length Premiere fancies
  // (usually 5s), so stretch it to cover the whole reel.
  var item = track.clips[track.clips.numItems - 1];
  item.end = secs(endSeconds);

  log("success", "Watermark covers the whole reel, on its own track.");
}


/* =====================================================================
 * The two entry points the panel calls
 * ===================================================================== */

/**
 * Run every check, touch nothing.
 *
 * The build calls this too, so the two can never drift apart — "Check my
 * setup" tests exactly what "Build" will do.
 *
 * Note there is deliberately NO upper limit on the number of clips.
 */
function rb_validate(optsJSON) {
  LOG = [];
  var blocks = [];
  var warns = [];

  try {
    var o = parseJSON(optsJSON);
    log("step", "Checking the setup…");

    if (!app.project) {
      blocks.push("Premiere doesn't have a project open. Open your project first.");
      return reply(false, "", blocks, warns);
    }
    log("info", "Project: " + app.project.name);

    if (!o.introText) blocks.push("The opening text is empty. Type what the first card should say.");
    if (!o.watermarkPath) blocks.push("No watermark image is set. Open Setup and choose one.");
    if (!o.introMogrt || !o.outroMogrt) {
      blocks.push("The opening and closing card templates aren't set. Open Setup and choose them.");
    }
    if (!o.clips || o.clips.length === 0) {
      blocks.push("No clips chosen. Pick the videos you want in the reel.");
    }

    var master = findSequenceByName(o.masterName);
    if (!master) {
      blocks.push('Can\'t find a sequence called "' + o.masterName + '" in this project. ' +
                  "Check the name in Setup matches the sequence in Premiere exactly.");
    } else if (master.videoTracks.numTracks < V_WATERMARK + 1) {
      blocks.push("The master sequence only has " + master.videoTracks.numTracks +
                  " video track(s). It needs at least " + (V_WATERMARK + 1) +
                  " — one for the clips, one for the watermark.");
    }

    // Clip checks need the clips imported, which is only worth doing if we
    // actually have some.
    if (o.clips && o.clips.length > 0) {
      var paths = [];
      for (var i = 0; i < o.clips.length; i++) paths.push(o.clips[i].path);
      var items = importAndFind(paths);

      var missing = [], sideways = [], total = 0;

      for (i = 0; i < items.length; i++) {
        var item = items[i];
        if (!item) { missing.push(o.clips[i].name); continue; }

        if (item.isOffline()) missing.push(o.clips[i].name);
        total += clipSeconds(item);
        if (isVertical(item) === false) sideways.push(o.clips[i].name);
      }

      if (missing.length > 0) {
        warns.push(missing.length + " clip(s) look like they've been moved or deleted: " +
                   missing.join(", ") + ". The reel will still build, but those parts " +
                   "may come out blank.");
      }
      if (sideways.length > 0) {
        warns.push(sideways.length + " clip(s) are wider than they are tall: " +
                   sideways.join(", ") + ". They'll still be used, but they'll have " +
                   "black bars above and below.");
      }

      log("info", "Clips total " + total.toFixed(1) + "s before transitions.");
    }

    if (blocks.length === 0) log("success", "All checks passed.");
    else log("error", blocks.length + " problem(s) would stop the build.");

    return reply(blocks.length === 0, "", blocks, warns);

  } catch (e) {
    log("error", "Check failed: " + e);
    blocks.push("Something went wrong while checking: " + e);
    return reply(false, "", blocks, warns);
  }
}

/**
 * The whole build, start to finish.
 */
function rb_build(optsJSON) {
  LOG = [];
  var blocks = [];
  var warns = [];

  try {
    var o = parseJSON(optsJSON);

    // 1. Refuse to build anything that wouldn't come out right.
    //    (Re-runs validation inside this call, so nothing can drift.)
    var checked = parseJSON(rb_validate(optsJSON));
    if (!checked.ok) {
      LOG = [];
      log("error", "═══ BUILD STOPPED — validation failed ═══");
      return reply(false, "", checked.blocks, checked.warns);
    }
    for (var w = 0; w < checked.warns.length; w++) warns.push(checked.warns[w]);

    LOG = [];
    log("step", "═══ BUILD STARTED ═══");

    // 2. Copy the master. Everything from here happens on the copy.
    var master = findSequenceByName(o.masterName);
    var seq = cloneSequence(master);
    if (!seq) throw new Error("Couldn't copy the master sequence.");

    seq.name = o.sequenceName;
    log("success", 'Named the new sequence "' + o.sequenceName + '".');

    // Put it on screen so she can watch it being built.
    app.project.openSequence(seq.sequenceID);
    app.project.activeSequence = seq;

    // 3. Bring in the clips and the watermark.
    var paths = [];
    for (var i = 0; i < o.clips.length; i++) paths.push(o.clips[i].path);
    var items = importAndFind(paths);

    var wm = importAndFind([o.watermarkPath])[0];
    if (!wm) throw new Error("Couldn't import the watermark image.");

    // 4. Opening card → clips → closing card, one after another.
    insertCard(seq, o.introMogrt, o.introText, 0, o.cardSeconds);

    var afterClips = layClips(seq, o.clips, items, o.cardSeconds, o.keepAudio);

    insertCard(seq, o.outroMogrt, o.outroText, afterClips, o.cardSeconds);

    // 5. Soften the joins.
    addTransitions(o.transitionFrames);

    // 6. Watermark last, once the true length is settled.
    layWatermark(seq, wm);

    // 7. Mute the source audio if she asked for a silent reel.
    if (!o.keepAudio) {
      try {
        seq.audioTracks[A_CONTENT].setMute(1);
        log("info", "Muted the clips' audio, as asked.");
      } catch (e) {
        log("warn", "Couldn't mute the audio track: " + e);
      }
    }

    var finalSeconds = seq.end.seconds;
    log("success", '═══ BUILD FINISHED — "' + o.sequenceName + '", ' +
                   finalSeconds.toFixed(1) + "s ═══");

    // 8. Render, if she's set a preset and a folder. If she hasn't, the
    //    reel is still built and sitting in Premiere — a missing preset
    //    must never throw away a good build.
    var rendered = "";
    if (o.presetPath && o.outputFolder) {
      try {
        var out = o.outputFolder + "\\" + o.sequenceName + ".mp4";
        app.encoder.launchEncoder();
        app.encoder.encodeSequence(seq, out, o.presetPath, 0 /* entire sequence */, 1);
        app.encoder.startBatch();
        log("success", "Sent to Adobe Media Encoder: " + out);
        rendered = " Rendering now to " + out;
      } catch (e) {
        log("warn", "Couldn't start the render (" + e + ") — the reel is still built.");
        warns.push("Your reel is built, but I couldn't start the render. " +
                   "You can export it from File → Export.");
      }
    } else {
      log("warn", "No export preset or output folder set — built, but not rendering.");
      warns.push("Your reel is built and open in Premiere, but I didn't render it: " +
                 "no export preset or output folder is set in Setup. You can export " +
                 "it yourself from File → Export.");
    }

    var mins = Math.floor(finalSeconds / 60);
    var s = Math.round(finalSeconds % 60);
    var human = mins > 0 ? (mins + "m " + s + "s") : (s + " seconds");

    return reply(true, 'Built "' + o.sequenceName + '" — ' + human + " long." + rendered,
                 [], warns);

  } catch (e) {
    log("error", "═══ BUILD FAILED ═══ " + e);
    blocks.push("Something went wrong and the reel wasn't finished: " + e);
    blocks.push("Your master sequence has not been changed. You can safely try again.");
    return reply(false, "", blocks, warns);
  }
}

/**
 * Measure the chosen clips so the panel can show a runtime estimate before
 * anything is built. Imports them as a side effect, which is fine.
 */
function rb_measure(optsJSON) {
  LOG = [];
  try {
    var o = parseJSON(optsJSON);
    if (!app.project) return reply(false, "0", [], []);

    var paths = [];
    for (var i = 0; i < o.clips.length; i++) paths.push(o.clips[i].path);

    var items = importAndFind(paths);
    var total = 0;
    for (i = 0; i < items.length; i++) {
      if (items[i]) total += clipSeconds(items[i]);
    }

    log("info", "Clips measured: " + total.toFixed(1) + "s total.");
    return reply(true, String(total), [], []);

  } catch (e) {
    log("warn", "Couldn't measure the clips: " + e);
    return reply(false, "0", [], []);
  }
}
