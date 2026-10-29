#!/bin/sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
APP="$HERE/../Tupies"
OUT="$HERE/../build/migration-service-tests"
mkdir -p "$OUT"
swiftc -module-cache-path "$OUT/ModuleCache" -o "$OUT/tests" \
  "$APP/Services/AppIdentity.swift" "$APP/Services/Keychain.swift" "$APP/Services/DeviceKeyStore.swift" \
  "$APP/Services/EngineClient.swift" "$APP/Models/EngineAPI.swift" "$APP/Models/Connection.swift" \
  "$APP/Services/PairingLink.swift" "$APP/Services/SigningMessages.swift" "$APP/Services/ServerTrust.swift" \
  "$APP/Services/PairingMigrationEnvelope.swift" "$APP/Services/PairingMigrationService.swift" \
  "$HERE/MigrationServiceTests.swift"
"$OUT/tests"
