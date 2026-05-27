taskkill /F /IM node.exe 2>$null
Start-Sleep -Seconds 2
Remove-Item "data\optimizer-runs\*.json" -Force -ErrorAction SilentlyContinue

$server = Start-Process -FilePath "node" -ArgumentList "server.js" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 5

try {
  $body = @{searchMode='ga';maxChanges=8;timeBudgetMs=3000;populationSize=20;minImprovement=3} | ConvertTo-Json
  $r = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/optimize/run" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 10
  $jobId = $r.jobId
  Write-Host "Job: $jobId"
  
  Start-Sleep -Seconds 6
  
  $j = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/optimize/jobs/$jobId" -UseBasicParsing -TimeoutSec 5
  Write-Host "Status: $($j.job.status)"
  Write-Host "xlsxPath: $($j.job.xlsxPath)"
  
  if ($j.job.xlsxPath) {
    Write-Host "File on disk: $(Test-Path $j.job.xlsxPath)"
  }
  
  # Try download
  try {
    $dl = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/optimize/jobs/$jobId/download/xlsx" -UseBasicParsing -TimeoutSec 10
    Write-Host "XLSX download: $($dl.Content.Length) bytes OK"
  } catch {
    $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    Write-Host "XLSX download FAILED: $($sr.ReadToEnd())"
  }
  
  # Also test JSON download
  try {
    $dl2 = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/optimize/jobs/$jobId/download/json" -UseBasicParsing -TimeoutSec 10
    Write-Host "JSON download: $($dl2.Content.Length) bytes OK"
  } catch {
    $sr2 = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    Write-Host "JSON download FAILED: $($sr2.ReadToEnd())"
  }
} finally {
  Stop-Process -Id $server.Id -Force
}
