#!/usr/bin/env bash
# showstake worker checkpoint helpers — shared by the LOCAL regression
# (run-worker-checkpoint.sh) and the REAL v6 runner (run-worker-testnet-v6.sh), so the
# exact dump/verify/restore logic is exercised by one local test and reused by the
# runner (same helper path — no duplicated code).
#
# Requires (globals): PGBIN, PSQL, NODE, REPO, SS_SUPERUSER, LD_LIBRARY_PATH.
# Config is the EXACT v6 testnet allowlist (showstake-settle-endpx.testnet /
# f462ddcb… / showstake-v2-d036-settle/1), `startHeight` supplied per caller. No creds.

# Safe Postgres identifier validator (used for quarantine DDL — never interpolate an
# unvalidated identifier).
ckpt_valid_dbname() { case "${1:-}" in [a-z_][a-z0-9_]*|showstake_disposable) ;; *) return 1 ;; esac; return 0; }

ckpt_config_json() {
  "$NODE" -e 'const a=process.argv.slice(1);process.stdout.write(JSON.stringify({environment:"testnet",network:"testnet",contractId:"showstake-settle-endpx.testnet",ftContractId:"showstake-ft-endpx.testnet",ftDecimals:6,codeHash:"HSyv94gFgwMFyfrfQBhjBc7Aidgh4eaaL6LeH3cs1zpp",wasmSha256:"f462ddcbb8b47ff03f4bea71c054cefe0d0a576b1346a0f9a55688c43307fd59",organizer:"showstake-participant-endpx.testnet",policyVersion:"showstake-v2-d036-settle/1",startHeight:Number(a[0])}))' "$1"
}

