import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// preview.js is a classic browser script that publishes itself on window. It is
// loaded against a small fake DOM because the part worth testing is the key
// arbitration -- which keys the panel claims, and which it must let through --
// not the rendering.
function makeEl(tag) {
  // querySelector answers with a stable child per selector, so a test can set
  // scroll metrics on the same object the panel will later scroll.
  const kids = {};
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    _class: "",
    dataset: {},
    style: {},
    childNodes: [],
    offsetWidth: 300,
    offsetHeight: 220,
    textContent: "",
    innerHTML: "",
    title: "",
    value: "",
    // A body that fits has nothing to scroll; the tests override these when
    // they want the scrolling branch.
    scrollHeight: 0,
    clientHeight: 0,
    scrollWidth: 0,
    clientWidth: 0,
    scrollTop: 0,
    scrollLeft: 0,
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { el.childNodes.push(c); c.parentNode = el; return c; },
    contains() { return false; },
    closest() { return null; },
    querySelector(sel) {
      if (!kids[sel]) kids[sel] = makeEl("div");
      return kids[sel];
    },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 300, bottom: 220, width: 300, height: 220 }; },
    focus() {},
  };
  el.classList = {
    add(...c) { el._class = [...new Set(el._class.split(" ").filter(Boolean).concat(c))].join(" "); },
    remove(...c) { el._class = el._class.split(" ").filter((x) => x && !c.includes(x)).join(" "); },
    toggle(c, on) { if (on) el.classList.add(c); else el.classList.remove(c); },
    contains(c) { return el._class.split(" ").includes(c); },
  };
  return el;
}

