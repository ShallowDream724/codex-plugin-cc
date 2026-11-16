$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$source = [Environment]::GetEnvironmentVariable('CODEX_SUBAGENTS_IMAGE_SOURCE')
$image = [System.Drawing.Image]::FromFile($source)
try {
  if ($image.Width -le 0 -or $image.Height -le 0 -or $image.Width -gt 16384 -or $image.Height -gt 16384 -or ([long]$image.Width * $image.Height) -gt 40000000) { throw 'Image dimensions exceed the preview limit.' }
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  function Encode-Preview([int]$maxSide, [int]$maxBytes) {
    $side = $maxSide
    while ($side -ge 48) {
      $scale = [Math]::Min(1.0, $side / [double][Math]::Max($image.Width, $image.Height))
      $width = [Math]::Max(1, [int][Math]::Round($image.Width * $scale))
      $height = [Math]::Max(1, [int][Math]::Round($image.Height * $scale))
      $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::White)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.DrawImage($image, 0, 0, $width, $height)
        foreach ($quality in @(80, 60, 40)) {
          $stream = New-Object System.IO.MemoryStream
          $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
          $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
          try {
            $bitmap.Save($stream, $codec, $params)
            if ($stream.Length -le $maxBytes) { return @{ data = [Convert]::ToBase64String($stream.ToArray()); width = $width; height = $height } }
          } finally { $params.Dispose(); $stream.Dispose() }
        }
      } finally { $graphics.Dispose(); $bitmap.Dispose() }
      $side = [int][Math]::Floor($side * 0.7)
    }
    throw 'Unable to produce a bounded image preview.'
  }
  $thumbnail = Encode-Preview 320 4500
  $large = Encode-Preview 1280 42000
  @{ thumbnail = $thumbnail.data; thumbnail_width = $thumbnail.width; thumbnail_height = $thumbnail.height; large = $large.data } | ConvertTo-Json -Compress
} finally { $image.Dispose() }
