// The results as a tree, flattened into the rows the list shows.
//
// Results with the same name and kind fold into one row (README.md from ten projects, a setup.exe in
// every download folder): the best of them, by the search's order, with a "+N" badge. → opens the
// group, and the others follow it, each showing the folders where its path parts from theirs.
// → on a folder opens what is in it, the same way; a folder that heads a group opens its group first,
// then itself. ← closes one level at a time. Folders and files never fold together.
//
// Every row gets, in place (so the pin and icon updates elsewhere stay on the same objects):
//   treeDepth   0 for a result, 1.. for what an opened row shows under it
//   groupNode   "g:<key>" on a group's head, which → opens
//   folderNode  "d:<path>" on a folder, which → opens
//   treeVia     the node whose opening shows this row, treeParent the row that has it
//   groupCount  on a head, how many the group has: all of them, not only the ones the search sent
//               (`copies`, search.rs), with groupMore when that is only "at least"
//   groupLabel  the path to show inside a group
// The lines in the gutter that join them are drawn from these by treelines.js.

const TREE_MAX_DEPTH = 3;

function groupKeyOf(result) {
  return result.kind + "\n" + String(result.name).toLowerCase();
}

const folderParts = (path) => path.split("\\").slice(0, -1);

// How many folders every one of `paths` shares at the start and at the end (case aside), leaving
// each at least one of its own.
function sharedFolders(paths) {
  const lists = paths.map((p) => folderParts(p).map((s) => s.toLowerCase()));
  const shortest = Math.min(...lists.map((l) => l.length));
  let pre = 0;
  while (pre < shortest - 1 && lists.every((l) => l[pre] === lists[0][pre])) pre++;
  let post = 0;
  const room = shortest - pre - 1;
  while (post < room && lists.every((l) => l[l.length - 1 - post] === lists[0][lists[0].length - 1 - post])) post++;
  // Folders every copy has somewhere in between (…\<profile>\shaderpacks\<pack>\…): they tell none apart.
  const everywhere = new Set(lists[0].filter((s) => lists.every((l) => l.includes(s))));
  return { pre, post, everywhere };
}

// A grouped row's path: the file name is the row's name already, and what every copy has is left
// out as "…", so what shows is what tells this copy from the others.
function groupFolderLabel(path, shared) {
  const own = folderParts(path);
  if (!own.length) return path;
  const { pre, post, everywhere } = shared || { pre: 0, post: 0, everywhere: new Set() };
  const middle = own.slice(pre, Math.max(pre + 1, own.length - post));
  const parts = pre ? ["…"] : [];
  for (const s of middle) {
    const common = everywhere && everywhere.has(s.toLowerCase());
    if (!common) parts.push(s);
    else if (parts[parts.length - 1] !== "…") parts.push("…");
  }
  // Nothing of its own left (copies that differ only in case): the folder as it is.
  if (parts.every((s) => s === "…")) parts.push(middle[middle.length - 1]);
  return parts.join("\\");
}

const folderNodeOf = (item) => (item.kind === "folder" && item.path ? "d:" + item.path.toLowerCase() : null);

// `open` holds the opened nodes, `contents` what each opened folder holds (node → results; missing
// while it is being read). With `group` false (Settings → group same names off) nothing folds.
function buildRows(results, query, open, contents, group = true) {
  const groups = new Map();
  if (group && String(query).trim()) {
    for (const r of results) {
      const key = groupKeyOf(r);
      const members = groups.get(key);
      if (members) members.push(r);
      else groups.set(key, [r]);
    }
  }
  const rows = [];
  const mark = (item, depth, via, parent) => {
    item.treeDepth = depth;
    item.treeVia = via;
    item.treeParent = parent;
    item.folderNode = folderNodeOf(item);
    item.groupNode = null;
    item.groupCount = 0;
    item.groupMore = false;
    item.groupLabel = null;
    rows.push(item);
  };
  // What an opened folder holds, `depth` deep.
  const showFolder = (item, depth) => {
    if (!item.folderNode || !open.has(item.folderNode) || depth > TREE_MAX_DEPTH) return;
    for (const c of contents.get(item.folderNode) || []) place(c, depth, item.folderNode, item);
  };
  const place = (item, depth, via, parent) => {
    mark(item, depth, via, parent);
    showFolder(item, depth + 1);
  };
  for (const r of results) {
    const members = groups.get(groupKeyOf(r));
    if (!members || members.length < 2) {
      place(r, 0, null, null);
      continue;
    }
    if (members[0] !== r) continue; // the rest come with their head
    const node = "g:" + groupKeyOf(r);
    const shared = sharedFolders(members.map((m) => m.path));
    const groupOpen = open.has(node);
    mark(r, 0, null, null);
    r.groupNode = node;
    r.groupCount = Math.max(members.length, r.copies || 0);
    r.groupMore = !!r.copies_more;
    r.groupLabel = groupFolderLabel(r.path, shared);
    // The head is a copy too: what its own folder holds comes under it, a level below its group.
    showFolder(r, groupOpen ? 2 : 1);
    if (!groupOpen) continue;
    for (const m of members.slice(1)) {
      place(m, 1, node, r);
      m.groupLabel = groupFolderLabel(m.path, shared);
    }
  }
  return rows;
}
