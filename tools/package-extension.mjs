#!/usr/bin/env node

import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const EXTENSION_ROOT = path.join(ROOT, "apps/extension");
const DIST_ROOT = path.join(ROOT, "dist");
const MANIFEST_PATH = path.join(EXTENSION_ROOT, "manifest.json");
const RUNTIME_FILES = [
  "manifest.json",
  "assets/icons/rutype_icon16.png",
  "assets/icons/rutype_icon32.png",
  "assets/icons/rutype_icon48.png",
  "assets/icons/rutype_icon128.png",
  "src/background/service-worker.js",
  "src/content/autocomplete-dictionary.generated.js",
  "src/content/autocomplete-engine.js",
  "src/content/content-script.js",
  "src/popup/popup.html",
  "src/popup/popup.css",
  "src/popup/popup.js",
  "src/options/options.html",
  "src/options/options.css",
  "src/options/options.js",
  "src/selection/selection.html",
  "src/selection/selection.css",
  "src/selection/selection.js"
];
const FORBIDDEN_PACKAGE_PARTS = [
  ".DS_Store",
  "dev/",
  "data/",
  "src/content/russian-grammar-rules.js"
];

const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
const version = manifest.version;
const packageName = `rustype-extension-${version}`;
const packageRoot = path.join(DIST_ROOT, packageName);
const zipPath = path.join(DIST_ROOT, `${packageName}.zip`);

await rm(packageRoot, { recursive: true, force: true });
await rm(zipPath, { force: true });
await mkdir(packageRoot, { recursive: true });

for (const relativePath of RUNTIME_FILES) {
  await copyRuntimeFile(relativePath);
}

validateManifestReferences(manifest);
validateForbiddenFiles();
await createZip();

const zipStats = await stat(zipPath);
console.log(`Created ${path.relative(ROOT, zipPath)} (${formatBytes(zipStats.size)})`);
console.log(`Staging folder: ${path.relative(ROOT, packageRoot)}`);

async function copyRuntimeFile(relativePath) {
  const source = path.join(EXTENSION_ROOT, relativePath);
  const target = path.join(packageRoot, relativePath);

  if (!existsSync(source)) {
    throw new Error(`Missing runtime file: ${relativePath}`);
  }

  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
}

function validateManifestReferences(currentManifest) {
  const referencedFiles = new Set([
    currentManifest.background?.service_worker,
    currentManifest.action?.default_popup,
    currentManifest.options_page,
    ...Object.values(currentManifest.icons ?? {}),
    ...Object.values(currentManifest.action?.default_icon ?? {}),
    ...currentManifest.content_scripts.flatMap((script) => script.js ?? [])
  ].filter(Boolean));

  for (const relativePath of referencedFiles) {
    const filePath = path.join(packageRoot, relativePath);

    if (!existsSync(filePath)) {
      throw new Error(`Manifest references a file that is not packaged: ${relativePath}`);
    }
  }
}

function validateForbiddenFiles() {
  for (const forbiddenPart of FORBIDDEN_PACKAGE_PARTS) {
    const forbiddenPath = path.join(packageRoot, forbiddenPart);

    if (existsSync(forbiddenPath)) {
      throw new Error(`Forbidden package content detected: ${forbiddenPart}`);
    }
  }
}

async function createZip() {
  const zipCheck = spawnSync("zip", ["-v"], { stdio: "ignore" });

  if (zipCheck.error) {
    throw new Error("The `zip` command is required to create a Chrome Web Store package.");
  }

  const result = spawnSync("zip", ["-qr", zipPath, "."], {
    cwd: packageRoot,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    throw new Error(`zip failed with status ${result.status}`);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kib = bytes / 1024;

  if (kib < 1024) {
    return `${kib.toFixed(1)} KB`;
  }

  return `${(kib / 1024).toFixed(2)} MB`;
}
