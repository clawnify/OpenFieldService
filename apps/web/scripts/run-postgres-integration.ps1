$ErrorActionPreference = "Stop"

$postgresBin = "C:\Program Files\PostgreSQL\17\bin"
$cluster = Join-Path $PSScriptRoot "..\.postgres-test"
$data = Join-Path $cluster "data"
$log = Join-Path $cluster "postgres.log"
$port = 55432

if (-not (Test-Path (Join-Path $postgresBin "initdb.exe"))) {
  throw "PostgreSQL 17 tools were not found. Set DATABASE_URL and run pnpm test:integration directly."
}

New-Item -ItemType Directory -Force -Path $cluster | Out-Null
if (-not (Test-Path (Join-Path $data "PG_VERSION"))) {
  & (Join-Path $postgresBin "initdb.exe") -D $data -U postgres --auth=trust --encoding=UTF8 --no-locale
  if ($LASTEXITCODE -ne 0) { throw "initdb failed" }
}

try {
  & (Join-Path $postgresBin "pg_ctl.exe") -D $data -l $log -o "-p $port -h 127.0.0.1" -w start
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL test cluster failed to start" }
  & (Join-Path $postgresBin "dropdb.exe") -h 127.0.0.1 -p $port -U postgres --if-exists open_fieldservice_test
  & (Join-Path $postgresBin "createdb.exe") -h 127.0.0.1 -p $port -U postgres open_fieldservice_test
  $env:DATABASE_URL = "postgresql://postgres@127.0.0.1:$port/open_fieldservice_test"
  $env:AUTH_SECRET = "integration-test-secret-at-least-32-characters"
  pnpm.cmd test:integration
  if ($LASTEXITCODE -ne 0) { throw "PostgreSQL integration tests failed" }
}
finally {
  & (Join-Path $postgresBin "pg_ctl.exe") -D $data -m fast -w stop
}
