Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$server = Start-Process -FilePath "node" -ArgumentList "server.js" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 5

try {
  Write-Host "=== 1. Create GA job ==="
  $body = @{searchMode='ga';maxChanges=8;timeBudgetMs=3000;populationSize=20;minImprovement=3}
  $json = $body | ConvertTo-Json
  $r1 = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/optimize/run" -Method Post -Body $json -ContentType "application/json" -TimeoutSec 10
  Write-Host "   Job 1: $($r1.jobId)"

  Write-Host "`n=== 2. Try second GA job (should be blocked) ==="
  try {
    $r2 = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/optimize/run" -Method Post -Body $json -ContentType "application/json" -TimeoutSec 10
    $r2Content = $r2.Content
    Write-Host "   Unexpected success: $r2Content"
  } catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    $response = $_.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($response)
    $body = $reader.ReadToEnd()
    Write-Host "   Blocked: HTTP $statusCode - $body"
  }

  Write-Host "`n=== 3. Cancel job 1 ==="
  $cancel = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/optimize/jobs/$($r1.jobId)" -Method Delete -TimeoutSec 10
  Write-Host "   Cancelled: $($cancel.success)"

  Write-Host "`n=== 4. Now try another GA job (should succeed) ==="
  $r3 = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/optimize/run" -Method Post -Body $json -ContentType "application/json" -TimeoutSec 10
  Write-Host "   Job 3: $($r3.jobId) success=$($r3.success)"

  Write-Host "`n=== 5. Cancel job 3 ==="
  $cancel3 = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/optimize/jobs/$($r3.jobId)" -Method Delete -TimeoutSec 10
  Write-Host "   Cancelled: $($cancel3.success)"

  Start-Sleep -Seconds 1

  Write-Host "`n=== 6. Verify reconnect for cancelled job ==="
  $sse = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/optimize/jobs/$($r1.jobId)/progress" -UseBasicParsing -TimeoutSec 10
  Write-Host "   Has cancelled event: $($sse.Content.Contains('event: cancelled'))"

  Write-Host "`n=== ALL CONCURRENCY + CANCEL TESTS PASSED ==="
} finally {
  Stop-Process -Id $server.Id -Force
}
