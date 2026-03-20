export async function init(api) {
  const container = document.getElementById('recent');
  try {
    container.innerHTML = '<p class="loading">Loading recent captures...</p>';
    const notes = await api.fetch('/recent?limit=15');
    render(container, notes);
  } catch (err) {
    container.innerHTML = '<p class="error">Recent captures unavailable. <button class="retry-btn" onclick="location.reload()">Retry</button></p>';
  }
}

function render(container, notes) {
  container.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'section-header';
  const title = document.createElement('span');
  title.className = 'section-title';
  title.textContent = 'Recent Captures';
  header.appendChild(title);
  container.appendChild(header);

  const list = document.createElement('ul');
  list.className = 'recent-list';

  for (const note of notes) {
    const li = document.createElement('li');
    li.className = 'recent-item';

    // Image indicator
    if (note.image_url) {
      const img = document.createElement('img');
      img.src = note.image_url;
      img.alt = '';
      img.width = 32;
      img.height = 32;
      img.style.cssText = 'border-radius: 4px; object-fit: cover; flex-shrink: 0;';
      img.onerror = () => { img.replaceWith(document.createTextNode('\u{1F4F7}')); };
      li.appendChild(img);
    }

    // Body
    const body = document.createElement('div');
    body.className = 'recent-body';

    const titleEl = document.createElement('div');
    titleEl.className = 'recent-title';
    titleEl.textContent = note.title;
    body.appendChild(titleEl);

    const meta = document.createElement('div');
    meta.className = 'recent-meta';

    // Source badge
    const badge = document.createElement('span');
    badge.className = 'source-badge ' + (note.source === 'telegram' ? 'source-telegram' : 'source-mcp');
    badge.textContent = note.source;
    meta.appendChild(badge);

    // Tags
    for (const tag of note.tags) {
      const pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.textContent = tag;
      meta.appendChild(pill);
    }

    // Timestamp
    const ts = document.createElement('span');
    ts.className = 'recent-timestamp';
    ts.textContent = formatRelativeTime(note.created_at);
    meta.appendChild(ts);

    body.appendChild(meta);
    li.appendChild(body);
    list.appendChild(li);
  }

  container.appendChild(list);
}

function formatRelativeTime(isoString) {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(isoString).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
