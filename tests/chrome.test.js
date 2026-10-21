import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Covers the small fixes around the drag-bar hint and the pinned-apps dock:
// shadow clipping on both, and the hint's show animation.

// Line endings differ between platforms, so every lookup goes through a
// normalised copy rather than matching raw bytes. Comments go too: they talk
// about properties they are not setting, and a check for one of those would
// match the prose.
const CSS_RAW = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const CSS = CSS_RAW.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
const MAIN = readFileSync(new URL("../src/main.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

// Selectors have to match at the start of a rule, not inside one: ".db-progress {"
// is also the tail of ".drag-bar.notify .db-progress {".
function rule(selector) {
  let from = 0;
  for (;;) {
    const found = CSS.indexOf(selector, from);
    if (found < 0) return "";
    const atLineStart = found === 0 || CSS[found - 1] === "\n";
    if (atLineStart) {
      const open = CSS.indexOf("{", found);
      const close = CSS.indexOf("}", open);
      return CSS.slice(open, close);
    }
    from = found + selector.length;
  }
}

test("the top hint has no glow", () => {
  const ntf = rule(".drag-bar .ntf-short,");
  assert.ok(ntf.length > 0, "the hint rule exists");
  // The window gives this hint only a few pixels above the drag bar -- in the
  // compact densities --pad-y is 6, so a vertical pad pushes the box out of
  // the window and the hint vanishes. It must stay on the original anchor.
  assert.match(ntf, /bottom:\s*18px/, "the anchor is unchanged");
  assert.ok(!/padding:\s*7px/.test(ntf), "no vertical padding: there is no room for it");
  // No halo around the text.
  assert.ok(!/text-shadow/.test(ntf), "no shadow, no glow");
  const notify = rule(".drag-bar.notify .ntf-short,");
  assert.ok(!/text-shadow/.test(notify), "and none on the shown state either");
  // The type still tells them apart, just with colour rather than a halo.
  assert.match(rule(".drag-bar.error .ntf-short,"), /--ntf-tint/, "errors have their own colour");

  // Clipping is applied per hint from JS once a measurement says the text
  // really does overflow, so a short hint is never cut.
  assert.match(ntf, /overflow:\s*visible/, "not clipped by default");
  const clip = rule(".drag-bar .ntf-short.ntf-clip,");
  assert.match(clip, /overflow:\s*hidden/, "the ellipsis rule clips only when needed");
  assert.match(clip, /text-overflow:\s*ellipsis/);

  const render = MAIN.slice(MAIN.indexOf("function renderNotify"));
  const body = render.slice(0, render.indexOf("\ndragBar.addEventListener"));
  assert.match(body, /ntfShort\.classList\.add\("ntf-clip"\)/, "the class is added from a measurement");
  assert.match(body, /scrollWidth > ntfShort\.clientWidth/, "and only when it overflows");
});

test("the drag pill has no loading bar", () => {
  // A sweep inside the pill was an idea nobody asked for. It is gone again --
  // the element, the rules and the wiring that turned it on.
  const html = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
  assert.ok(!/db-progress/.test(html), "the element is out of the markup");
  assert.ok(!/db-progress|db-sweep|db-breathe/.test(CSS), "and out of the stylesheet");
  assert.ok(!/setBusy|dbProgress|busyReasons/.test(MAIN), "and out of the script");
  // The pill is just the pill.
  assert.match(rule(".db-rect {"), /width:\s*36px/, "the handle is the handle it always was");
  assert.ok(!/width:\s*150px/.test(CSS), "nothing makes it stretch");
});


test("the hold key is handled by the side preview once, not twice", () => {
  // sidepreview.js listens on the document in the capture phase; main.js must not take the key
  // again, or the card would open and close again in the same tick.
  const src = readFileSync(new URL("../src/sidepreview.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const listen = src.slice(src.indexOf('document.addEventListener("keydown"'));
  assert.match(listen, /kbMatches\(e, "previewHold"\)/, "the capture handler decides");
  assert.match(listen, /e\.stopPropagation\(\)/, "and stops the event, so nobody else acts on it");
  const main = MAIN.slice(MAIN.indexOf('searchInput.addEventListener("keydown"'));
  const head = main.slice(0, main.indexOf("if (kbMatches(e, \"historyPrev\")"));
  assert.ok(!/previewHold|handleKey/.test(head), "the search box must not handle it a second time");
});

test("pinning renumbers the rows", () => {
  // The pinned rows come before the results, so adding or removing one moves
  // every result along. The rows kept the indices they were built with and
  // the pointer picked the wrong file.
  assert.match(MAIN, /function renumberRows\(\)/, "there is a renumbering pass");
  const renumber = MAIN.slice(MAIN.indexOf("function renumberRows()"));
  const body = renumber.slice(0, renumber.indexOf("\nfunction "));
  assert.match(body, /dataset\.index = i/, "it writes the index");
  assert.match(body, /selectableContainers\(\)/, "in the order the keyboard walks them");
  const toggle = MAIN.slice(MAIN.indexOf("async function togglePin"));
  const pinBody = toggle.slice(0, toggle.indexOf("\nconst placeholderWords"));
  assert.match(pinBody, /renumberRows\(\)/, "pinning calls it");
  // And the containers are shared, so the selection and the numbering cannot
  // disagree about the order.
  assert.match(MAIN, /function selectableContainers\(\)/);
  const apply = MAIN.slice(MAIN.indexOf("function applySelection"));
  assert.match(apply, /selectableContainers\(\)/, "the selection uses the same order");
});

test("the settings filter does not survive the panel being closed", () => {
  // The filter hid rows and nothing ever put them back, so a setting could
  // become unreachable for good.
  const toggle = MAIN.slice(MAIN.indexOf("function toggleSettings"));
  const body = toggle.slice(0, toggle.indexOf("\nsettingsBtn.addEventListener"));
  assert.match(body, /filterSettings\(searchInput\.value\)/, "the filter is applied to what is typed");
  assert.match(body, /r\.style\.display = ""/, "and every row comes back when the panel closes");
});

test("the placeholder examples come back after the window is closed", () => {
  // The timer was cleared but the variable kept pointing at a dead id, so the
  // next time the window opened the check found it set and the typing examples
  // never started again.
  const hide = MAIN.slice(MAIN.indexOf("function hideWindow"));
  const hideBody = hide.slice(0, hide.indexOf("\nfunction "));
  assert.match(hideBody, /placeholderTimer = null/, "the timer is released, not just cleared");
  const shown = MAIN.slice(MAIN.indexOf('"window-shown"'));
  const shownBody = shown.slice(0, 400);
  assert.ok(!/if \(!placeholderTimer\)/.test(shownBody), "the examples start unconditionally");
});

test("the grips and the dock tiles ease into hover", () => {
  assert.match(rule(".sp-grip {"), /transition:[\s\S]*?background-color/, "the grip fades in");
  const tile = rule(".dock-tile {");
  assert.match(tile, /transition:[\s\S]*?box-shadow/, "a tile changes colour and glow");
  // The dock is a Sortable target: the library writes transform inline on every
  // pointer move, so transitioning or styling it here makes the tile trail the
  // cursor while dragging.
  assert.ok(!/transition:[\s\S]*?\btransform\b/.test(tile), "transform must stay Sortable's");
  assert.ok(!/^\s*transform:/m.test(tile), "and must not be set on the tile itself");
  const hover = rule(".dock-tile:hover {");
  assert.ok(!/transform/.test(hover), "the hover lift is colour, not movement");
  assert.match(hover, /box-shadow/, "the glow comes up with it");
});

test("every small surface changes colour smoothly", () => {
  // The controls that used to snap: the colour swatches, the monitor buttons
  // and the zoom value all changed appearance in one step.
  assert.match(rule(".swatch {"), /transition:[\s\S]*?box-shadow/, "the swatch ring eases in");
  assert.match(rule(".swatch:hover {"), /transform:\s*scale/, "and the swatch grows");
  assert.match(rule(".monitor-btn {"), /transition:[\s\S]*?color/, "the monitor button eases");
  assert.match(rule(".monitor-btn:hover {"), /color:/, "and lightens on hover");
  assert.match(rule(".zoom-stepper span {"), /transition:[\s*]color/, "the zoom value eases");
  // The ones that already had one must keep it.
  for (const sel of [".seg-btn {", ".stepper-btn {", ".toggle {", ".settings-text-btn {", ".ctx-item {"]) {
    const r = rule(sel);
    assert.match(r, /transition:/, `${sel} has a transition`);
  }
});

test("the pinned-apps dock leaves room for the tile shadow", () => {
  const dock = rule("#pin-dock {");
  // A scroll container clips its children at the padding box, and the tiles sit
  // hard against that edge, so their glow ended in a straight cut.
  assert.match(dock, /overflow-y:\s*auto/, "the dock still scrolls");
  assert.match(dock, /width:[\s\S]*\+ 10px/, "and is 10px wider to make the room");

  const left = rule('html[data-pins="left"] #pin-dock {');
  assert.match(left, /padding-right:\s*10px/, "the room goes on the edge facing the list");
  const right = rule('html[data-pins="right"] #pin-dock {');
  assert.match(right, /padding-left:\s*10px/, "and on the other side for a right dock");
  assert.match(right, /align-items:\s*flex-start/);
});

test("the hint is hidden by opacity, never by visibility", () => {
  // An element that is `visibility: hidden` counts as not rendered, and
  // Chromium refuses to start a transition on one -- so the hint appeared with
  // no animation at all. Hiding it by opacity leaves it rendered and every
  // transition runs.
  const css = rule(".drag-bar .ntf-short,");
  assert.ok(css.length > 0, "the hint rule exists");
  assert.ok(!/visibility:\s*hidden/.test(css), "visibility must not hide it");
  assert.match(css, /opacity:\s*0/, "opacity hides it instead");
  assert.match(css, /pointer-events:\s*none/, "and it still takes no clicks");
  assert.match(css, /transition:[\s\S]*?opacity/, "with a transition on the opacity");
  assert.match(css, /transition:[\s\S]*?filter/, "and on the blur");
  assert.match(css, /transition:[\s\S]*?transform/, "and on the movement");

  // The shown state has to exist too, or there is nothing to fade to.
  const shown = rule(".drag-bar.notify.shown:not(.expanded) .ntf-short,");
  assert.match(shown, /opacity:\s*1/);
  assert.match(shown, /filter:\s*blur\(0\)/);

  // And the browser has to have computed the hidden state before the shown one
  // is applied, or there is nothing for the transition to start from.
  const render = MAIN.slice(MAIN.indexOf("function renderNotify"));
  const body = render.slice(0, render.indexOf("\ndragBar.addEventListener"));
  const notifyAt = body.indexOf('add("notify", type)');
  const flushAt = body.indexOf("offsetWidth");
  const shownAt = body.indexOf('add("shown")');
  assert.ok(
    notifyAt >= 0 && flushAt > notifyAt && shownAt > flushAt,
    "notify, then a forced layout, then shown"
  );
  assert.match(body, /void ntfShort\.offsetWidth/, "the flush is deliberate");

  // Nothing should be driving the motion from JS any more.
  assert.ok(!/\.animate\(/.test(MAIN), "the motion is CSS, not scripted");
});

test("hints are trimmed instead of running off the box", () => {
  assert.match(MAIN, /function ntfTrim/, "there is a trimmer");
  const trim = MAIN.slice(MAIN.indexOf("function ntfTrim"));
  const trimBody = trim.slice(0, trim.indexOf("\nfunction "));
  assert.match(trimBody, /slice\(-/, "it trims from the front");
  assert.ok(!/slice\(0,/.test(trimBody), "and keeps the tail, which identifies a path");
  // Both the line and its detail go through it, so a full path or a .NET
  // exception cannot blow the hint out to its full width.
  const render = MAIN.slice(MAIN.indexOf("function renderNotify"));
  assert.match(render, /ntfShort\.textContent = ntfTrim\(short\)/);
  assert.match(render, /ntfDetail\.textContent = ntfTrim\(detail \|\| short\)/);
});

test("the layout tokens the dock padding depends on still line up", () => {
  // The dock reserves space in three places; a mismatch shows as the list sliding.
  const dockJs = readFileSync(new URL("../src/dock.js", import.meta.url), "utf8");
  const cssReserve = /--dock-reserve:\s*(\d+)px/.exec(CSS);
  const jsReserve = /DOCK_RESERVE\s*=\s*(\d+)/.exec(dockJs);
  assert.ok(cssReserve && jsReserve, "both declare the reserve");
  assert.equal(cssReserve[1], jsReserve[1], "css and js agree on --dock-reserve");
});
