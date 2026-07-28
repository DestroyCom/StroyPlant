SHELL := /bin/bash
.DEFAULT_GOAL := help

# BLE provider used by `make dev` / `make backend` (mock | noble-bridge | node-ble)
# Passed explicitly as an env var to the process (more reliable than counting on
# backend/.env being loaded, which only happens as a side effect of Prisma).
BLE ?= mock

ADMIN_EMAIL ?= admin@example.com
ADMIN_PASSWORD ?= changeme

.PHONY: help install dev backend frontend noble-bridge \
	db-migrate db-seed db-wipe db-studio import-species \
	lint lint-fix typecheck stop

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install the pnpm workspace dependencies
	pnpm install

## --- Running services ---

backend: ## Run only the backend (e.g. make backend BLE=noble-bridge)
	cd backend && BLE_PROVIDER=$(BLE) pnpm dev

frontend: ## Run only the frontend (Vite proxy to the backend on :3000)
	cd frontend && pnpm dev

noble-bridge: ## Run only noble-bridge (macOS only, native Bluetooth)
	cd noble-bridge && pnpm dev

dev: ## Run everything at once (e.g. make dev BLE=noble-bridge)
	@trap 'kill 0' EXIT INT TERM; \
	(cd backend && BLE_PROVIDER=$(BLE) pnpm dev) & \
	(cd frontend && pnpm dev) & \
	if [ "$(BLE)" = "noble-bridge" ]; then (cd noble-bridge && pnpm dev) & fi; \
	wait

stop: ## Stop all Node processes for this project (useful if `dev` was killed without cleaning up)
	@pids=$$(lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null | grep -E ':(5173|3000|4100)\b' | awk '{print $$2}' | sort -u); \
	if [ -n "$$pids" ]; then echo "Stopping PIDs: $$pids"; kill $$pids; fi; \
	pkill -f "tsx watch (src/index|src/server)\.ts" 2>/dev/null; \
	echo "Done."

## --- Database ---

db-migrate: ## Apply Prisma migrations (backend/prisma)
	cd backend && pnpm prisma:migrate

db-seed: ## Create/reset the admin account (ADMIN_EMAIL/ADMIN_PASSWORD overridable)
	cd backend && ADMIN_EMAIL=$(ADMIN_EMAIL) ADMIN_PASSWORD=$(ADMIN_PASSWORD) pnpm seed:admin

db-wipe: ## Delete the local SQLite DB and replay migrations (destructive, dev only)
	@read -p "Delete backend/prisma/dev.db and replay migrations? [y/N] " ans; \
	if [ "$$ans" = "y" ] || [ "$$ans" = "Y" ]; then \
		rm -f backend/prisma/dev.db; \
		cd backend && pnpm prisma:migrate; \
		echo "DB reset — remember to rerun 'make db-seed'."; \
	else \
		echo "Cancelled."; \
	fi

db-studio: ## Open Prisma Studio to explore the DB
	cd backend && pnpm exec prisma studio

import-species: ## Import/refresh the species database (WatchFlower CSV, Health Engine)
	cd backend && pnpm import:species

## --- Quality ---

lint: ## Lint (Biome) across the whole repo
	pnpm lint

lint-fix: ## Lint + auto-fix
	pnpm lint:fix

typecheck: ## Typecheck all 3 packages
	cd backend && pnpm exec tsc -p tsconfig.json --noEmit
	cd frontend && pnpm typecheck
	cd noble-bridge && pnpm exec tsc -p tsconfig.json --noEmit
