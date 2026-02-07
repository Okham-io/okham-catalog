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
  npx wrangler kv:key put $Key --namespace-id $KvNamespaceId --path $Path | Out-Host
}

function Put-R2File {
  param(
    [Parameter(Mandatory=$true)][string]$Key,
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][string]$ContentType
  )
  $objPath = "$BucketName/$Key"
  Write-Host "R2 PUT $objPath <= $Path"
  npx wrangler r2 object put $objPath --file $Path --content-type $ContentType | Out-Host
}

# 1) Registries -> KV
Put-KVJsonFile -Key "catalog/rulesets/registry.json" -Path "packages/rulesets/registry.json"
Put-KVJsonFile -Key "catalog/assertions/registry.json" -Path "packages/assertions/registry.json"

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

Write-Host "Done. Try:" 
Write-Host "  https://okham.io/catalog/rulesets/registry.json"
Write-Host "  https://okham.io/catalog/rulesets/okham.core.mvp/latest/ruleset.olr.yaml"
