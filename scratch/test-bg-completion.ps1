$server = Start-Process -FilePath "node" -ArgumentList "server.js" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 4

try {
  Write-Host "=== Test: POST /api/optimize/run (short budget) ==="
  $body = @{searchMode='ga';maxChanges=8;timeBudgetMs=3000;populationSize=20;minImprovement=3}
  $jsonBody = $body | ConvertTo-Json
  $resp = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/optimize/run" -Method Post -Body $jsonBody -ContentType "application/json" -TimeoutSec 10
  $jobId = $resp.jobId
  Write-Host "Job created: $jobId"

  # Wait for completion (budget is 3000ms + overhead)
  $waited = 0
  $status = "running"
  while ($status -eq "running" -and $waited -lt 15) {
    Start-Sleep -Seconds 1
    $waited++
    $j = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/optimize/jobs/$jobId" -UseBasicParsing -TimeoutSec 5
    $status = $j.job.status
    Write-Host "  [${waited}s] status=$status"
  }

  if ($status -eq "completed") {
    Write-Host "SUCCESS: Background job completed!"
    Write-Host "Has result: $($j.job.hasResult)"
    Write-Host "Result path: $($j.job.resultPath)"
  } elseif ($status -eq "failed") {
    Write-Host "FAILED: $($j.job.error)"
  } else {
    Write-Host "Still $status after $waited seconds"
  }

  Write-Host "`n=== Test: Jobs list ==="
  $jobs = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/optimize/jobs" -UseBasicParsing -TimeoutSec 5
  $completed = @($jobs.jobs | Where-Object { $_.status -eq 'completed' })
  Write-Host "Completed jobs: $($completed.Count) / $($jobs.jobs.Count)"

  Write-Host "`nAll done."
} finally {
  Stop-Process -Id $server.Id -Force
}
