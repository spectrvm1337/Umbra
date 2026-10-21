import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("the first-run setup is wired into the page", () => {
  const html = read("../src/index.html");
  assert.match(html, /id="setup"/, "the overlay exists");
  assert.match(html, /src="setup\.js/, "and its script is loaded");
  assert.match(html, /id="setting-setup-btn"/, "settings can run it again");
  assert.match(read("../src/main.js"), /UmbraSetup\.open/, "main.js opens it");
});

test("every setup step has its title in each language", () => {
  const i18n = read("../src/i18n.js");
  for (const key of ["setupRun", "lblSetup"]) {
    assert.equal(i18n.split(` ${key}:`).length - 1, 4, key);
  }
});
