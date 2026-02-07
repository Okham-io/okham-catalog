param(
  [Parameter(Mandatory=$true)][string]$AccountId,
  [Parameter(Mandatory=$true)][string]$KvNamespaceId,
  [Parameter(Mandatory=$true)][string]$BucketName
)

$ErrorActionPreference = 'Stop'

function Put-KVJsonFile {
  param(
    [Parameter(Mandatory=$true)][string]$Key,
    [Parameter(Mandatory=$true)][string]$Path
  )
  Write-Host "KV PUT $Key <= $Path"
  npx wrangler kv key put $Key --remote --namespace-id $KvNamespaceId --path $Path | Out-Host
}

function Put-R2File {
  param(
    [Parameter(Mandatory=$true)][string]$Key,
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][string]$ContentType
  )
  $objPath = "$BucketName/$Key"
  Write-Host "R2 PUT $objPath <= $Path"
  npx wrangler r2 object put $objPath --remote --file $Path --content-type $ContentType | Out-Host
}

# 1) Registries -> KV
Put-KVJsonFile -Key "catalog/rulesets/registry.json" -Path "packages/rulesets/registry.json"
Put-KVJsonFile -Key "catalog/assertions/registry.json" -Path "packages/assertions/registry.json"
Put-KVJsonFile -Key "catalog/types/registry.json" -Path "packages/types/registry.json"
Put-KVJsonFile -Key "catalog/conformance/registry.json" -Path "packages/conformance/registry.json"

# 2) Latest pointers -> KV (derived)
$rulesetsRegistry = Get-Content -Raw -Path "packages/rulesets/registry.json" | ConvertFrom-Json
foreach ($r in $rulesetsRegistry.rulesets) {
  $latest = $r.versions[-1]
  $key = "catalog/rulesets/$($r.rulesetId)/latest.json"
  $tmp = New-TemporaryFile
  @{ version = $latest } | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -NoNewline -Path $tmp
  Put-KVJsonFile -Key $key -Path $tmp
  Remove-Item $tmp
}

$assertionsRegistry = Get-Content -Raw -Path "packages/assertions/registry.json" | ConvertFrom-Json
foreach ($a in $assertionsRegistry.assertions) {
  $latest = $a.versions[-1]
  $key = "catalog/assertions/$($a.assertionId)/latest.json"
  $tmp = New-TemporaryFile
  @{ version = $latest } | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -NoNewline -Path $tmp
  Put-KVJsonFile -Key $key -Path $tmp
  Remove-Item $tmp
}

$typesRegistry = Get-Content -Raw -Path "packages/types/registry.json" | ConvertFrom-Json
foreach ($t in $typesRegistry.types) {
  $latest = $t.versions[-1]
  $key = "catalog/types/$($t.typeId)/latest.json"
  $tmp = New-TemporaryFile
  @{ version = $latest } | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -NoNewline -Path $tmp
  Put-KVJsonFile -Key $key -Path $tmp
  Remove-Item $tmp
}

$conformanceRegistry = Get-Content -Raw -Path "packages/conformance/registry.json" | ConvertFrom-Json
foreach ($s in $conformanceRegistry.suites) {
  $latest = $s.versions[-1]
  $key = "catalog/conformance/$($s.suiteId)/latest.json"
  $tmp = New-TemporaryFile
  @{ version = $latest } | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -NoNewline -Path $tmp
  Put-KVJsonFile -Key $key -Path $tmp
  Remove-Item $tmp
}

# 3) Artifacts -> R2 (use registry paths)
foreach ($r in $rulesetsRegistry.rulesets) {
  foreach ($v in $r.versions) {
    $src = "packages/rulesets/$($r.rulesetId)/$v/ruleset.olr.yaml"
    if (!(Test-Path $src)) { throw "Missing file: $src" }
    $dst = "catalog/rulesets/$($r.rulesetId)/$v/ruleset.olr.yaml"
    Put-R2File -Key $dst -Path $src -ContentType "text/yaml; charset=utf-8"
  }
}

foreach ($a in $assertionsRegistry.assertions) {
  foreach ($v in $a.versions) {
    $src = "packages/assertions/$($a.assertionId)/$v/assertion.oas.yaml"
    if (!(Test-Path $src)) { throw "Missing file: $src" }
    $dst = "catalog/assertions/$($a.assertionId)/$v/assertion.oas.yaml"
    Put-R2File -Key $dst -Path $src -ContentType "text/yaml; charset=utf-8"
  }
}

foreach ($t in $typesRegistry.types) {
  foreach ($v in $t.versions) {
    $src = "packages/types/$($t.typeId)/$v/type.otc.yaml"
    if (!(Test-Path $src)) { throw "Missing file: $src" }
    $dst = "catalog/types/$($t.typeId)/$v/type.otc.yaml"
    Put-R2File -Key $dst -Path $src -ContentType "text/yaml; charset=utf-8"
  }
}

foreach ($s in $conformanceRegistry.suites) {
  foreach ($v in $s.versions) {
    $src = "packages/conformance/$($s.suiteId)/$v/suite.ocs.yaml"
    if (!(Test-Path $src)) { throw "Missing file: $src" }
    $dst = "catalog/conformance/$($s.suiteId)/$v/suite.ocs.yaml"
    Put-R2File -Key $dst -Path $src -ContentType "text/yaml; charset=utf-8"

    # also publish fixtures if present under this suite/version
    $fixturesRoot = "packages/conformance/$($s.suiteId)/$v/conformance-fixtures"
    if (Test-Path $fixturesRoot) {
      Get-ChildItem -Recurse -File $fixturesRoot | ForEach-Object {
        $src2 = $_.FullName
        $rel = $src2.Substring((Resolve-Path $fixturesRoot).Path.Length).TrimStart('\\','/')
        $dst2 = "catalog/conformance/$($s.suiteId)/$v/conformance-fixtures/$rel" -replace '\\','/'
        Put-R2File -Key $dst2 -Path $src2 -ContentType "text/yaml; charset=utf-8"
      }
    }
  }
}

Write-Host "Done. Try:" 
Write-Host "  https://catalog.okham.io/rulesets/registry.json"
Write-Host "  https://catalog.okham.io/types/registry.json"
Write-Host "  https://catalog.okham.io/conformance/registry.json"
Write-Host "  https://catalog.okham.io/conformance/okham.conformance.okham.otc.base/latest/suite.ocs.yaml"
Write-Host "  https://catalog.okham.io/rulesets/okham.core.mvp/latest/ruleset.olr.yaml"
