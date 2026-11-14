import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL("../src/tree.js", import.meta.url), "utf8"), ctx);
const { buildRows, groupFolderLabel, sharedFolders } = ctx;

const p = String.raw;
const r = (name, path, kind = "document") => ({ name, path, kind });
// Arrays made inside the sandbox have its own Array, so they are copied out before comparing.
const list = (rows, f) => Array.from(rows, f);
const paths = (rows) => list(rows, (x) => x.path);
const build = (results, open = [], contents = new Map(), query = "q") => buildRows(results, query, new Set(open), contents);

test("results with the same name fold into their best one", () => {
  const results = [r("README.md", "a"), r("notes.txt", "b"), r("readme.md", "c"), r("README.md", "d")];
  const rows = build(results);
  assert.deepEqual(paths(rows), ["a", "b"]);
  assert.equal(rows[0].groupCount, 3, "the head counts the whole group");
  assert.equal(rows[1].groupNode, null, "a single result is no group");
});

test("an opened group lists the others right after its head, in the search's order", () => {
  const results = [r("README.md", "a"), r("notes.txt", "b"), r("README.md", "c"), r("README.md", "d")];
  const node = build(results)[0].groupNode;
  const rows = build(results, [node]);
  assert.deepEqual(paths(rows), ["a", "c", "d", "b"]);
  assert.deepEqual(list(rows, (x) => x.treeDepth), [0, 1, 1, 0]);
  assert.equal(rows[1].treeParent, rows[0]);
  assert.equal(rows[1].treeVia, node);
});

test("a folder and a file of the same name stay apart, and the empty box is not grouped", () => {
  assert.equal(build([r("Umbra", "a", "folder"), r("Umbra", "b", "app")]).length, 2);
  const results = [r("a.txt", "1"), r("a.txt", "2")];
  build(results);
  const rows = build(results, [], new Map(), "  ");
  assert.ok(rows.length === 2 && list(rows, (x) => x.groupNode).every((g) => g === null));
});

test("an opened folder shows what it holds under it, and a folder in it opens in turn", () => {
  const docs = r("docs", p`C:\docs`, "folder");
  const inner = r("old", p`C:\docs\old`, "folder");
  const contents = new Map([
    ["d:" + p`c:\docs`, [inner, r("a.md", p`C:\docs\a.md`)]],
    ["d:" + p`c:\docs\old`, [r("b.md", p`C:\docs\old\b.md`)]],
  ]);
  const rows = build([docs, r("x.txt", "x")], ["d:" + p`c:\docs`,"d:" + p`c:\docs\old`], contents);
  assert.deepEqual(list(rows, (x) => x.name), ["docs", "old", "b.md", "a.md", "x.txt"]);
  assert.deepEqual(list(rows, (x) => x.treeDepth), [0, 1, 2, 1, 0]);
  assert.equal(rows[2].treeParent, inner, "b.md hangs off old");
  assert.equal(rows[3].treeParent, docs, "a.md off docs");
  assert.equal(rows[4].treeVia, null);
});

test("a folder heading a group opens its group first, and its own contents go a level below", () => {
  const a = r("src", p`C:\one\src`, "folder");
  const b = r("src", p`C:\two\src`, "folder");
  const contents = new Map([["d:" + p`c:\one\src`, [r("main.rs", p`C:\one\src\main.rs`)]]]);
  const node = build([a, b])[0].groupNode;
  const rows = build([a, b], [node, "d:" + p`c:\one\src`], contents);
  assert.deepEqual(list(rows, (x) => x.name), ["src", "main.rs", "src"]);
  assert.deepEqual(list(rows, (x) => x.treeDepth), [0, 2, 1]);
  assert.equal(rows[1].treeVia, "d:" + p`c:\one\src`, "its own contents hang off the folder");
  assert.equal(rows[2].treeVia, node, "the other copy off the group");
});

test("a grouped row's path starts where it parts from the others", () => {
  const paths = [
    p`D:\mods\A\v1\lockProperties\instructions\readme.properties`,
    p`D:\mods\A\v2\lockProperties\instructions\readme.properties`,
  ];
  const shared = sharedFolders(paths);
  assert.equal(shared.pre, 3);
  assert.equal(shared.post, 2);
  assert.equal(groupFolderLabel(paths[0], shared), p`…\v1`);
  // Profiles that differ, each with packs that differ: the folder every copy has in between folds
  // away too, so both differences show.
  const deep = [p`D:\M\profiles\Z\packs\Comp_1\s\r.p`, p`D:\M\profiles\Bratva\packs\Comp_2\s\r.p`];
  assert.equal(groupFolderLabel(deep[1], sharedFolders(deep)), p`…\Bratva\…\Comp_2`);
  // Nothing shared: the whole folder.
  assert.equal(groupFolderLabel(p`C:\x\a.txt`, sharedFolders([p`C:\x\a.txt`, p`D:\y\a.txt`])), p`C:\x`);
});

test("with grouping turned off nothing folds", () => {
  const results = [r("README.md", "a"), r("README.md", "b")];
  const rows = buildRows(results, "readme", new Set(), new Map(), false);
  assert.equal(rows.length, 2);
  assert.ok(Array.from(rows, (x) => x.groupNode).every((g) => g === null));
});

test("a head counts all the copies the search found, not only the ones it sent", () => {
  const head = { ...r("README.md", "a"), copies: 300 };
  const rows = buildRows([head, r("README.md", "b")], "readme", new Set(), new Map());
  assert.equal(rows[0].groupCount, 300);
  assert.equal(rows[0].groupMore, false);
  const cut = buildRows([{ ...r("a.txt", "x"), copies: 900, copies_more: true }, r("a.txt", "y")], "a", new Set(), new Map());
  assert.equal(cut[0].groupMore, true);
});
