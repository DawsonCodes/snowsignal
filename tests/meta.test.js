// Project-metadata guards: MIT license presence and the beta.3 version stamp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const VERSION = "1.0.0";

test("a root MIT LICENSE file exists and GitHub can recognize it", () => {
  const license = read("LICENSE");
  assert.match(license, /MIT License/, "LICENSE must declare the MIT License");
  assert.match(license, /Permission is hereby granted, free of charge/, "standard MIT text");
  // Preserve the committed copyright holder exactly.
  assert.match(license, /Copyright \(c\) 2026 DawsonCodes/);
});

test("package.json is MIT-licensed and stamped at the release version", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.version, VERSION);
});

test("the app reports the release version in-app", () => {
  const main = read("js/main.js");
  assert.match(main, new RegExp(`APP_VERSION\\s*=\\s*"${VERSION.replace(/\./g, "\\.")}"`));
});

test("changelog and roadmap document the release and keep beta history", () => {
  const changelog = read("CHANGELOG.md");
  assert.match(changelog, /## \[1\.0\.0\]/, "CHANGELOG has a v1.0.0 entry");
  assert.match(changelog, /1\.0\.0-beta\.4/, "beta history is retained");
  assert.match(changelog, /1\.0\.0-beta\.2/, "beta history is retained");
  assert.match(read("ROADMAP.md"), /1\.0\.0/, "ROADMAP references v1.0.0");
});

test("a CONTRIBUTING guide exists", () => {
  const contributing = read("CONTRIBUTING.md");
  assert.match(contributing, /pull request/i);
  assert.match(contributing, /node --test/, "asks contributors to run the test suite");
});

test("favicon and manifest exist and are wired in relatively", () => {
  const favicon = read("favicon.svg");
  assert.match(favicon, /<svg/, "favicon.svg is an SVG");
  const manifest = JSON.parse(read("manifest.webmanifest"));
  assert.equal(manifest.name, "SnowSignal");
  assert.match(manifest.start_url, /^\.\//, "manifest start_url is relative for /SnowSignal/");
  const html = read("index.html");
  assert.match(html, /rel="icon" href="\.\/favicon\.svg"/, "favicon linked relatively");
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/, "manifest linked relatively");
});

test("no debug logging or debugger statements ship in the app modules", () => {
  for (const file of readdirSync(join(root, "js"))) {
    const src = read(join("js", file));
    assert.doesNotMatch(src, /console\.(log|debug|info|warn|error)/, `${file} has console output`);
    assert.doesNotMatch(src, /\bdebugger\b/, `${file} has a debugger statement`);
  }
});
