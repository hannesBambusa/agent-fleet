var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main/git/seed.ts
var seed_exports = {};
__export(seed_exports, {
  seedApply: () => seedApply,
  seedAuto: () => seedAuto,
  seedPlan: () => seedPlan
});
module.exports = __toCommonJS(seed_exports);
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var COPY = [
  /^\.env(\..+)?$/,
  /\.env$/,
  /^\.npmrc$/,
  /^\.yarnrc(\.yml)?$/,
  /^\.tool-versions$/,
  /^\.python-version$/,
  /^\.ruby-version$/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /^credentials\.json$/,
  /^service-account.*\.json$/,
  /^\.secrets(\..+)?$/,
  /^local\.settings\.json$/
];
var LINK = ["node_modules", "vendor", ".venv", "venv", ".bundle", "Pods", ".yarn"];
var SKIP = [".claude", ".git", "commit", ".DS_Store", ".idea"];
var MAX_COPY = 4 * 1024 * 1024;
function git(cwd, args) {
  return new Promise((resolve) => {
    (0, import_node_child_process.execFile)("git", args, { cwd, timeout: 15e3, maxBuffer: 8 * 1024 * 1024 }, (_e, stdout) => resolve(stdout));
  });
}
function base(path) {
  return path.split("/").filter(Boolean).pop() ?? path;
}
async function seedPlan(repoPath, worktree) {
  const out = await git(repoPath, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
  const raw = out.split("\0").filter(Boolean);
  const dirs = raw.filter((p) => p.endsWith("/"));
  const paths = raw.filter((p) => !dirs.some((d) => p !== d && p.startsWith(d)));
  const items = [];
  for (const p of paths) {
    const clean = p.replace(/\/$/, "");
    const name = base(clean);
    if (SKIP.includes(name) || clean.split("/").some((seg) => SKIP.includes(seg))) continue;
    const isDir = p.endsWith("/");
    const from = (0, import_node_path.join)(repoPath, clean);
    let size = 0;
    try {
      size = isDir ? 0 : (0, import_node_fs.statSync)(from).size;
    } catch {
      continue;
    }
    const kind = isDir ? LINK.includes(name) ? "link" : null : COPY.some((re) => re.test(name)) && size <= MAX_COPY ? "copy" : null;
    if (!kind) continue;
    items.push({ path: clean, kind, size, present: (0, import_node_fs.existsSync)((0, import_node_path.join)(worktree, clean)) });
  }
  items.sort((a, b) => a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "copy" ? -1 : 1);
  return { repoPath, worktree, items };
}
function seedApply(repoPath, worktree, items) {
  const done = [];
  const failed = [];
  for (const it of items) {
    const from = (0, import_node_path.join)(repoPath, it.path);
    const to = (0, import_node_path.join)(worktree, it.path);
    try {
      if ((0, import_node_fs.existsSync)(to) || (0, import_node_fs.lstatSync)(to, { throwIfNoEntry: false })) {
        continue;
      }
      (0, import_node_fs.mkdirSync)((0, import_node_path.dirname)(to), { recursive: true });
      if (it.kind === "link") (0, import_node_fs.symlinkSync)(from, to, "dir");
      else (0, import_node_fs.copyFileSync)(from, to);
      done.push(it.path);
    } catch {
      failed.push(it.path);
    }
  }
  return { done, failed };
}
async function seedAuto(repoPath, worktree) {
  const plan = await seedPlan(repoPath, worktree);
  const wanted = plan.items.filter((i) => i.kind === "copy" && !i.present);
  if (!wanted.length) return [];
  return seedApply(repoPath, worktree, wanted).done;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  seedApply,
  seedAuto,
  seedPlan
});
