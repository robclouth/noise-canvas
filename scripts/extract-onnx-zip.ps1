# Extract the ONNX Runtime Windows archive, dropping the leading package folder
# and the debug symbols, into -Destination.

param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [Parameter(Mandatory = $true)][string]$Destination
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
try {
  foreach ($entry in $zip.Entries) {
    if ($entry.Name -eq "") { continue }
    if ($entry.FullName -like "*.pdb") { continue }
    $relative = $entry.FullName -replace '^[^/]+/', ''
    $target = Join-Path $Destination $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
  }
}
finally {
  $zip.Dispose()
}
