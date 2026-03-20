export async function init(api) {
  const container = document.getElementById('stats');
  try {
    container.innerHTML = '<p class="loading">Loading stats...</p>';
    const data = await api.fetch('/stats');
    render(container, data);
  } catch (err) {
    renderError(container, err);
  }
}

function render(container, data) {
  const vanityRow = buildVanityRow(data);
  const healthRow = buildHealthRow(data);
  container.innerHTML = vanityRow + healthRow;
}

function renderError(container, err) {
  container.innerHTML = `<p class="error">Stats unavailable. <button class="retry-btn" onclick="location.reload()">Retry</button></p>`;
}

// ── Vanity numbers ────────────────────────────────────────────────────────────

function buildVanityRow(data) {
  const captureRate = typeof data.capture_rate_7d === 'number'
    ? data.capture_rate_7d.toFixed(1)
    : '—';

  const cards = [
    { value: data.total_notes,  label: 'Notes' },
    { value: data.total_links,  label: 'Links' },
    { value: data.total_clusters, label: 'Clusters' },
    { value: captureRate,       label: 'Notes / day (7d)' },
    { value: data.image_count,  label: 'With images' },
  ];

  const cardHtml = cards.map(c => `
    <div class="stat-card">
      <div class="stat-value">${c.value}</div>
      <div class="stat-label">${c.label}</div>
    </div>`).join('');

  return `<div class="stats-bar">${cardHtml}</div>`;
}

// ── Health indicators ─────────────────────────────────────────────────────────

function buildHealthRow(data) {
  const gardenerAge = hoursAgo(data.gardener_last_run);
  const backupAge   = hoursAgo(data.backup_last_commit);

  const orphanRatio   = data.total_notes > 0 ? data.orphan_count / data.total_notes : null;
  const clusteredRatio = data.total_notes > 0 ? 1 - (data.unclustered_count / data.total_notes) : null;

  const items = [
    {
      label: 'Gardener',
      status: getHealthStatus('gardener', gardenerAge),
      display: formatAge(gardenerAge),
    },
    {
      label: 'Orphans',
      status: getHealthStatus('orphans', orphanRatio),
      display: orphanRatio !== null ? formatPct(orphanRatio) : 'unknown',
    },
    {
      label: 'Clustered',
      status: getHealthStatus('clustered', clusteredRatio),
      display: clusteredRatio !== null ? formatPct(clusteredRatio) : 'unknown',
    },
    {
      label: 'Links / note',
      status: getHealthStatus('links_per_note', data.avg_links_per_note),
      display: typeof data.avg_links_per_note === 'number'
        ? data.avg_links_per_note.toFixed(1)
        : 'unknown',
    },
    {
      label: 'Backup',
      status: getHealthStatus('backup', backupAge),
      display: formatAge(backupAge),
    },
  ];

  const itemHtml = items.map(i => `
    <div class="health-item">
      ${healthDot(i.status)}
      <span class="health-label">${i.label}</span>
      <span class="health-value">${i.display}</span>
    </div>`).join('');

  return `<div class="health-row">${itemHtml}</div>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function healthDot(status) {
  return `<span class="dot dot-${status}"></span>`;
}

/**
 * Returns hours elapsed since an ISO timestamp, or null if the value is null/invalid.
 */
function hoursAgo(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms) || ms < 0) return null;
  return ms / (1000 * 60 * 60);
}

function formatAge(hours) {
  if (hours === null) return 'unknown';
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatPct(ratio) {
  return `${Math.round(ratio * 100)}%`;
}

/**
 * Compute health status for a named metric.
 * Returns 'green', 'amber', 'red', or 'gray'.
 */
function getHealthStatus(metric, value) {
  if (value === null || value === undefined) return 'gray';

  switch (metric) {
    case 'gardener':
    case 'backup':
      // value = hours since last run
      if (value < 26)  return 'green';
      if (value <= 48) return 'amber';
      return 'red';

    case 'orphans':
      // value = orphan_count / total_notes (ratio)
      if (value < 0.15)  return 'green';
      if (value <= 0.25) return 'amber';
      return 'red';

    case 'clustered':
      // value = 1 - unclustered_count / total_notes (ratio)
      if (value > 0.85)  return 'green';
      if (value >= 0.70) return 'amber';
      return 'red';

    case 'links_per_note':
      // value = avg_links_per_note
      if (value > 2)  return 'green';
      if (value >= 1) return 'amber';
      return 'red';

    default:
      return 'gray';
  }
}
