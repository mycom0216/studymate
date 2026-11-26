# PowerPoint가 설치된 Windows에서 .pptx 를 슬라이드별 PNG로 내보내 레이아웃을 확인합니다.
# 사용법: powershell -File tools\pptx2png.ps1 docs\StudyMate_최종발표.pptx <출력폴더>
param([string]$File, [string]$OutDir)
$src = (Resolve-Path $File).Path
New-Item -ItemType Directory -Force $OutDir | Out-Null
$out = (Resolve-Path $OutDir).Path
$ppt = New-Object -ComObject PowerPoint.Application
try {
  $pres = $ppt.Presentations.Open($src, $true, $false, $false)
  $pres.Export($out, 'PNG', 1280, 720)
  $pres.Close()
  Write-Host "exported to $out"
} finally { $ppt.Quit() }
