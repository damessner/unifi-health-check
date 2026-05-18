function escapeTeacherHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTeacherDate(timestamp) {
  return new Date(timestamp).toLocaleString();
}

function formatTeacherTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString();
}

function formatTeacherStatus(status) {
  if (status === 'red') return 'Attention Needed';
  if (status === 'yellow') return 'Watch Closely';
  return 'Ready for Lessons';
}

function renderTeacherRooms(locations = []) {
  const container = document.getElementById('teacher-room-status');
  if (!container) return;

  if (!locations.length) {
    container.innerHTML = '<div class="teacher-empty-state">No room-level issues are being reported right now.</div>';
    return;
  }

  container.innerHTML = locations.map((location) => `
    <div class="teacher-room-item ${location.readiness}">
      <div>
        <strong>${escapeTeacherHtml(location.name)}</strong>
        <p>${location.clientIssues} client issues · ${location.criticalSignals} critical radios · ${location.warningSignals} warning radios</p>
      </div>
      <span class="teacher-readiness-pill ${location.readiness}">${formatTeacherStatus(location.readiness)}</span>
    </div>
  `).join('');
}

function renderTeacherStickyClients(clients = []) {
  const container = document.getElementById('teacher-sticky-clients');
  if (!container) return;

  if (!clients.length) {
    container.innerHTML = '<div class="teacher-empty-state">No sticky or roaming-prone devices are being flagged right now.</div>';
    return;
  }

  container.innerHTML = clients.map((client) => `
    <div class="teacher-list-item">
      <div class="teacher-list-item-top">
        <strong>${escapeTeacherHtml(client.hostname)}</strong>
        <span class="teacher-readiness-pill ${client.severity === 'critical' ? 'red' : 'yellow'}">${client.roamCount} roams</span>
      </div>
      <p>${escapeTeacherHtml(client.apName)} · ${escapeTeacherHtml(client.band)} · ${escapeTeacherHtml(client.signal)} dBm</p>
      <small>${escapeTeacherHtml(client.recommendation)}</small>
    </div>
  `).join('');
}

function renderTeacherReports(reports = []) {
  const container = document.getElementById('teacher-recent-reports');
  const countEl = document.getElementById('teacher-report-count');
  if (countEl) countEl.textContent = String(reports.length);
  if (!container) return;

  if (!reports.length) {
    container.innerHTML = '<div class="teacher-empty-state">No teacher reports have been submitted yet.</div>';
    return;
  }

  container.innerHTML = reports.map((report) => `
    <div class="teacher-list-item">
      <div class="teacher-list-item-top">
        <strong>${escapeTeacherHtml(report.location)}</strong>
        <span class="teacher-readiness-pill yellow">${escapeTeacherHtml(report.issueType)}</span>
      </div>
      <p>${escapeTeacherHtml(report.reporterName)} · ${formatTeacherDate(report.timestamp)}</p>
      <small>${escapeTeacherHtml(report.message)}</small>
    </div>
  `).join('');
}

async function loadTeacherPortal() {
  const headline = document.getElementById('teacher-headline');
  if (headline) {
    headline.textContent = 'Refreshing the current classroom Wi-Fi view...';
  }

  try {
    const response = await fetch('/api/teacher/status');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!payload.success) {
      throw new Error(payload.error || 'Unknown teacher portal error');
    }

    const overallStatusEl = document.getElementById('teacher-overall-status');
    const readinessScoreEl = document.getElementById('teacher-readiness-score');
    const lastUpdatedEl = document.getElementById('teacher-last-updated');

    if (headline) headline.textContent = payload.status.headline;
    if (overallStatusEl) overallStatusEl.textContent = formatTeacherStatus(payload.status.overallStatus);
    if (readinessScoreEl) readinessScoreEl.textContent = `${payload.status.readinessScore}%`;
    if (lastUpdatedEl) lastUpdatedEl.textContent = `Last updated: ${formatTeacherTime(payload.timestamp)}`;

    renderTeacherRooms(payload.status.locations);
    renderTeacherStickyClients(payload.status.stickyClients);
    renderTeacherReports(payload.recentReports);
  } catch (err) {
    if (headline) {
      headline.textContent = `Unable to load classroom Wi-Fi status right now (${err.message}).`;
    }
  }

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

async function submitTeacherReport(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const feedback = document.getElementById('teacher-report-feedback');
  const submitButton = form.querySelector('button[type="submit"]');

  const formData = new FormData(form);
  const payload = {
    reporterName: formData.get('reporterName'),
    location: formData.get('location'),
    issueType: formData.get('issueType'),
    message: formData.get('message')
  };

  if (feedback) feedback.textContent = 'Sending report...';
  if (submitButton) submitButton.disabled = true;

  try {
    const response = await fetch('/api/teacher/report', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    if (!response.ok || !result.success) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }

    form.reset();
    if (feedback) feedback.textContent = 'Report sent successfully. The admin dashboard will pick it up immediately.';
    await loadTeacherPortal();
  } catch (err) {
    if (feedback) feedback.textContent = `Could not send the report: ${err.message}`;
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('teacher-report-form');
  if (form) {
    form.addEventListener('submit', submitTeacherReport);
  }

  loadTeacherPortal();
});
