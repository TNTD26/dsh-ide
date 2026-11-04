$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = $PSScriptRoot
$lsp = Join-Path $root 'dsh-ide-lsp'
$plugin = Join-Path $root 'dsh-ide-plugin'
$asset = Join-Path $plugin 'assets\codemirror.js'

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

Push-Location $lsp
try {
  Write-Host 'Installing LSP dependencies (Pyright + typescript-language-server)...' -ForegroundColor Yellow
  npm.cmd install --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed in dsh-ide-lsp' }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host 'Dependencies installed.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Open DSH desktop.'
Write-Host '  2. Open Plugins -> install from local folder.'
Write-Host ("     Select: " + $lsp)
Write-Host ("     Select: " + $plugin)
Write-Host '  3. Reload DSH Web (Ctrl+Shift+R).'
Write-Host ''
Write-Host 'Keep dsh-ide-lsp and dsh-ide-plugin in the same parent folder.'
Write-Host ''
