# Run pi-hub from the pi-mono repo (PowerShell).
# Usage: .\scripts\pi-hub.ps1
#        .\scripts\pi-hub.ps1 -- --token mysecret --cwd E:\my\project

param(
	[Parameter(ValueFromRemainingArguments = $true)]
	[string[]]$Args
)

$Root = Split-Path $PSScriptRoot -Parent
Push-Location $Root
try {
	if ($Args.Count -gt 0 -and $Args[0] -eq "--") {
		$Args = $Args[1..($Args.Length - 1)]
	}
	& npm run hub -- @Args
	exit $LASTEXITCODE
}
finally {
	Pop-Location
}
