$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$public = Join-Path (Split-Path $PSScriptRoot -Parent) 'public'
$ink = [System.Drawing.ColorTranslator]::FromHtml('#193b32')
$paper = [System.Drawing.ColorTranslator]::FromHtml('#f3f0e6')
$accent = [System.Drawing.ColorTranslator]::FromHtml('#e4e88e')
$muted = [System.Drawing.ColorTranslator]::FromHtml('#526258')
$rule = [System.Drawing.ColorTranslator]::FromHtml('#c4cabc')
$resources = [System.Collections.Generic.List[System.IDisposable]]::new()

function Brush($color) {
    $item = [System.Drawing.SolidBrush]::new($color)
    $resources.Add($item)
    return $item
}

function Font($family, $size, $style = [System.Drawing.FontStyle]::Regular) {
    $item = [System.Drawing.Font]::new($family, $size, $style, [System.Drawing.GraphicsUnit]::Pixel)
    $resources.Add($item)
    return $item
}

function Canvas($width, $height) {
    $bitmap = [System.Drawing.Bitmap]::new($width, $height)
    $resources.Add($bitmap)
    return $bitmap
}

function Graphics($bitmap) {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $resources.Add($graphics)
    return $graphics
}

function IconImage($size) {
    $bitmap = Canvas $size $size
    $g = Graphics $bitmap
    $g.ScaleTransform(($size / 64.0), ($size / 64.0))
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $resources.Add($path)
    $path.AddArc(0, 0, 28, 28, 180, 90)
    $path.AddArc(36, 0, 28, 28, 270, 90)
    $path.AddArc(36, 36, 28, 28, 0, 90)
    $path.AddArc(0, 36, 28, 28, 90, 90)
    $path.CloseFigure()
    $g.FillPath((Brush $ink), $path)
    $question = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $resources.Add($question)
    $question.AddBezier(22, 22, 22, 15, 27, 11, 34, 11)
    $question.AddBezier(34, 11, 42, 11, 47, 15, 47, 22)
    $question.AddBezier(47, 22, 47, 28, 43, 31, 38, 34)
    $question.AddBezier(38, 34, 35, 36, 34, 38, 34, 42)
    $question.AddLine(34, 42, 26, 42)
    $question.AddBezier(26, 42, 26, 35, 28, 32, 33, 29)
    $question.AddBezier(33, 29, 37, 26, 39, 25, 39, 22)
    $question.AddBezier(39, 22, 39, 19, 37, 17, 34, 17)
    $question.AddBezier(34, 17, 30, 17, 29, 19, 29, 22)
    $question.CloseFigure()
    $g.FillPath((Brush $accent), $question)
    $g.FillEllipse((Brush $accent), 25, 46, 10, 10)
    return $bitmap
}

try {
    $preview = Canvas 1200 630
    $g = Graphics $preview
    $g.Clear($paper)
    $green = Brush $ink
    $yellow = Brush $accent
    $grey = Brush $muted
    $line = [System.Drawing.Pen]::new($rule, 1)
    $resources.Add($line)
    $strongLine = [System.Drawing.Pen]::new($ink, 2)
    $resources.Add($strongLine)
    $brand = Font 'Georgia' 53 ([System.Drawing.FontStyle]::Bold)
    $heading = Font 'Georgia' 86
    $body = Font 'Segoe UI' 25
    $small = Font 'Segoe UI' 19
    $bold = Font 'Segoe UI' 20 ([System.Drawing.FontStyle]::Bold)

    $g.DrawString('quedem', $brand, $green, 62, 42)
    $g.DrawString('?', $brand, (Brush ([System.Drawing.ColorTranslator]::FromHtml('#68722c'))), 272, 42)
    $g.DrawLine($strongLine, 68, 124, 1132, 124)
    $g.DrawString('Posem-hi', $heading, $green, 60, 184)
    $g.DrawString('data.', $heading, $green, 60, 274)
    $g.FillRectangle($yellow, 70, 374, 208, 7)
    $g.DrawString('Un dia que ens vagi', $body, $green, 66, 420)
    $g.DrawString("b$([char]0xe9) a tothom.", $body, $green, 66, 456)

    $g.FillRectangle((Brush ([System.Drawing.ColorTranslator]::FromHtml('#fffdf7'))), 610, 173, 522, 337)
    $g.FillRectangle($green, 610, 173, 522, 4)
    $g.DrawString("LES AGENDES, EN COM$([char]0xda)", $bold, $green, 634, 195)
    $days = @('DL', 'DT', 'DC', 'DJ', 'DV')
    for ($i = 0; $i -lt 5; $i++) {
        $g.DrawString($days[$i], $small, $grey, (720 + $i * 82), 246)
    }
    for ($i = 0; $i -lt 4; $i++) {
        $y = 290 + $i * 49
        $g.DrawLine($line, 634, $y, 1108, $y)
        $hourBrush = $grey
        if ($i -eq 1) { $hourBrush = $green }
        $g.DrawString(('{0}:00' -f (17 + $i)), $small, $hourBrush, 634, ($y + 11))
    }
    $g.FillRectangle($yellow, 708, 340, 400, 48)
    $g.DrawString('Un forat per a tothom.', $bold, $green, 727, 350)
    $g.DrawLine($strongLine, 68, 551, 1132, 551)
    $g.DrawString('Comparteix el pla. Trobeu el dia.', $small, $green, 66, 571)
    $g.DrawString('quedem-one.vercel.app', $small, $grey, 928, 571)
    $preview.Save((Join-Path $public 'social-preview.png'), [System.Drawing.Imaging.ImageFormat]::Png)

    $apple = IconImage 180
    $apple.Save((Join-Path $public 'apple-touch-icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $images = @()
    foreach ($size in @(32, 48)) {
        $image = IconImage $size
        $stream = [System.IO.MemoryStream]::new()
        $resources.Add($stream)
        $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $images += @{ Size = $size; Bytes = $stream.ToArray() }
    }
    $file = [System.IO.File]::Create((Join-Path $public 'favicon.ico'))
    $resources.Add($file)
    $writer = [System.IO.BinaryWriter]::new($file)
    $resources.Add($writer)
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$images.Count)
    $offset = 6 + 16 * $images.Count
    foreach ($image in $images) {
        $writer.Write([byte]$image.Size); $writer.Write([byte]$image.Size)
        $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$image.Bytes.Length); $writer.Write([uint32]$offset)
        $offset += $image.Bytes.Length
    }
    foreach ($image in $images) { $writer.Write([byte[]]$image.Bytes) }
    $writer.Flush()
} finally {
    for ($i = $resources.Count - 1; $i -ge 0; $i--) { $resources[$i].Dispose() }
}
