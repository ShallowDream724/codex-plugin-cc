# Paths are supplied as environment data, never interpolated into this script.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$source = [Environment]::GetEnvironmentVariable('CODEX_SUBAGENTS_IMAGE_SOURCE')
$destination = [Environment]::GetEnvironmentVariable('CODEX_SUBAGENTS_IMAGE_PREVIEW')
$image = $null
$bitmap = $null
$graphics = $null
try {
  $image = [System.Drawing.Image]::FromFile($source)
  $width = $image.Width
  $height = $image.Height
  if ($width -le 0 -or $height -le 0 -or $width -gt 16384 -or $height -gt 16384 -or ([long]$width * $height) -gt 40000000) { throw 'Image dimensions exceed the preview limit.' }
  $scale = [Math]::Min(1.0, 1280.0 / [Math]::Max($width, $height))
  $outWidth = [Math]::Max(1, [int][Math]::Round($width * $scale))
  $outHeight = [Math]::Max(1, [int][Math]::Round($height * $scale))
  $bitmap = New-Object System.Drawing.Bitmap($outWidth, $outHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.DrawImage($image, 0, 0, $outWidth, $outHeight)
  $bitmap.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  if ($graphics) { $graphics.Dispose() }
  if ($bitmap) { $bitmap.Dispose() }
  if ($image) { $image.Dispose() }
}
