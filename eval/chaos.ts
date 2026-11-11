// Chaos runner: `tsx eval/chaos.ts [--seeds 300] [--shards 4] [--ablations] [--out results/chaos.json]`
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Defenses, SeedResult } from "@ipa/posting";
import { ALL_DEFENSES, createHarness, runSeed } from "@ipa/posting";

const args = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1]! : d;
};
const seeds = Number(arg("--seeds", "300"));
const firstSeed = Number(arg("--first", "1"));
const shards = Number(arg("--shards", "4"));
const out = arg("--out", "results/chaos.json");
const ablationSeeds = Number(arg("--ablation-seeds", "100"));
const withAblations = args.includes("--ablations");

const VARIANTS: Record<string, Defenses> = {
  all_defenses: ALL_DEFENSES,
  ...(withAblations
    ? {
        no_stable_requestid: { ...ALL_DEFENSES, stableRequestId: false },
        no_query_first: { ...ALL_DEFENSES, queryFirst: false },
        no_fencing_no_lease_guard: { ...ALL_DEFENSES, fencing: false, leaseGuard: false },
        all_off: { stableRequestId: false, queryFirst: false, fencing: false, leaseGuard: false },
      }
    : {}),
};

async function runVariant(name: string, defenses: Defenses, n: number): Promise<SeedResult[]> {
  const queue = Array.from({ length: n }, (_, i) => firstSeed + i);
  const results: SeedResult[] = [];
  await Promise.all(
    Array.from({ length: shards }, async () => {
      const h = await createHarness({ dbPrefix: "ipa_chaos" });
      try {
        while (queue.length) {
          const seed = queue.shift()!;
          const r = await runSeed(h, seed, { defenses });
          results.push(r);
          if (!r.ok) process.stderr.write(`[${name}] seed ${seed} VIOLATION dup=${r.duplicates} lost=${r.lost} l!L=${r.localWithoutLedger} L!l=${r.ledgerWithoutLocal} stale=${r.staleContent} quiescent=${r.quiescentAfterFaults} residual=${r.config.residualEligible}\n`);
          if (results.length % 25 === 0) process.stderr.write(`[${name}] ${results.length}/${n}\n`);
        }
      } finally {
        await h.close();
      }
    }),
  );
  return results.sort((a, b) => a.config.seed - b.config.seed);
}

function summarize(rs: SeedResult[]) {
  const sum = (f: (r: SeedResult) => number) => rs.reduce((s, r) => s + f(r), 0);
  const faults: Record<string, number> = {};
  for (const r of rs) for (const [k, v] of Object.entries(r.faultsFired)) faults[k] = (faults[k] ?? 0) + v;
  const recovery: Record<string, number> = {};
  for (const r of rs) for (const [k, v] of Object.entries(r.recoveryOpened)) recovery[k] = (recovery[k] ?? 0) + v;
  const residual = rs.filter((r) => r.config.residualEligible);
  const nonResidual = rs.filter((r) => !r.config.residualEligible);
  const lat = rs.map((r) => r.livenessMs).sort((a, b) => a - b);
  return {
    seeds: rs.length,
    seedsWithViolation: rs.filter((r) => !r.ok).length,
    nonResidualSeeds: nonResidual.length,
    nonResidualSeedsWithViolation: nonResidual.filter((r) => !r.ok).length,
    residualEligibleSeeds: residual.length,
    residualSeedsWithDuplicate: residual.filter((r) => r.duplicates > 0).length,
    residualDuplicatesDetectedByReconcile: residual.filter((r) => r.duplicates > 0 && r.duplicateDetectedByReconcile >= r.duplicates).length,
    invoices: sum((r) => r.config.invoices),
    posted: sum((r) => r.posted),
    duplicateBills: sum((r) => r.duplicates),
    lostInvoices: sum((r) => r.lost),
    staleContentPostings: sum((r) => r.staleContent),
    ledgerLocalMismatches: sum((r) => r.localWithoutLedger + r.ledgerWithoutLocal),
    inRecoveryAfterRunbook: sum((r) => r.inRecoveryAfterRunbook),
    notQuiescent: rs.filter((r) => !r.quiescentAfterFaults).length,
    livenessMsP50: lat[Math.floor(lat.length * 0.5)] ?? null,
    livenessMsP95: lat[Math.floor(lat.length * 0.95)] ?? null,
    workerCrashes: sum((r) => r.crashes),
    editsApplied: sum((r) => r.editsApplied),
    editsRefused409: sum((r) => r.editsRefused),
    faultsFired: faults,
    recoveryItemsOpened: recovery,
  };
}

const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), command: `tsx eval/chaos.ts ${args.join(" ")}`, firstSeed, variants: {} };
for (const [name, def] of Object.entries(VARIANTS)) {
  const t = Date.now();
  const rs = await runVariant(name, def, name === "all_defenses" ? seeds : ablationSeeds);
  (report.variants as Record<string, unknown>)[name] = { defenses: def, wallMs: Date.now() - t, summary: summarize(rs), violations: rs.filter((r) => !r.ok).map((r) => ({ seed: r.config.seed, residualEligible: r.config.residualEligible, duplicates: r.duplicates, lost: r.lost, localWithoutLedger: r.localWithoutLedger, ledgerWithoutLocal: r.ledgerWithoutLocal, staleContent: r.staleContent, quiescent: r.quiescentAfterFaults })) };
  process.stderr.write(`[${name}] done: ${JSON.stringify(summarize(rs)).slice(0, 300)}\n`);
}
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(`wrote ${out}`);
