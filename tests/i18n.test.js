import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// i18n.js is a classic browser script that keeps its table in a top-level
// `const`, which in a vm context lives in the lexical scope rather than on the
// sandbox object -- so a second script in the same context is used to lift it
// out. It also reads window.matchMedia at module level for the reduced-motion
// check, so that stub has to answer before the script runs.
function loadTranslations() {
  const noop = () => {};
  const sandbox = {
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: noop,
    document: {
      documentElement: { dataset: {} },
      addEventListener: noop,
      removeEventListener: noop,
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { classList: { add: noop, remove: noop, toggle: noop, contains: () => false } },
    },
    navigator: { language: "en" },
    setTimeout: () => 0,
    clearTimeout: noop,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL("../src/i18n.js", import.meta.url), "utf8"), ctx);
  vm.runInContext("this.__table = TRANSLATIONS;", ctx);
  return sandbox.__table || {};
}

const T = loadTranslations();
const LANGS = ["en", "ru", "de", "ja"];

const PREVIEW_KEYS = [
  "ctxPreview",
  "pvTitle",
  "pvOpen",
  "pvReveal",
  "pvAdmin",
  "pvClose",
  "pvNone",
  "pvFailed",
  "pvTimeout",
  "pvMediaUnavailable",
  "pvMediaUnplayable",
];

test("all four languages are present", () => {
  for (const lang of LANGS) {
    assert.ok(T[lang], `${lang} is missing from the translation table`);
  }
});

test("every language carries the preview strings", () => {
  for (const lang of LANGS) {
    const missing = PREVIEW_KEYS.filter((k) => typeof T[lang][k] !== "string" || !T[lang][k]);
    assert.deepEqual(missing, [], `${lang} is missing: ${missing.join(", ")}`);
  }
});

test("every data-i18n key in index.html resolves in every language", () => {
  const html = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
  const wanted = new Set();
  for (const m of html.matchAll(/data-i18n(?:-tip)?="([^"]+)"/g)) wanted.add(m[1]);
  assert.ok(wanted.size > 40, "expected the markup to reference many keys");
  const missing = [];
  for (const lang of LANGS) {
    for (const key of wanted) {
      if (typeof T[lang][key] !== "string" || !T[lang][key]) missing.push(`${lang}:${key}`);
    }
  }
  assert.deepEqual(missing, [], `unresolved keys: ${missing.join(" ")}`);
});

// A replacement character means an edit mangled a translation and it would ship
// to users as visible garbage.
test("no translation contains a replacement character", () => {
  for (const lang of LANGS) {
    const broken = Object.entries(T[lang])
      .filter(([, v]) => typeof v === "string" && /\uFFFD/.test(v))
      .map(([k]) => k);
    assert.deepEqual(broken, [], `${lang} has mangled entries: ${broken.join(", ")}`);
  }
});

test("the languages all have the same key set", () => {
  const base = new Set(Object.keys(T.en));
  for (const lang of LANGS.filter((l) => l !== "en")) {
    const extra = Object.keys(T[lang]).filter((k) => !base.has(k));
    assert.deepEqual(extra, [], `${lang} has keys English does not: ${extra.join(", ")}`);
  }
});