$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = $PSScriptRoot
$asset = Join-Path $root 'assets\codemirror.js'

Write-Host ''
Write-Host 'DSH IDE setup' -ForegroundColor Cyan
Write-Host ''

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js is required. Install Node.js 20+ and run this script again.'
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  throw 'npm is required. Reinstall Node.js with npm included.'
}

Write-Host ('Node: ' + (node --version))
Write-Host ('npm:  ' + (npm.cmd --version))
Write-Host ''

if (-not (Test-Path -LiteralPath $asset)) {
  throw "Missing CodeMirror asset: $asset"
}

Push-Location $root
try {
  Write-Host 'Installing dependencies (Pyright + typescript-language-server)...' -ForegroundColor Yellow
  npm.cmd install --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host 'Dependencies installed.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Open DSH desktop.'
Write-Host '  2. Open Plugins -> install from local folder.'
Write-Host ("     Select: " + $root)
Write-Host '  3. Reload DSH Web (Ctrl+Shift+R).'
Write-Host ''
Write-Host 'Install only this one folder. The LSP server is bundled in this package.'
Write-Host ''
