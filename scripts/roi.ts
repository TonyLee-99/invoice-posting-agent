// **Simulated** ROI assumption model with sensitivity. Only autoRate and LLM cost come from results/; every other
// input is an assumption (labelled) for a 600-invoice/month AP team. `tsx scripts/roi.ts` -> results/roi.json
import { readFileSync, writeFileSync } from "node:fs";

const routing = JSON.parse(readFileSync("results/routing.json", "utf8"));
const cost = JSON.parse(readFileSync("results/cost.json", "utf8"));
const A = { invoicesPerMonth: 600, manualMinutes: 6, reviewMinutes: 2.5, loadedCostPerHour: 38, duplicateRateManual: 0.002, avgInvoiceUsd: 2400, duplicateRecoveryShare: 0.7, platformCostPerMonth: 150 };
const measured = { autoRate: routing.chosen.autoRate as number, llmUsdPerInvoice: cost.perInvoiceUsdMean as number };

function monthlySaving(a: typeof A, autoRate: number) {
  const manual = a.invoicesPerMonth * a.manualMinutes / 60 * a.loadedCostPerHour;
  const withTool = a.invoicesPerMonth * (1 - autoRate) * a.reviewMinutes / 60 * a.loadedCostPerHour;
  const duplicateLossAvoided = a.invoicesPerMonth * a.duplicateRateManual * a.avgInvoiceUsd * (1 - a.duplicateRecoveryShare);
  const run = a.platformCostPerMonth + a.invoicesPerMonth * measured.llmUsdPerInvoice;
  return Math.round(manual - withTool + duplicateLossAvoided - run);
}
const grid = [];
for (const autoRate of [0, measured.autoRate, 0.4, 0.6])
  for (const reviewMinutes of [1.5, 2.5, 4])
    grid.push({ autoRate: Math.round(autoRate * 1000) / 1000, reviewMinutes, monthlySavingUsd: monthlySaving({ ...A, reviewMinutes }, autoRate) });
const out = { label: "Simulated assumption model", assumptions: A, measured, baseCaseMonthlySavingUsd: monthlySaving(A, measured.autoRate), sensitivity: grid,
  note: "Duplicate-loss term uses an assumed manual duplicate rate; the chaos suite measures duplicates under injected faults, not in a real AP team." };
writeFileSync("results/roi.json", JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ base: out.baseCaseMonthlySavingUsd, measured }));