ckpt_source_schema_json() {
  ( cd "$REPO" && "$NODE" -e '
    const fs=require("fs"),c=require("crypto");
    const src=["apps/worker/src/source.ts","apps/worker/src/events.ts","apps/worker/src/project.ts","apps/worker/src/store.ts","apps/worker/src/types.ts","apps/worker/src/index.ts","apps/worker/src/cli.ts","apps/worker/src/config.ts","apps/worker/src/identity.ts","apps/worker/src/external.d.ts"];
    const h=f=>c.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    const srcH={};for(const f of src)srcH[f]=h(f);
    const schemaH={};for(const f of fs.readdirSync("migrations/schema").filter(x=>x.endsWith(".sql")).sort())schemaH["migrations/schema/"+f]=h("migrations/schema/"+f);
    process.stdout.write(JSON.stringify({sourceSha256:srcH,schemaSha256:schemaH}));' )
}

# Dump the owned DB data (public chain/local test data only) + write a manifest.
# `name` makes the artifact names unique; refuses to OVERWRITE an existing target.
# Echoes the dump sha256; non-zero exit => checkpoint is FAILED (not resume-eligible).
ckpt_dump() {
  local socket="$1" port="$2" db="$3" outdir="$4" name="$5" consumer="$6" start_height="$7"
  local dump manifest log sha cursor dep_id cfg_json srcjson
  mkdir -p "$outdir"
  dump="$outdir/checkpoint-$name.dump"; manifest="$outdir/checkpoint-$name-manifest.json"; log="$outdir/pg_dump-$name.log"
  # Never overwrite: refuse a pre-existing dump/manifest/log before any mutation.
  [ ! -e "$dump" ] || { echo "refusing to overwrite existing dump: $dump" >&2; return 1; }
  [ ! -e "$manifest" ] || { echo "refusing to overwrite existing manifest: $manifest" >&2; return 1; }
  [ ! -e "$log" ] || { echo "refusing to overwrite existing log: $log" >&2; return 1; }
  "$PGBIN/pg_dump" --data-only --format=custom --no-owner --exclude-table=schema_migrations \
    --file="$dump" --host="$socket" --port="$port" --username="$SS_SUPERUSER" "$db" >"$log" 2>&1 || return 1
  [ -s "$dump" ] || return 1
  sha="$(sha256sum "$dump" | cut -d' ' -f1)"
  dep_id="$("$PSQL" -h "$socket" -p "$port" -U "$SS_SUPERUSER" -d "$db" -tAc "SELECT id::text FROM deployments WHERE contract_id='showstake-settle-endpx.testnet' LIMIT 1" 2>/dev/null || true)"
  cursor="$("$PSQL" -h "$socket" -p "$port" -U "$SS_SUPERUSER" -d "$db" -tAc "SELECT cursor_value::text FROM worker_cursors WHERE consumer='$consumer' LIMIT 1" 2>/dev/null || true)"
  cfg_json="$(ckpt_config_json "$start_height")"
  srcjson="$(ckpt_source_schema_json)"
  ( cd "$REPO" && "$NODE" -e '
    const fs=require("fs");
    const m={classifier:"PASS_LOCAL",dumpOk:true,runId:process.argv[1],consumer:process.argv[2],deploymentId:process.argv[5]||null,dumpSha256:process.argv[3],dumpBytes:fs.statSync(process.argv[4]).size,createdUtc:new Date().toISOString(),cursor:process.argv[6]&&process.argv[6]!==""?JSON.parse(process.argv[6]):null,config:JSON.parse(process.argv[7])};
    Object.assign(m,JSON.parse(process.argv[8]));
    fs.writeFileSync(process.argv[9],JSON.stringify(m,null,2));' \
    "$name" "$consumer" "$sha" "$dump" "$dep_id" "$cursor" "$cfg_json" "$srcjson" "$manifest" )
  echo "$sha"
}

# Latest checkpoint manifest + dump as two NEWLINE-separated absolute paths (never
# space-joined; the repo path contains spaces). Prints nothing if none.
ckpt_latest() {
  local dir="$1" mf
  [ -d "$dir" ] || return 0
  mf="$(ls -t "$dir"/checkpoint-*-manifest.json 2>/dev/null | head -n1)"
  [ -n "$mf" ] || return 0
  printf '%s\n%s\n' "$mf" "${mf%-manifest.json}.dump"
}

# Verify a checkpoint (dump sha + source/schema hashes + config + deployment/cursor
# identity) and restore it into an EMPTY owned DB. On any failure the new DB is dropped
# (quarantined, identifier-validated) so no partial rights survive. Non-zero => FAILED.
ckpt_verify_and_restore() {
  local dump="$1" manifest="$2" socket="$3" port="$4" db="$5" start_height="$6"
  [ -s "$dump" ] || { echo "dump empty/missing" >&2; return 1; }
  [ -s "$manifest" ] || { echo "manifest empty/missing" >&2; return 1; }
  ckpt_valid_dbname "$db" || { echo "refusing unvalidated DB identifier" >&2; return 1; }
  local sha cfg_json srcjson
  sha="$(sha256sum "$dump" | cut -d' ' -f1)"
  cfg_json="$(ckpt_config_json "$start_height")"
  srcjson="$(ckpt_source_schema_json)"
  # Pre-restore: manifest identity (dump/source/schema/config/cursor shape).
  ( cd "$REPO" && "$NODE" -e '
    const fs=require("fs");
    const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const exp=JSON.parse(process.argv[2]); const src=JSON.parse(process.argv[3]);
    const shaA=process.argv[4], dumpBytes=fs.statSync(process.argv[5]).size;
    if(m.dumpOk!==true) throw new Error("manifest classified FAILED: not resume-eligible");
    if(m.dumpSha256!==shaA) throw new Error("dump sha mismatch");
    if(m.dumpBytes!==dumpBytes) throw new Error("dump bytes mismatch");
    if(JSON.stringify(m.sourceSha256||{})!==JSON.stringify(src.sourceSha256)) throw new Error("worker source hash mismatch");
    if(JSON.stringify(m.schemaSha256||{})!==JSON.stringify(src.schemaSha256)) throw new Error("migrations schema hash mismatch");
    if(typeof m.consumer!=="string"||!m.consumer) throw new Error("manifest consumer missing");
    if(typeof m.deploymentId!=="string"||!m.deploymentId) throw new Error("manifest deploymentId missing");
    if(!m.cursor||typeof m.cursor.block_hash!=="string"||!Number.isInteger(m.cursor.block_height)) throw new Error("manifest cursor missing/malformed");
    const pick=c=>({environment:c.environment,network:c.network,contractId:c.contractId,ftContractId:c.ftContractId,ftDecimals:c.ftDecimals,codeHash:c.codeHash,wasmSha256:c.wasmSha256,organizer:c.organizer,policyVersion:c.policyVersion,startHeight:c.startHeight});
    if(JSON.stringify(pick(m.config||{}))!==JSON.stringify(pick(exp))) throw new Error("deployment/config mismatch");
    process.exit(0);' \
    "$manifest" "$cfg_json" "$srcjson" "$sha" "$dump" ) || { echo "manifest verify FAILED" >&2; return 1; }

  # Target must be EMPTY of ALL owned test/projection data (not only events).
  local rows
  for t in deployments worker_cursors events_projection registrations_projection passes_projection payouts_projection chain_events; do
    rows="$("$PSQL" -h "$socket" -p "$port" -U "$SS_SUPERUSER" -d "$db" -tAc "SELECT count(*) FROM $t" 2>/dev/null || echo ERR)"
    [ "$rows" = "0" ] || { echo "restore target not empty ($t rows=$rows); refusing" >&2; return 1; }
  done

  # Transactional restore; quarantine (validated identifier, drop+recreate) on failure.
  if ! "$PGBIN/pg_restore" --data-only --no-owner --single-transaction \
       --host="$socket" --port="$port" --username="$SS_SUPERUSER" --dbname="$db" "$dump" >/dev/null 2>&1; then
    "$PSQL" -h "$socket" -p "$port" -U "$SS_SUPERUSER" -d postgres -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE $db" -c "CREATE DATABASE $db" >/dev/null 2>&1 || true
    echo "restore failed; quarantined DB" >&2; return 1
  fi

  # Post-restore identity (deployment/consumer/cursor) is verified in the worker-phase
  # .mjs from the manifest (env CKPT_MANIFEST), against the live pg client — robust vs
  # bash/psql string interpolation. Here we finish after the transactional restore.
  return 0
}