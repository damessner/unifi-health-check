$server = Start-Process -FilePath "node" -ArgumentList "server.js" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 4

try {
  Write-Host "=== Test 1: Rust SSE ==="
  $url = "http://127.0.0.1:3000/api/optimize/progress?searchMode=rust&maxChanges=8&timeBudgetMs=5000&populationSize=40"
  $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 30
  $content = $resp.Content
  Write-Host "Has error: $($content.Contains('event: error'))"
  Write-Host "Has complete: $($content.Contains('event: complete'))"
  Write-Host "Complete has success: $($content.Contains('"success":true'))"
  if ($content -match 'event: error\ndata: ({[^}]+})') {
    Write-Host "Error details: $($Matches[1])"
  }

  Write-Host "`n=== Test 2: JS GA SSE ==="
  $url2 = "http://127.0.0.1:3000/api/optimize/progress?searchMode=ga&maxChanges=8&timeBudgetMs=3000&populationSize=20"
  $resp2 = Invoke-WebRequest -Uri $url2 -UseBasicParsing -TimeoutSec 30
  $c2 = $resp2.Content
  Write-Host "Has error: $($c2.Contains('event: error'))"
  Write-Host "Has complete: $($c2.Contains('event: complete'))"
  Write-Host "Complete has success: $($c2.Contains('"success":true'))"

  Write-Host "`n=== Test 3: POST /api/optimize/run ==="
  $body = @{searchMode='ga';maxChanges=8;timeBudgetMs=3000;populationSize=20;minImprovement=3}
  $jsonBody = $body | ConvertTo-Json
  $headers = @{'Content-Type'='application/json'}
  $resp3 = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/optimize/run" -Method Post -Body $jsonBody -ContentType "application/json" -TimeoutSec 10
  Write-Host "POST success: $($resp3.success)"
  Write-Host "POST jobId: $($resp3.jobId)"
  
  if ($resp3.jobId) {
    Start-Sleep -Seconds 1
    Write-Host "Checking job status..."
    $jobUrl = "http://127.0.0.1:3000/api/optimize/jobs/$($resp3.jobId)"
    $jobResp = Invoke-RestMethod -Uri $jobUrl -UseBasicParsing -TimeoutSec 10
    Write-Host "Job status: $($jobResp.job.status)"
    
    if ($jobResp.job.status -eq 'completed') {
      Write-Host "Background execution completed successfully!"
    } elseif ($jobResp.job.status -eq 'failed') {
      Write-Host "Background execution FAILED: $($jobResp.job.error)"
    } else {
      Write-Host "Job status: $($jobResp.job.status) (may need more time)"
    }
  }

  Write-Host "`n=== Test 4: Jobs list ==="
  $jobsResp = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/optimize/jobs" -UseBasicParsing -TimeoutSec 10
  $running = @($jobsResp.jobs | Where-Object { $_.status -eq 'running' -or $_.status -eq 'queued' })
  Write-Host "Jobs: $($jobsResp.jobs.Count) total, $($running.Count) running/queued"

  Write-Host "`nAll checks done."
} finally {
  Stop-Process -Id $server.Id -Force
}
