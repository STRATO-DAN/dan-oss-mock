# [DAN] MOCK — developer & CI entry points. Everything here is Node stdlib + POSIX shell only,
# no dependencies to install. `make` on its own prints help.
.DEFAULT_GOAL := help
.PHONY: help test attack demo bench

help: ## Show this help
	@echo "[DAN] MOCK — make targets:"
	@echo
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-8s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Zero runtime dependencies — pure Node standard library (Node >= 18)."

test: ## Run the full unit test suite
	node --test test/*.test.mjs

attack: ## Run ONLY the adversarial/hardening tests (malformed input, DNS-rebind, CRLF, crash-survival)
	@echo "[DAN] MOCK — adversarial suite: malformed route -> 400, DNS-rebind -> 403, CRLF header-injection"
	@echo "reject, corrupt data-file tolerance, crash-survival of a pre-persisted bad route, delayMs cap."
	@echo "────────────────────────────────────────────────────────────────────────────"
	node --test test/server.test.mjs test/store.test.mjs

demo: ## Reproducible end-to-end run: define a route, hit it, show the honest 404 (temp data file)
	node scripts/demo.mjs

bench: ## Serving latency + match-cost scaling at 1/100/1000 routes (real numbers, < ~15s)
	node scripts/bench.mjs