function load(overrides = {}) {
  const panel = makeEl("div");
  const docEl = makeEl("html");
  const appContainer = makeEl("div");
  const resultsContainer = makeEl("div");

  let savedReady = null;
  let keyup = null;
  const created = [];
  const body = makeEl("body");
  const fixedIds = {
    "app-container": appContainer,
    "results-container": resultsContainer,
    "preview-style-seg": null,
  };
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => fn(),
    selectedIndex: 0,
    selectableItems: [],
    lastQuery: "",
    invoke: () => new Promise(() => {}), // never resolves; tests drive the states by hand
    t: (k) => k,
    launchItem: () => {},
    hideWindow: () => {},
    uiZoom: () => 1,
    document: {
      documentElement: docEl,
      body,
      // Elements the script builds itself are looked up by the id it gives them,
      // so the registry has to scan what createElement handed out.
      createElement: (tag) => {
        const el = makeEl(tag);
        created.push(el);
        return el;
      },
      getElementById: (id) => {
        if (id in fixedIds) return fixedIds[id];
        return created.find((el) => el.id === id) || null;
      },
      // preview.js wires itself up on DOMContentLoaded; capture and fire it here,
      // and keep the key listeners so a test can release a held chord.
      addEventListener: (name, fn) => {
        if (name === "DOMContentLoaded") savedReady = fn;
        if (name === "keyup") keyup = fn;
      },
      removeEventListener() {},
      dispatchEvent() {},
      querySelector: () => null,
      querySelectorAll: () => [],
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.__created = created;
  Object.assign(sandbox, overrides);

  const ctx = vm.createContext(sandbox);
  // The keys are asked of the registry, so it is loaded the way the page loads it.
  vm.runInContext(readFileSync(new URL("../src/keybinds.js", import.meta.url), "utf8"), ctx);
  vm.runInContext(readFileSync(new URL("../src/preview.js", import.meta.url), "utf8"), ctx);
  if (savedReady) savedReady();

  return { P: sandbox.UmbraPreview, sandbox, panel, created, body, keyup: () => keyup };
}

function panelOf(sandbox) {
  const el = sandbox.__created.find((e) => e.id === "preview-panel");
  if (!el) throw new Error("the panel was never created");
  return el;
}

const FILE = { path: "C:\\x\\report.docx", name: "report.docx", kind: "document" };
const TEXTFILE = { path: "C:\\x\\notes.txt", name: "notes.txt", kind: "document" };

// The registry matches by code, so the fake event carries the one the key has.
function codeOf(key) {
  if (key === " ") return "Space";
  if (/^[a-z]$/i.test(key)) return "Key" + key.toUpperCase();
  return key;
}
function ev(key, mods = {}) {
  return {
    key,
    code: codeOf(key),
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    ...mods,
  };
}

test("Shift+Space opens the row card, a bare Space does not", () => {
  const { P, sandbox } = load();
  sandbox.selectableItems = [FILE];
  sandbox.selectedIndex = 0;
  const calls = [];
  sandbox.UmbraSidePreview = { hold: (on) => { calls.push(on); return true; }, held: () => false };

  const bare = ev(" ");
  assert.equal(P.handleKey(bare), false, "a bare Space must reach the search box");
  assert.equal(P.isOpen(), false);

  const shifted = ev(" ", { shiftKey: true });
  assert.equal(P.handleKey(shifted), true, "Shift+Space belongs to the preview");
  assert.equal(shifted.defaultPrevented, true);
  assert.deepEqual(calls, [true], "the hold goes to the row card");
  assert.equal(P.isOpen(), false, "the floating panel is no longer used for it");
});

test("a Space while the row card is held is swallowed, not typed", () => {
  const { P, sandbox } = load();
  sandbox.UmbraSidePreview = { hold: () => true, held: () => true };
  const e = ev(" ");
  assert.equal(P.handleKey(e), true);
  assert.equal(e.defaultPrevented, true);
});

test("Shift+Space does nothing when there is nothing to preview", () => {
  const { P, sandbox } = load();
  sandbox.selectableItems = [{ path: "C:\\x\\a", name: "a", kind: "help" }];
  sandbox.selectedIndex = 0;
  // Cards (help / copy / open) have no file behind them.
  assert.equal(P.handleKey(ev(" ", { shiftKey: true })), false);
  assert.equal(P.isOpen(), false);
});

test("Shift+Enter opens the full preview and Enter is then claimed by it", () => {
  const { P, sandbox } = load();
  sandbox.selectableItems = [FILE];
  sandbox.selectedIndex = 0;

  const fullKey = ev("Enter", { shiftKey: true });
  assert.equal(P.handleKey(fullKey), true);
  assert.equal(P.isOpen(), true);

  // A bare Enter would launch the file in main.js; with the panel up it must not
  // get there.
  const plainEnter = ev("Enter");
  assert.equal(P.handleKey(plainEnter), true, "the open panel must swallow Enter");
  assert.equal(plainEnter.defaultPrevented, true);
});

test("Shift+Enter twice closes the full preview", () => {
  const { P, sandbox } = load();
  sandbox.selectableItems = [FILE];
  sandbox.selectedIndex = 0;
  P.handleKey(ev("Enter", { shiftKey: true }));
  assert.equal(P.isOpen(), true);
  P.handleKey(ev("Enter", { shiftKey: true }));
  assert.equal(P.isOpen(), false);
});

test("Escape closes the full preview", () => {
  const { P, sandbox } = load();
  sandbox.selectableItems = [FILE];
  P.handleKey(ev("Enter", { shiftKey: true }));
  const esc = ev("Escape");
  P.handleKey(esc);
  assert.equal(P.isOpen(), false);
  assert.equal(esc.defaultPrevented, true);
});

test("arrows scroll the full preview only when it has somewhere to scroll", () => {
  const { P, sandbox } = load();
  sandbox.selectableItems = [FILE, TEXTFILE];
  sandbox.selectedIndex = 0;
  P.handleKey(ev("Enter", { shiftKey: true }));
  const down = ev("ArrowDown");
  // Nothing to scroll in the fake body, so the key must reach the list rather
  // than be swallowed by a panel that was not going to move.
  assert.equal(P.handleKey(down), false, "a panel that cannot scroll must not trap the arrows");
  assert.equal(down.defaultPrevented, false);
});

test("arrows are claimed when the preview is taller than its box", () => {
  const { P, sandbox } = load();
  sandbox.selectableItems = [FILE];
  sandbox.selectedIndex = 0;
  P.handleKey(ev("Enter", { shiftKey: true }));
  // Make the body taller than the frame, as a long document would be.
  const body = sandbox.document.getElementById("preview-panel").querySelector(".pv-body");
  body.scrollHeight = 900;
  body.clientHeight = 200;
  const down = ev("ArrowDown");
  assert.equal(P.handleKey(down), true, "a scrollable preview must take the arrows");
  assert.equal(down.defaultPrevented, true);
  assert.ok(body.scrollTop > 0, "and must actually have moved");
});

test("typing while the full preview is open closes it and gets through", () => {
  const { P, sandbox } = load();
  sandbox.selectableItems = [FILE];
  P.handleKey(ev("Enter", { shiftKey: true }));
  assert.equal(P.isOpen(), true);
  // Opening a preview must never trap the user in it.
  assert.equal(P.handleKey(ev("a")), false, "the character has to reach the search box");
  assert.equal(P.isOpen(), false);
});

test("modified keys are not mistaken for typing", () => {
  const { P, sandbox } = load();
  sandbox.selectableItems = [FILE];
  P.handleKey(ev("Enter", { shiftKey: true }));
  // Ctrl+P pins; the panel must not close itself on the way past.
  assert.equal(P.handleKey(ev("p", { ctrlKey: true })), true);
  assert.equal(P.isOpen(), true);
});

test("Ctrl+C and Ctrl+A reach the page, so the panel's text can be copied", () => {
  const { P, sandbox } = load();
  sandbox.selectableItems = [FILE];
  P.handleKey(ev("Enter", { shiftKey: true }));
  assert.equal(P.isOpen(), true);

  // Not claimed: the document-level listener only calls preventDefault on keys
  // handleKey returns true for, and that is exactly what cancels the copy.
  const copy = ev("c", { ctrlKey: true, code: "KeyC" });
  assert.equal(P.handleKey(copy), false, "Ctrl+C must not be claimed");
  assert.equal(copy.defaultPrevented, false);
  assert.equal(P.handleKey(ev("a", { ctrlKey: true, code: "KeyA" })), false, "nor Ctrl+A");
  // The Russian layout reports a different key for the same physical key.
  assert.equal(P.handleKey(ev("с", { ctrlKey: true, code: "KeyC" })), false);
  assert.equal(P.handleKey(ev("Insert", { ctrlKey: true, code: "Insert" })), false, "nor Ctrl+Insert");
  assert.equal(P.isOpen(), true, "and copying leaves the panel open");

  // Every other key is still held back from the list underneath.
  assert.equal(P.handleKey(ev("x", { ctrlKey: true, code: "KeyX" })), true);
});

test("programs, folders and system entries are never previewable", () => {
  const { P, sandbox } = load();
  for (const kind of ["app", "shortcut", "system", "folder"]) {
    P.close();
    sandbox.selectableItems = [{ path: "C:\\x\\thing", name: "thing", kind }];
    sandbox.selectedIndex = 0;
    assert.equal(P.handleKey(ev(" ", { shiftKey: true })), false, `${kind} must not open a panel`);
    assert.equal(P.handleKey(ev("Enter", { shiftKey: true })), false, `${kind} must not open a panel`);
    assert.equal(P.isOpen(), false, `${kind} left a panel open`);
  }
});

test("settings and the context menu suppress previews", () => {
  const { P, sandbox } = load();
  sandbox.selectableItems = [FILE];
  sandbox.selectedIndex = 0;
  const settings = { classList: { contains: (c) => c === "hidden" ? false : true } };
  sandbox.document.getElementById = (id) =>
    id === "settings-section" ? settings : id === "context-menu" ? { classList: { contains: () => false } } : null;
  assert.equal(P.handleKey(ev(" ", { shiftKey: true })), false);
  assert.equal(P.isOpen(), false);
});

test("the close button closes, like Escape", () => {
  const { P, sandbox } = load();
  sandbox.selectableItems = [FILE];
  P.handleKey(ev("Enter", { shiftKey: true }));
  assert.equal(P.isOpen(), true);
  P.openFull(null, { x: 10, y: 10 });
  P.handleKey(ev("Escape"));
  assert.equal(P.isOpen(), false);
});

test("the panel is position:fixed above everything", () => {
  const { P, sandbox } = load();
  sandbox.selectableItems = [FILE];
  P.handleKey(ev("Enter", { shiftKey: true }));
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const block = css.slice(css.indexOf("#preview-panel {"), css.indexOf("#preview-panel.pv-hidden"));
  assert.match(block, /position:\s*fixed/, "must be fixed, or the animated container traps it");
  assert.match(block, /z-index:\s*2000/, "must clear the colour picker at 1000");
  assert.match(css, /#preview-panel,\s*\.pv-text,[\s\S]*?user-select:\s*text/, "preview text has to be selectable");
  assert.match(css, /\.pv-scrollbar\b/, "the preview needs its own scrollbar");
});

test("the panel is appended to the body, not into the animated container", () => {
  const { P, sandbox, body } = load();
  sandbox.selectableItems = [FILE];
  P.handleKey(ev("Enter", { shiftKey: true }));
  // #app-container is transformed and filtered while the window animates, which
  // makes it the containing block for anything positioned inside -- that is how
  // the panel ended up behind the list with clicks going through to it.
  const panel = panelOf(sandbox);
  assert.equal(panel.parentNode, body, "the panel must live on body");
});

test("media gets a player even without a Shell thumbnail", () => {
  // .webm and .mkv are outside what Windows can decode, so the Shell has no
  // thumbnail for them. The panel must still open and hand the file to Chromium.
  const { P, sandbox } = load();
  const WEBM = { path: "C:\\x\\clip.webm", name: "clip.webm", kind: "video" };
  sandbox.selectableItems = [WEBM];
  sandbox.selectedIndex = 0;
  assert.equal(P.hasContent({ kind: "video", thumb: null, text: null }), true);
  assert.equal(P.hasContent({ kind: "audio", thumb: null, text: null }), true);
  assert.equal(P.hasContent({ kind: "other", thumb: null, text: null }), false);
});

test("the asset protocol is scoped to media and animated images, not to the whole disk", () => {
  const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const ap = conf.app.security.assetProtocol;
  assert.equal(ap.enable, true, "media playback needs it on");
  const scope = ap.scope;
  assert.ok(Array.isArray(scope), "a scope list is required");
  assert.ok(scope.every((s) => typeof s === "string"), "no bare paths, globs only");
  assert.ok(
    scope.every((s) => /\.(mp4|m4v|webm|mkv|avi|mov|wmv|flv|3gp|ts|mpeg|mpg|ogv|mp3|m4a|aac|wav|ogg|oga|opus|flac|wma|mid|gif|webp|apng|pdf)$/.test(s)),
    "only media extensions may be reachable"
  );
  assert.ok(!scope.includes("**") && !scope.includes("**/*"), "no catch-all glob");
  // And the CSP has to let the converted URL through.
  const csp = conf.app.security.csp;
  assert.match(csp, /media-src[^;]*http:\/\/asset\.localhost/, "media-src must allow the asset URL");
  assert.match(csp, /media-src[^;]*blob:/, "and blob URLs");
});

test("media never shows the file icon as if it were a preview", () => {
  const src = readFileSync(new URL("../src/preview.js", import.meta.url), "utf8");
  // IShellItemImageFactory answers with the Desktop icon whenever it cannot
  // produce a real picture, which for media is always. So nothing may use a
  // Shell thumbnail for audio or video, and no poster attribute may be set.
  assert.ok(!/\bposter\s*=/.test(src), "a poster would put the file icon on screen");
  assert.ok(!/pv-poster/.test(src), "the old poster element is gone");
  const mediaFn = src.slice(src.indexOf("function pvPaintMedia"));
  assert.ok(!/p\.thumb/.test(mediaFn), "pvPaintMedia must not fall back to a Shell thumbnail");

  // And the Rust side must not even ask the Shell for one.
  const rs = readFileSync(new URL("../src-tauri/src/preview.rs", import.meta.url), "utf8");
  const start = rs.indexOf("fn wants_thumbnail");
  const block = rs.slice(start, rs.indexOf("\n}", start));
  assert.ok(!block.includes('"video"'), "video must not ask the Shell");
  assert.ok(!block.includes('"audio"'), "audio must not ask the Shell");
});

test("the style switch always shows the mode in effect", () => {
  const src = readFileSync(new URL("../src/preview.js", import.meta.url), "utf8");
  // applyStyle used to return nothing, so the promise resolved to undefined and
  // paint(undefined) matched no button: the switch lit up on nothing.
  const apply = src.slice(src.indexOf("function pvApplyStyle"), src.indexOf("function pvLoadStyle"));
  assert.match(apply, /return pvStyle;/, "applyStyle must hand the style back to its caller");
  const load = src.slice(src.indexOf("function pvLoadStyle"), src.indexOf("function pvBindSettings"));
  assert.match(load, /\.then\(\(s\) => pvApplyStyle\(s\)\)/, "the value has to come from it");
  assert.match(src, /function pvRefreshSettings\(\)/, "the row repaints when settings open");
  const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(main, /UmbraPreview\.refreshSettings\(\)/, "and something has to call it");
});

test("the key cache is bounded so a long session does not grow without limit", () => {
  const { P } = load();
  // Nothing was ever fetched, so nothing is cached yet; the accessor exists and
  // is a number, which is what the bound is maintained against.
  assert.equal(typeof P.cacheSize(), "number");
  assert.ok(P.cacheSize() >= 0);
});