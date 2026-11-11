// Runs each feature's verification command and records state + evidence in feature_list.json (the only writer).
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const file = path.join(ROOT, "feature_list.json");
const features = JSON.parse(readFileSync(file, "utf8")) as { id: string; behavior: string; verification: string; state: string; evidence: string }[];
const only = process.argv[2];
for (const f of features) {
  if (only && f.id !== only) continue;
  const t0 = Date.now();
  try {
    const out = execSync(f.verification, { cwd: ROOT, stdio: "pipe", timeout: 600_000 }).toString();
    f.state = "passing";
    f.evidence = `${new Date().toISOString()} exit 0 in ${Date.now() - t0} ms: ${out.trim().split("\n").slice(-2).join(" | ").slice(0, 200)}`;
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    f.state = "failing";
    f.evidence = `${new Date().toISOString()} nonzero: ${(err.stderr?.toString() || err.stdout?.toString() || "").trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`;
  }
  console.log(`${f.id} ${f.state}`);
}
writeFileSync(file, JSON.stringify(features, null, 2) + "\n");
