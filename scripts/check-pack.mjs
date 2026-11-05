// Fails unless `npm pack` would ship exactly what users need: the built
// package, its sources for the ./test export, and the docs. Nothing else.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [pack] = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
  }),
);
const files = pack.files.map((f) => f.path);
const problems = [];

const allowed = [
  /^package\.json$/,
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^LICENSE$/,
  /^THIRD_PARTY_NOTICES\.md$/,
  /^LICENSE-APACHE-2\.0$/,
  /^dist\/(client|component)\/.+\.(js|d\.ts|js\.map|d\.ts\.map)$/,
  /^dist\/test\.(js|d\.ts|js\.map|d\.ts\.map)$/,
  /^src\/(client|component)\/.+\.ts$/,
  /^src\/test\.ts$/,
];
const forbidden = [/\.test\.ts$/, /fixtures/, /\.env/, /\.tgz$/, /^example\//, /\.convex/];

for (const file of files) {
  if (!allowed.some((re) => re.test(file))) problems.push(`not allowed: ${file}`);
  if (forbidden.some((re) => re.test(file))) problems.push(`forbidden: ${file}`);
}

// Every export target must be in the package.
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const targets = new Set();
for (const entry of Object.values(pkg.exports)) {
  if (typeof entry === "string") targets.add(entry);
  else for (const t of Object.values(entry)) targets.add(t);
}
const required = [
  "./README.md",
  "./LICENSE",
  "./CHANGELOG.md",
  "./THIRD_PARTY_NOTICES.md",
  "./LICENSE-APACHE-2.0",
];
for (const target of [...targets, ...required]) {
  if (!files.includes(target.replace(/^\.\//, ""))) problems.push(`missing: ${target}`);
}

if (problems.length) {
  console.error(`npm pack check failed (${files.length} files):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`npm pack check passed: ${files.length} files, ${pack.size} bytes packed`);
