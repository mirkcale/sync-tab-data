#Requires -Version 5.1
<#
  生成扩展图标：圆角渐变方块 + 白色双向箭头。
  用法（在项目根目录）：
    powershell -ExecutionPolicy Bypass -File .\tools\make-icons.ps1

  注意：本文件必须保存为「UTF-8 带 BOM」。Windows PowerShell 5.1 会按 ANSI
  读取无 BOM 的脚本，中文注释可能吞掉换行符，导致后续代码行被当成注释。
#>

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'icons'
if (-not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir | Out-Null
}

function New-RoundedRectPath {
    param(
        [System.Drawing.RectangleF]$Rect,
        [single]$Radius
    )

    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $d = [single]($Radius * 2)

    $path.AddArc($Rect.X, $Rect.Y, $d, $d, 180, 90)
    $path.AddArc(($Rect.Right - $d), $Rect.Y, $d, $d, 270, 90)
    $path.AddArc(($Rect.Right - $d), ($Rect.Bottom - $d), $d, $d, 0, 90)
    $path.AddArc($Rect.X, ($Rect.Bottom - $d), $d, $d, 90, 90)
    $path.CloseFigure()

    return $path
}

foreach ($size in 16, 32, 48, 128) {
    $bitmap = [System.Drawing.Bitmap]::new(
        $size,
        $size,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    $inset = [single]($size * 0.015)
    $rect = [System.Drawing.RectangleF]::new(
        $inset,
        $inset,
        [single]($size - ($inset * 2)),
        [single]($size - ($inset * 2))
    )

    $path = New-RoundedRectPath -Rect $rect -Radius ([single]($size * 0.22))
    $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 59, 130, 246),
        [System.Drawing.Color]::FromArgb(255, 29, 78, 216),
        [single]45
    )
    $graphics.FillPath($brush, $path)

    $stroke = [single][Math]::Max(1.3, $size * 0.085)
    $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, $stroke)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    $x0 = [single]($size * 0.27)
    $x1 = [single]($size * 0.73)
    $yTop = [single]($size * 0.365)
    $yBottom = [single]($size * 0.635)
    $head = [single]($size * 0.105)

    # 上箭头：从左指向右
    $graphics.DrawLine($pen, $x0, $yTop, $x1, $yTop)
    $graphics.DrawLine($pen, ($x1 - $head * 1.15), ($yTop - $head), $x1, $yTop)
    $graphics.DrawLine($pen, ($x1 - $head * 1.15), ($yTop + $head), $x1, $yTop)

    # 下箭头：从右指向左
    $graphics.DrawLine($pen, $x1, $yBottom, $x0, $yBottom)
    $graphics.DrawLine($pen, ($x0 + $head * 1.15), ($yBottom - $head), $x0, $yBottom)
    $graphics.DrawLine($pen, ($x0 + $head * 1.15), ($yBottom + $head), $x0, $yBottom)

    $target = Join-Path $outDir ('icon{0}.png' -f $size)
    $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)

    $pen.Dispose()
    $brush.Dispose()
    $path.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()

    Write-Host ('wrote {0}' -f $target)
}
