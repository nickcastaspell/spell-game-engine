#!/usr/bin/env bash
# Avvio rapido per lo sviluppo locale: installa le dipendenze se mancano,
# crea .env se non esiste, builda, carica le game definition nel DB
# (idempotente: se sono già uguali non fa nulla) e avvia il server in
# modalità sviluppo (riavvio automatico, strumenti DEV attivi).
set -e
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "==> Installo le dipendenze (npm install)..."
  npm install
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Creato .env da .env.example (token regia di default: nick)"
fi

echo "==> Build..."
npm run build

echo "==> Seed delle game definition..."
npm run seed

echo ""
echo "==> Avvio su http://localhost:3000"
echo "    Regia:  http://localhost:3000/control.html"
echo "    Tavolo: http://localhost:3000/team.html"
echo "    (Ctrl+C per fermare)"
echo ""

npm run dev
