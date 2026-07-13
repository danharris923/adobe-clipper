/* =====================================================================
 * Client Reel Builder — panel logic (CEP side)
 * =====================================================================
 *
 * This runs in a Chromium window inside Premiere. It cannot touch Premiere
 * directly. All it does is:
 *
 *   1. collect what the client typed and picked
 *   2. hand it to jsx/reelbuilder.jsx as a JSON string
 *   3. show, in plain English, whatever comes back
 *
 * The bridge is `csInterface.evalScript("someFunction(...)", callback)`.
 * Everything crossing that bridge is a STRING — no objects, no numbers,
 * no booleans. That's why we JSON-encode going out and JSON-parse coming
 * back, and why `call()` below wraps it all up so no caller has to think
 * about it.
 * ===================================================================== */

var csInterface = new CSInterface();


/* ---------------------------------------------------------------------
 * Logging
 * The ExtendScript side can't log anywhere useful, so it collects its log
 * lines and hands them back with every reply. We print them here, in
 * colour, so a build reads like a story in the console.
 *
 * To see it: right-click the panel → Inspect. (Needs PlayerDebugMode,
 * which install.ps1 sets.)
 * ------------------------------------------------------------------- */

var LOG_STYLES = {
  step:    "color:#8ab4f8; font-weight:bold",
  info:    "color:#b0b0b0",
  success: "color:#5aa85a; font-weight:bold",
  warn:    "color:#d4a13c; font-weight:bold",
  error:   "color:#d45c5c; font-weight:bold"
};

function printLogs(logs) {
  if (!logs) return;
  logs.forEach(function (line) {
    // Each line arrives as "level|message".
    var split = line.indexOf("|");
    var level = line.substring(0, split);
    var message = line.substring(split + 1);
    var style = LOG_STYLES[level] || LOG_STYLES.info;
    console.log("%c[" + level.toUpperCase().padEnd(7) + "] " + message, style);
  });
}

function logLocal(level, message) {
  console.log("%c[" + level.toUpperCase().padEnd(7) + "] " + message,
              LOG_STYLES[level] || LOG_STYLES.info);
}


/* ---------------------------------------------------------------------
 * The bridge to Premiere
 * ------------------------------------------------------------------- */

/**
 * Call a function over in reelbuilder.jsx.
 *
 * The double JSON.stringify looks like a typo but isn't. The first turns
 * our options into a JSON string. The second wraps THAT in quotes and
 * escapes it, so it survives being pasted into a line of ExtendScript
 * source as a string literal. Without it, any apostrophe in a client's
 * name would break the script.
 */
function call(fn, options) {
  return new Promise(function (resolve) {
    var payload = JSON.stringify(options);
    var script = fn + "(" + JSON.stringify(payload) + ")";

    csInterface.evalScript(script, function (raw) {
      if (raw === "EvalScript error." || !raw) {
        logLocal("error", "Premiere couldn't run " + fn + "(). Raw reply: " + raw);
        resolve({
          ok: false,
          blocks: ["Something went wrong talking to Premiere. Try again, and if it " +
                   "keeps happening, restart Premiere."],
          warns: [],
          logs: []
        });
        return;
      }

      var result;
      try {
        result = JSON.parse(raw);
      } catch (e) {
        logLocal("error", "Couldn't understand Premiere's reply: " + raw);
        resolve({
          ok: false,
          blocks: ["Premiere replied with something I didn't understand."],
          warns: [],
          logs: []
        });
        return;
      }

      printLogs(result.logs);
      resolve(result);
    });
  });
}


/* ---------------------------------------------------------------------
 * Settings — the once-per-machine choices, remembered between sessions.
 * ------------------------------------------------------------------- */

var SETTINGS_KEY = "reelBuilder.settings";

var settings = {
  masterName: "MASTER",
  watermarkPath: "",
  introMogrt: "",
  outroMogrt: "",
  presetPath: "",
  outputFolder: ""
};

// Each: { path, name }
var clips = [];

// Tunables. TRANSITION_FRAMES is the one to change if the dissolves feel
// wrong — 10 frames at 30fps is a third of a second: enough to stop the
// cut feeling abrupt, not enough to read as a deliberate effect.
var TRANSITION_FRAMES = 10;
var CARD_SECONDS = 2.5;
var SEQUENCE_FPS = 30;

function loadSettings() {
  try {
    var saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      settings = Object.assign(settings, JSON.parse(saved));
      logLocal("info", "Loaded saved setup from last time.");
    }
  } catch (e) {
    logLocal("warn", "Couldn't read saved setup, starting fresh: " + e);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    logLocal("info", "Setup saved.");
  } catch (e) {
    logLocal("warn", "Couldn't save setup: " + e);
  }
}


