import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const SRC = (f) => read("../src/" + f);

test("the floating full preview is gone", () => {
  assert.ok(!existsSync(new URL("../src/preview.js", import.meta.url)), "preview.js is deleted");
  const html = SRC("index.html");
  assert.ok(!/src="preview\.js/.test(html), "the page does not load it");
  assert.ok(!/data-action="preview"/.test(html), "no context-menu item opens it");
  assert.ok(!/UmbraPreview/.test(SRC("main.js") + SRC("keynav.js") + SRC("sidepreview.js")), "nobody calls it");
  assert.ok(!/previewFull/.test(SRC("keybinds.js")), "no key is bound to it");
  assert.ok(!/#preview-panel|\.pv-/.test(SRC("styles.css")), "its styles are gone");
});

test("Shift+Space is taken by the side preview, in the capture phase", () => {
  const src = SRC("sidepreview.js");
  assert.match(src, /document\.addEventListener\("keydown"[\s\S]*?kbMatches\(e, "previewHold"\)[\s\S]*?\}, true\);/);
  assert.match(src, /kbReleases\(e, "previewHold"\)/, "and the release ends the hold");
});

test("the asset protocol is scoped to media and animated images, not to the whole disk", () => {
  const conf = JSON.parse(read("../src-tauri/tauri.conf.json"));
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
  const csp = conf.app.security.csp;
  assert.match(csp, /media-src[^;]*http:\/\/asset\.localhost/, "media-src must allow the asset URL");
  assert.match(csp, /media-src[^;]*blob:/, "and blob URLs");
});

test("media never asks the Shell for a thumbnail", () => {
  // IShellItemImageFactory answers with the Desktop icon whenever it cannot produce a real
  // picture, which for media is always.
  const rs = read("../src-tauri/src/preview.rs");
  const start = rs.indexOf("fn wants_thumbnail");
  const block = rs.slice(start, rs.indexOf("\n}", start));
  assert.ok(!block.includes('"video"'), "video must not ask the Shell");
  assert.ok(!block.includes('"audio"'), "audio must not ask the Shell");
});
