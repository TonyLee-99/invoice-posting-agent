# Offline by default: `make check` makes zero LLM calls (replay cache) and needs only Postgres.
SHELL := /bin/bash
N ?= 40
SEEDS ?= 50

.PHONY: qbo-auth qbo-contract qbo-live-demo init data check lint types test eval-check chaos chaos-full reproduce demo demo-export verify ui-e2e

init:
	npm ci
	cd apps/review && npx playwright install chromium

data:            ## download the public datasets into data/raw (about 230 MB) and build the manifest
	mkdir -p data/raw/ipp data/raw/katana
	uvx --from huggingface_hub hf download drew-ipp/invoice-extraction-benchmark --repo-type dataset --local-dir data/raw/ipp
	for s in test validation train; do curl -sSL -o data/raw/katana/$$s.parquet "https://huggingface.co/datasets/katanaml-org/invoices-donut-data-v1/resolve/refs%2Fconvert%2Fparquet/default/$$s/0000.parquet"; done
	npx tsx eval/prepare.ts

lint:
	npx eslint .
types:
	npx tsc -p tsconfig.json --noEmit
	cd apps/review && npx tsc --noEmit
test:
	npx vitest run
chaos:           ## CI-sized chaos run; writes results/chaos_ci.json (the committed 300-seed run is results/chaos.json)
	npx tsx eval/chaos.ts --seeds $(SEEDS) --shards 4 --out results/chaos_ci.json
	npx tsx scripts/check_results.ts chaos results/chaos_ci.json
check: lint types test chaos eval-check
	npx tsx scripts/check_results.ts all

eval-check:      ## re-run the eval from the replay cache and diff against results/ (needs `make data`)
	npx tsx eval/run.ts --n $(N) --backend replay --check
chaos-full:      ## 300 seeds + 4 ablations x 100 seeds -> results/chaos.json
	npx tsx eval/chaos.ts --seeds 300 --ablation-seeds 100 --ablations --shards 4 --out results/chaos.json
reproduce:       ## live path: parse + LLM via `claude -p` (<= 4 concurrent) + eval, then the recorded demo
	npx tsx eval/run.ts --n $(N) --backend claude-cli
	npx tsx scripts/demo.ts --export --backend claude-cli
demo:            ## API on :4000 + worker against the emulator; then `npm run dev -w @ipa/review`
	npx tsx scripts/demo.ts --serve
demo-export:     ## static GitHub Pages demo into docs/demo
	npx tsx scripts/demo.ts --export
	npx tsx scripts/export_static.ts
ui-e2e:
	cd apps/review && npx playwright test
verify:
	npx tsx scripts/verify_features.ts

## Live QuickBooks Online sandbox (needs the owner's Intuit app; see docs/RUNBOOK.md). All three skip cleanly without credentials.
qbo-auth:        ## one-time OAuth connect: local server on :8777/callback, tokens -> private/qbo_tokens.json (0600)
	npx tsx scripts/qbo/auth.ts
qbo-contract:    ## sandbox contract checks for docs/QBO_SEMANTICS.md -> results/qbo_live_contract.json
	npx tsx scripts/qbo/contract.ts
qbo-live-demo:   ## ~10 Bills through the real pipeline + worker SIGKILL + reconciliation -> results/qbo_live_demo.json
	npx tsx scripts/qbo/live_demo.ts --n 10