/* ---------------------------------------------------------------------
 * Talking to the client — plain English only, never a stack trace.
 * ------------------------------------------------------------------- */

function $(id) { return document.getElementById(id); }

function clearStatus() { $("status").innerHTML = ""; }

function say(kind, message) {
  var div = document.createElement("div");
  div.className = "msg " + kind;    // ok | warn | err | busy
  div.textContent = message;
  $("status").appendChild(div);
}

function showResult(result, successMessage) {
  clearStatus();
  (result.warns || []).forEach(function (w) { say("warn", w); });
  (result.blocks || []).forEach(function (b) { say("err", b); });
  if (result.ok && successMessage) say("ok", successMessage);
}


/* ---------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------- */

function humanDuration(totalSeconds) {
  var whole = Math.round(totalSeconds);
  var mins = Math.floor(whole / 60);
  var secs = whole % 60;
  if (mins === 0) return secs + " seconds";
  return mins + "m " + String(secs).padStart(2, "0") + "s";
}

function safeName(s) {
  return (s || "").trim().replace(/[\\/:*?"<>|]/g, "-");
}

function todayStamp() {
  var d = new Date();
  var pad = function (n) { return String(n).padStart(2, "0"); };
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

// Everything the ExtendScript side needs, in one object.
function currentOptions() {
  return {
    masterName: settings.masterName,
    watermarkPath: settings.watermarkPath,
    introMogrt: settings.introMogrt,
    outroMogrt: settings.outroMogrt,
    presetPath: settings.presetPath,
    outputFolder: settings.outputFolder,
    introText: $("introText").value.trim(),
    outroText: $("outroText").value.trim(),
    keepAudio: $("keepAudio").checked,
    clips: clips,
    sequenceName: (safeName($("clientName").value) || "Reel") + "_" + todayStamp(),
    cardSeconds: CARD_SECONDS,
    transitionFrames: TRANSITION_FRAMES
  };
}


/* ---------------------------------------------------------------------
 * Runtime readout
 *
 * An ESTIMATE, and it says so. Each dissolve overlaps two clips, so it
 * removes roughly its own length from the running time. We account for
 * that, but Premiere makes the final call about how many frames it can
 * borrow at each join.
 * ------------------------------------------------------------------- */

var clipTotalSeconds = null;

function updateRuntime() {
  var el = $("runtime");

  if (clips.length === 0) {
    el.textContent = "Choose some clips to see how long the video will be.";
    return;
  }
  if (clipTotalSeconds === null) {
    el.textContent = clips.length + " clips chosen. Checking how long they are…";
    return;
  }

  var cards = CARD_SECONDS * 2;
  var joins = clips.length + 1;                       // one before each clip, one before the outro
  var lost = joins * (TRANSITION_FRAMES / SEQUENCE_FPS);
  var total = Math.max(0, clipTotalSeconds + cards - lost);

  el.textContent = clips.length + " clips · about " + humanDuration(total) +
                   " in total (including the two " + CARD_SECONDS + "s cards).";
}

async function measureClips() {
  if (clips.length === 0) { clipTotalSeconds = null; updateRuntime(); return; }

  var result = await call("rb_measure", currentOptions());
  clipTotalSeconds = result.ok ? parseFloat(result.message) : null;
  updateRuntime();
}


/* ---------------------------------------------------------------------
 * The clip list
 * ------------------------------------------------------------------- */

function renderClipList() {
  var list = $("clipList");
  list.innerHTML = "";

  clips.forEach(function (clip, i) {
    var row = document.createElement("li");

    var num = document.createElement("span");
    num.className = "num";
    num.textContent = (i + 1) + ".";

    var name = document.createElement("span");
    name.className = "name";
    name.textContent = clip.name;

    // Order on screen = order in the video, so she must be able to shuffle
    // it without re-picking everything.
    var up = document.createElement("button");
    up.textContent = "↑";
    up.disabled = i === 0;
    up.onclick = function () { moveClip(i, -1); };

    var down = document.createElement("button");
    down.textContent = "↓";
    down.disabled = i === clips.length - 1;
    down.onclick = function () { moveClip(i, 1); };

    var remove = document.createElement("button");
    remove.textContent = "✕";
    remove.onclick = function () {
      logLocal("info", 'Removed "' + clip.name + '" from the running order.');
      clips.splice(i, 1);
      renderClipList();
      measureClips();
    };

    row.appendChild(num);
    row.appendChild(name);
    row.appendChild(up);
    row.appendChild(down);
    row.appendChild(remove);
    list.appendChild(row);
  });

  $("clipCount").textContent = clips.length === 0
    ? "No clips chosen yet."
    : clips.length + " clip(s) — they'll play in this order.";
}

function moveClip(index, direction) {
  var target = index + direction;
  if (target < 0 || target >= clips.length) return;
  var tmp = clips[index];
  clips[index] = clips[target];
  clips[target] = tmp;
  renderClipList();
}


/* ---------------------------------------------------------------------
 * File pickers
 *
 * CEP gives us a native file dialog through window.cep.fs. It hands back
 * real paths on disk, which is exactly what Premiere's importer wants.
 * ------------------------------------------------------------------- */

function pickFiles(title, extensions, multiple) {
  var result = window.cep.fs.showOpenDialog(
    !!multiple,
    false,          // not a folder
    title,
    "",             // no initial path
    extensions
  );
  if (result.err !== 0 || !result.data || result.data.length === 0) return [];
  return result.data;
}

function pickFolder(title) {
  var result = window.cep.fs.showOpenDialog(false, true, title, "", null);
  if (result.err !== 0 || !result.data || result.data.length === 0) return "";
  return result.data[0];
}

function basename(p) {
  return String(p).split(/[\\/]/).pop();
}

function pickClips() {
  var paths = pickFiles(
    "Choose your video clips",
    ["mp4", "mov", "m4v", "avi", "mxf", "mpg", "mpeg", "wmv"],
    true
  );
  if (paths.length === 0) { logLocal("info", "Clip picker closed without choosing anything."); return; }

  clips = paths.map(function (p) { return { path: p, name: basename(p) }; });
  logLocal("success", clips.length + " clip(s) chosen.");

  clipTotalSeconds = null;
  renderClipList();
  updateRuntime();
  measureClips();      // get real lengths so the readout isn't a guess
}

function pickSetting(title, extensions, key, labelId) {
  var paths = pickFiles(title, extensions, false);
  if (paths.length === 0) return;

  settings[key] = paths[0];
  $(labelId).textContent = paths[0];
  saveSettings();
  logLocal("success", title + " set: " + paths[0]);
}


/* ---------------------------------------------------------------------
 * Wiring
 * ------------------------------------------------------------------- */

function applySettingsToPanel() {
  $("masterName").value = settings.masterName || "MASTER";
  $("watermarkPath").textContent = settings.watermarkPath || "Not set.";
  $("introMogrtPath").textContent = settings.introMogrt || "Not set.";
  $("outroMogrtPath").textContent = settings.outroMogrt || "Not set.";
  $("presetPath").textContent = settings.presetPath || "Not set.";
  $("outputPath").textContent = settings.outputFolder || "Not set.";
}

function init() {
  logLocal("step", "Client Reel Builder loaded (CEP).");

  loadSettings();
  applySettingsToPanel();
  renderClipList();
  updateRuntime();

  $("pickClips").onclick = pickClips;

  $("pickWatermark").onclick = function () {
    pickSetting("Watermark", ["png", "jpg", "jpeg", "psd", "ai", "tif", "tiff"],
                "watermarkPath", "watermarkPath");
  };
  $("pickIntroMogrt").onclick = function () {
    pickSetting("Opening card", ["mogrt"], "introMogrt", "introMogrtPath");
  };
  $("pickOutroMogrt").onclick = function () {
    pickSetting("Closing card", ["mogrt"], "outroMogrt", "outroMogrtPath");
  };
  $("pickPreset").onclick = function () {
    pickSetting("Export preset", ["epr"], "presetPath", "presetPath");
  };
  $("pickOutput").onclick = function () {
    var folder = pickFolder("Where should finished videos go?");
    if (!folder) return;
    settings.outputFolder = folder;
    $("outputPath").textContent = folder;
    saveSettings();
    logLocal("success", "Output folder set: " + folder);
  };

  $("setupToggle").onclick = function () {
    $("setupBody").classList.toggle("hidden");
  };

  $("masterName").onchange = function (e) {
    settings.masterName = e.target.value.trim();
    saveSettings();
  };

  // "Check my setup" runs exactly the same checks the build runs — same
  // code path over in the .jsx, so the two can never drift apart.
  $("validate").onclick = async function () {
    clearStatus();
    say("busy", "Checking…");

    var result = await call("rb_validate", currentOptions());

    showResult(result, null);
    if (result.ok) {
      say("ok", (result.warns || []).length === 0
        ? "Everything looks good. You're ready to build."
        : "Good enough to build — have a read of the notes above first.");
    } else {
      say("err", "Fix the problems above, then check again.");
    }
  };

  $("build").onclick = async function () {
    $("build").disabled = true;
    clearStatus();
    say("busy", "Working… this can take a minute. Don't close Premiere.");

    try {
      var result = await call("rb_build", currentOptions());
      showResult(result, result.message);
      if (!result.ok) say("err", "Nothing was built. Fix the problems above and try again.");
    } finally {
      $("build").disabled = false;      // always re-enable, even after a crash
    }
  };

  logLocal("success", "Panel ready.");
}

init();
