SHELL := /bin/bash
.DEFAULT_GOAL := help

# Provider BLE utilisé par `make dev` / `make backend` (mock | noble-bridge | node-ble)
# Passé explicitement en variable d'env au process (plus fiable que de compter sur le
# chargement de backend/.env, qui ne se produit que comme effet de bord de Prisma).
BLE ?= mock

ADMIN_EMAIL ?= admin@example.com
ADMIN_PASSWORD ?= changeme

.PHONY: help install dev backend frontend noble-bridge \
	db-migrate db-seed db-wipe db-studio \
	lint lint-fix typecheck stop

help: ## Affiche cette aide
	@grep -E '^[a-zA-Z_-]+:.*## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Installe les dépendances du workspace pnpm
	pnpm install

## --- Lancement des services ---

backend: ## Lance uniquement le backend (ex: make backend BLE=noble-bridge)
	cd backend && BLE_PROVIDER=$(BLE) pnpm dev

frontend: ## Lance uniquement le frontend (proxy Vite vers le backend :3000)
	cd frontend && pnpm dev

noble-bridge: ## Lance uniquement noble-bridge (macOS uniquement, Bluetooth natif)
	cd noble-bridge && pnpm dev

dev: ## Lance tout en même temps (ex: make dev BLE=noble-bridge)
	@trap 'kill 0' EXIT INT TERM; \
	(cd backend && BLE_PROVIDER=$(BLE) pnpm dev) & \
	(cd frontend && pnpm dev) & \
	if [ "$(BLE)" = "noble-bridge" ]; then (cd noble-bridge && pnpm dev) & fi; \
	wait

stop: ## Arrête tous les process Node du projet (utile si `dev` a été tué sans nettoyer)
	@pids=$$(lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null | grep -E ':(5173|3000|4100)\b' | awk '{print $$2}' | sort -u); \
	if [ -n "$$pids" ]; then echo "Arrêt des PIDs: $$pids"; kill $$pids; fi; \
	pkill -f "tsx watch (src/index|src/server)\.ts" 2>/dev/null; \
	echo "Terminé."

## --- Base de données ---

db-migrate: ## Applique les migrations Prisma (backend/prisma)
	cd backend && pnpm prisma:migrate

db-seed: ## Crée/reset le compte admin (ADMIN_EMAIL/ADMIN_PASSWORD overridables)
	cd backend && ADMIN_EMAIL=$(ADMIN_EMAIL) ADMIN_PASSWORD=$(ADMIN_PASSWORD) pnpm seed:admin

db-wipe: ## Supprime la DB SQLite locale et rejoue les migrations (destructif, dev only)
	@read -p "Supprimer backend/prisma/dev.db et rejouer les migrations ? [y/N] " ans; \
	if [ "$$ans" = "y" ] || [ "$$ans" = "Y" ]; then \
		rm -f backend/prisma/dev.db; \
		cd backend && pnpm prisma:migrate; \
		echo "DB réinitialisée — pense à relancer 'make db-seed'."; \
	else \
		echo "Annulé."; \
	fi

db-studio: ## Ouvre Prisma Studio pour explorer la DB
	cd backend && pnpm exec prisma studio

## --- Qualité ---

lint: ## Lint (Biome) sur tout le repo
	pnpm lint

lint-fix: ## Lint + fix automatique
	pnpm lint:fix

typecheck: ## Vérifie les types sur les 3 packages
	cd backend && pnpm exec tsc -p tsconfig.json --noEmit
	cd frontend && pnpm typecheck
	cd noble-bridge && pnpm exec tsc -p tsconfig.json --noEmit
