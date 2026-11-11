// Build the static review UI (reads apps/review/public/demo-data) and place it in docs/demo for GitHub Pages.
import { execSync } from "node:child_process";
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const app = path.join(ROOT, "apps/review");
execSync("npx next build", { cwd: app, stdio: "inherit", env: { ...process.env, STATIC_DEMO: "1", PAGES_BASE_PATH: process.env.PAGES_BASE_PATH ?? "/invoice-posting-agent/demo" } });
const target = path.join(ROOT, "docs/demo");
if (existsSync(target)) rmSync(target, { recursive: true });
cpSync(path.join(app, "out"), target, { recursive: true });
writeFileSync(path.join(target, ".nojekyll"), "");
console.log(`static demo -> ${target}`);
