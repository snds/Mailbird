#!/usr/bin/env bash
# Starts a throwaway Stalwart (JMAP) server for crates/core/tests/jmap.rs:
#   JMAP over plain HTTP on 127.0.0.1:8080 (localhost only; test use)
#   User: tester@localhost.test / tester-secret-1
#
# Stalwart is AGPL-3.0. It is only ever run as a separate test service here,
# never linked into the app (see docs/oss-stack.md).
#
#   tools/test-mail-servers/start-jmap.sh          # builds Stalwart on first run (5–15 min)
#   cargo test -p pim-core --test jmap -- --ignored
#
# Env: STALWART_BIN=/path/to/stalwart to skip the build; BASE (default /tmp/mbjmap).
set -euo pipefail

BASE=${BASE:-/tmp/mbjmap}
# Pinned so CI is reproducible; bump deliberately.
STALWART_REV=${STALWART_REV:-18f4e9505027d790fd7e9fdad7f922be6719101d}
PORT=8080

mkdir -p "$BASE"
if [ -z "${STALWART_BIN:-}" ]; then
  # Only the binary is kept (CI caches $BASE/bin); the build tree is discarded.
  if [ ! -x "$BASE/bin/stalwart" ]; then
    echo "building Stalwart $STALWART_REV (sqlite only, no debug info)…"
    rm -rf "$BASE/src" && git init -q "$BASE/src"
    git -C "$BASE/src" remote add origin https://github.com/stalwartlabs/stalwart
    git -C "$BASE/src" fetch -q --depth 1 origin "$STALWART_REV"
    git -C "$BASE/src" checkout -q FETCH_HEAD
    (cd "$BASE/src" && CARGO_PROFILE_DEV_DEBUG=0 CARGO_TARGET_DIR="$BASE/target" \
      cargo build -q -p stalwart --no-default-features --features sqlite)
    mkdir -p "$BASE/bin" && cp "$BASE/target/debug/stalwart" "$BASE/bin/stalwart"
    rm -rf "$BASE/target" "$BASE/src"
  fi
  STALWART_BIN="$BASE/bin/stalwart"
fi

stop() { pkill -x stalwart 2>/dev/null || true; sleep 1; }
wait_http() {
  for _ in $(seq 1 100); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/jmap/session" && return 0
    sleep 0.3
  done
  echo "Stalwart did not come up; see $BASE/stalwart.log" >&2
  exit 1
}

stop
rm -rf "$BASE/run" && mkdir -p "$BASE/run/data" "$BASE/run/logs"

# 1. First start has no config file: Stalwart opens a bootstrap API on :8080.
STALWART_RECOVERY_ADMIN=admin:bootstrap-only \
  nohup "$STALWART_BIN" --config "$BASE/run/config.json" > "$BASE/stalwart.log" 2>&1 &
wait_http

python3 - "$BASE" <<'PY'
import base64, json, sys, urllib.request
base = sys.argv[1]
def call(user, pw, calls):
    auth = "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()
    body = {"using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"], "methodCalls": calls}
    req = urllib.request.Request("http://127.0.0.1:8080/jmap/", data=json.dumps(body).encode(),
                                 headers={"Authorization": auth, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))["methodResponses"]
session = json.load(urllib.request.urlopen(urllib.request.Request(
    "http://127.0.0.1:8080/jmap/session",
    headers={"Authorization": "Basic " + base64.b64encode(b"admin:bootstrap-only").decode()})))
acct = next(iter(session["accounts"]))
r = call("admin", "bootstrap-only", [["x:Bootstrap/set", {"accountId": acct, "update": {"singleton": {
    "serverHostname": "localhost", "defaultDomain": "localhost.test",
    "requestTlsCertificate": False, "generateDkimKeys": False,
    "dataStore": {"@type": "Sqlite", "path": f"{base}/run/data/sqlite.db"},
    "tracer": {"@type": "Log", "path": f"{base}/run/logs/", "prefix": "stalwart", "rotate": "daily",
               "ansi": False, "multiline": False, "enable": True, "level": "warn", "lossy": False,
               "events": {}, "eventsPolicy": "exclude"},
}}}, "0"]])
done = r[0][1]["updated"]["singleton"]
open(f"{base}/run/admin", "w").write(f"{done['username']}:{done['secret']}")
PY

# 2. Restart in normal mode; the public URL keeps API links on this port.
stop
STALWART_PUBLIC_URL="http://127.0.0.1:$PORT" \
  nohup "$STALWART_BIN" --config "$BASE/run/config.json" >> "$BASE/stalwart.log" 2>&1 &
wait_http

# 3. Create the test user.
python3 - "$BASE" <<'PY'
import base64, json, sys, urllib.request
base = sys.argv[1]
user, pw = open(f"{base}/run/admin").read().split(":", 1)
auth = "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()
def call(calls):
    body = {"using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"], "methodCalls": calls}
    req = urllib.request.Request("http://127.0.0.1:8080/jmap/", data=json.dumps(body).encode(),
                                 headers={"Authorization": auth, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))["methodResponses"]
session = json.load(urllib.request.urlopen(urllib.request.Request(
    "http://127.0.0.1:8080/jmap/session", headers={"Authorization": auth})))
acct = next(iter(session["accounts"]))
domain = call([["x:Domain/query", {"accountId": acct}, "q"]])[0][1]["ids"][0]
# Stalwart encodes object lists as maps keyed by index.
r = call([["x:Account/set", {"accountId": acct, "create": {"u": {
    "@type": "User", "name": "tester", "domainId": domain,
    "credentials": {"0": {"@type": "Password", "secret": "tester-secret-1"}}}}}, "0"]])
assert "created" in r[0][1], r
PY
echo "JMAP test server up: tester@localhost.test on http://127.0.0.1:$PORT"
