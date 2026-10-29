#!/bin/sh
set -eu
MIGRATION_TEST_HERE=$(cd "$(dirname "$0")" && pwd)
MIGRATION_TEST_APP="$MIGRATION_TEST_HERE/../Tupies"
MIGRATION_TEST_OUT=$(mktemp -d "${TMPDIR:-/tmp}/tupies-migration-tests.XXXXXXXX")
trap 'rm -rf "$MIGRATION_TEST_OUT"' EXIT INT TERM
swiftc -module-cache-path "$MIGRATION_TEST_OUT/ModuleCache" -o "$MIGRATION_TEST_OUT/migration-tests" \
  "$MIGRATION_TEST_APP/Services/SigningMessages.swift" "$MIGRATION_TEST_APP/Models/Connection.swift" \
  "$MIGRATION_TEST_APP/Services/PairingMigrationEnvelope.swift" "$MIGRATION_TEST_HERE/MigrationEnvelopeTests.swift"
"$MIGRATION_TEST_OUT/migration-tests"
