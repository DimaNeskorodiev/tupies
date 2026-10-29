#!/bin/sh
# Compiles the app's pure Swift logic with a small harness and checks it against the
# engine's own crypto module. No server, simulator or signing needed.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
APP="$HERE/../Tupies"
REPO=$(cd "$HERE/../../.." && pwd)
OUT="$HERE/../build/logic-tests"
NODE=$(command -v node || echo "$HOME/.local/bin/node")
mkdir -p "$OUT"
rm -f "$OUT"/swift.json*
swiftc -module-cache-path "$OUT/ModuleCache" -o "$OUT/logic-tests" \
  "$APP/Services/PairingLink.swift" "$APP/Services/StartupPairingLink.swift" "$APP/Services/SigningMessages.swift" "$APP/Services/ServerTrust.swift" "$APP/Services/EngineClient.swift" "$APP/Models/Connection.swift" \
  "$APP/Services/WebSessionReadiness.swift" "$APP/Models/NotificationDestination.swift" "$APP/Models/EngineAPI.swift" \
  "$APP/Services/LocalEnginePayload.swift" "$APP/Services/LocalEnginePairingIntent.swift" \
  "$APP/Services/LocalEngineStartPolicy.swift" \
  "$HERE/LogicTests/main.swift"
"$NODE" "$HERE/engine-crypto.mjs" "$REPO" sign "$OUT/engine.json"
"$OUT/logic-tests" "$OUT"
"$NODE" "$HERE/engine-crypto.mjs" "$REPO" verify "$OUT/swift.json"
"$OUT/logic-tests" "$OUT" verify-proof | grep -E "engineProof|PASSED|FAILED"
