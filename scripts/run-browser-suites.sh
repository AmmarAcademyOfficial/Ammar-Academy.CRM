#!/usr/bin/env bash
# Runs every browser check, each on freshly seeded local data:
#   the console scan against DEVELOPMENT mode (where React reports hydration problems), then
#   the Phase 2–5 journeys and the accessibility scan against the PRODUCTION build.
# Needs: npm run build done, Python 3 with Playwright (pip install playwright && python3 -m playwright install chromium).
# Usage: bash scripts/run-browser-suites.sh            (all)   |   bash scripts/run-browser-suites.sh phase4 console
set -uo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd -P)"  # a plain path: the file watcher in development mode needs it
# Logs live OUTSIDE the project: development mode watches the project folder and would reload
# the page every time a log line is written.
LOGS=${CRM_TEST_LOGS:-${RUNNER_TEMP:-/tmp}/crm-test-logs}
mkdir -p "$LOGS"
export DATABASE_URL=postgres://postgres:postgres@localhost:54329/crm AUTH_MODE=local LOCAL_AUTH_SECRET=local-test-secret-not-real-0000 \
  APP_URL=http://localhost:3000 GOOGLE_MODE=fake CRON_SECRET=local-cron-secret-for-tests-only-0000 FAKE_GOOGLE_FILE="$PWD/.local/fake-google.json"
# The development-mode console scan runs first, on a clean development cache.
SUITES=${*:-"console phase2 phase3 phase4 phase5 passwords step1 step2 accounting1 accounting2 accounting3 accounting4 accounting5 a11y"}
DB_PID="" APP_PID=""

# Stops a process and its children. Next.js runs the server in a child process; leaving it behind
# makes the next development server fight it over the build folder (endless reloads).
tree() { # a process and all its descendants
  local pid=$1 child
  echo "$pid"
  for child in $(pgrep -P "$pid" 2>/dev/null); do tree "$child"; done
}
kill_tree() {
  # Collect the whole tree first: the Next.js development parent restarts a child that dies alone.
  local pids
  pids=$(tree "$1")
  kill $pids 2>/dev/null
  sleep 1
  kill -9 $pids 2>/dev/null || true
}

stop() {
  [ -n "$APP_PID" ] && kill_tree "$APP_PID"; [ -n "$DB_PID" ] && kill_tree "$DB_PID"
  wait 2>/dev/null; APP_PID="" DB_PID=""
  for _ in $(seq 1 30); do curl -s -o /dev/null http://localhost:3000/api/health || break; sleep 1; done
  sleep 2
}
trap stop EXIT

start() { # $1 = start (production) | dev
  stop
  node scripts/local-postgres.mjs > "$LOGS/db.log" 2>&1 & DB_PID=$!
  for _ in $(seq 1 120); do grep -q "ready" "$LOGS/db.log" && break; sleep 1; done
  node node_modules/next/dist/bin/next "$1" -p 3000 > "$LOGS/app.log" 2>&1 & APP_PID=$!
  for _ in $(seq 1 120); do curl -sf -o /dev/null http://localhost:3000/api/health && break; sleep 1; done
  # Development mode compiles each page on first visit; do that before the tests start timing.
  if [ "$1" = dev ]; then
    for path in /login /overview /leads /my-work /payments /customers /reports /review /follow-ups /settings /settings/users; do
      curl -s -o /dev/null -m 120 "http://localhost:3000$path" || true
    done
  fi
}

failed=()
for s in $SUITES; do
  case $s in
    a11y) start start; cmd="python3 tests/a11y/axe_scan.py" ;;
    console) rm -rf .next/dev; start dev; cmd="python3 tests/e2e/console_scan.py" ;;
    *) start start; cmd="python3 tests/e2e/${s}_e2e.py ${CRM_SHOTS:-}" ;;
  esac
  echo "── $s"
  if $cmd > "$LOGS/$s.log" 2>&1; then tail -1 "$LOGS/$s.log"; else failed+=("$s"); tail -15 "$LOGS/$s.log"; fi
done
stop
if [ ${#failed[@]} -gt 0 ]; then echo "FAILED: ${failed[*]} (logs in $LOGS)"; exit 1; fi
echo "All browser suites passed."
