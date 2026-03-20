import cytoscape from 'cytoscape';

let currentResolution = null;
let clustersData = null;
let expandedCardEl = null;
let cyInstance = null;

export async function init(api) {
  const container = document.getElementById('clusters');
  try {
    container.innerHTML = '<p class="loading">Loading clusters...</p>';
    const data = await api.fetch('/clusters?resolution=1.0');
    clustersData = data;
    currentResolution = data.resolution;
    renderGrid(container, data, api);
  } catch (err) {
    renderError(container, api);
  }
}

// ── Grid view ───────────────────────────────────────────────────────────────

function renderGrid(container, data, api) {
  container.innerHTML = '';

  // Section header with resolution selector
  const header = document.createElement('div');
  header.className = 'section-header';

  const title = document.createElement('span');
  title.className = 'section-title';
  title.textContent = 'Clusters';

  const select = document.createElement('select');
  select.className = 'resolution-selector';
  for (const res of data.available_resolutions) {
    const opt = document.createElement('option');
    opt.value = res;
    opt.textContent = `Resolution ${res}`;
    if (res === data.resolution) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', async () => {
    const res = select.value;
    try {
      container.innerHTML = '<p class="loading">Loading clusters...</p>';
      const newData = await api.fetch(`/clusters?resolution=${res}`);
      clustersData = newData;
      currentResolution = newData.resolution;
      collapseCluster();
      renderGrid(container, newData, api);
    } catch (err) {
      renderError(container, api);
    }
  });

  header.appendChild(title);
  header.appendChild(select);
  container.appendChild(header);

  // Empty state
  if (!data.clusters || data.clusters.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'loading';
    empty.textContent = 'No clusters at this resolution.';
    container.appendChild(empty);
    return;
  }

  // Cluster grid
  const grid = document.createElement('div');
  grid.className = 'cluster-grid';

  const sorted = [...data.clusters].sort((a, b) => b.gravity - a.gravity);

  for (const cluster of sorted) {
    const card = buildCard(cluster, api, grid);
    grid.appendChild(card);
  }

  container.appendChild(grid);
}

function buildCard(cluster, api, grid) {
  const card = document.createElement('div');
  card.className = 'cluster-card';

  // Label
  const label = document.createElement('div');
  label.className = 'cluster-label';
  label.textContent = cluster.label;

  // Meta
  const meta = document.createElement('div');
  meta.className = 'cluster-meta';
  meta.textContent = `${cluster.note_count} notes · gravity ${cluster.gravity.toFixed(2)}`;

  // Tags
  const tags = document.createElement('div');
  tags.className = 'cluster-tags';
  for (const tag of cluster.top_tags) {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.textContent = tag;
    tags.appendChild(pill);
  }

  // Hub notes
  const hubs = document.createElement('div');
  hubs.className = 'cluster-hubs';
  if (cluster.hub_notes && cluster.hub_notes.length > 0) {
    const hubLines = cluster.hub_notes.map(h => {
      const truncated = h.title.length > 60 ? h.title.slice(0, 57) + '...' : h.title;
      return `Hub: <span class="cluster-hub-title">${escapeHtml(truncated)}</span>`;
    });
    hubs.innerHTML = hubLines.join('<br>');
  }

  card.appendChild(label);
  card.appendChild(meta);
  card.appendChild(tags);
  card.appendChild(hubs);

  // Click to expand/collapse
  card.addEventListener('click', (e) => {
    // If already expanded and clicking the header area, collapse
    if (card.classList.contains('expanded')) {
      // Only collapse if clicking the header portion, not the detail area
      const detail = card.querySelector('.cluster-detail');
      if (detail && detail.contains(e.target)) return;
      collapseCluster();
      return;
    }

    // Collapse any existing expanded card first
    collapseCluster();

    // Expand this card
    expandCluster(card, cluster, api);
  });

  return card;
}

// ── Expanded view ───────────────────────────────────────────────────────────

async function expandCluster(card, cluster, api) {
  card.classList.add('expanded');
  expandedCardEl = card;

  // Loading indicator in the detail area
  const detail = document.createElement('div');
  detail.className = 'cluster-detail';
  detail.innerHTML = '<p class="loading">Loading cluster detail...</p>';
  card.appendChild(detail);

  try {
    const noteIds = cluster.note_ids.slice(0, 50);
    const data = await api.fetch(`/clusters/detail?note_ids=${noteIds.join(',')}`);
    const hubNoteIds = new Set((cluster.hub_notes || []).map(h => h.id));

    detail.innerHTML = '';

    // Left: graph
    const graphContainer = document.createElement('div');
    graphContainer.className = 'graph-container';
    detail.appendChild(graphContainer);

    // Right: note list
    const listContainer = document.createElement('div');
    listContainer.className = 'note-list';
    detail.appendChild(listContainer);

    renderNoteList(listContainer, data.notes);
    renderGraph(graphContainer, data.notes, data.links, hubNoteIds);
  } catch (err) {
    detail.innerHTML = '<p class="error">Failed to load cluster detail.</p>';
  }
}

function collapseCluster() {
  if (cyInstance) {
    cyInstance.destroy();
    cyInstance = null;
  }
  if (expandedCardEl) {
    expandedCardEl.classList.remove('expanded');
    const detail = expandedCardEl.querySelector('.cluster-detail');
    if (detail) detail.remove();
    expandedCardEl = null;
  }
  // Remove any lingering tooltips
  removeTooltip();
}

// ── Cytoscape graph ─────────────────────────────────────────────────────────

function renderGraph(graphContainer, notes, links, hubNoteIds) {
  if (cyInstance) {
    cyInstance.destroy();
    cyInstance = null;
  }

  // Compute link counts per node
  const linkCounts = {};
  for (const note of notes) {
    linkCounts[note.id] = 0;
  }
  for (const link of links) {
    if (linkCounts[link.from_id] !== undefined) linkCounts[link.from_id]++;
    if (linkCounts[link.to_id] !== undefined) linkCounts[link.to_id]++;
  }

  // Map link count to node size (20-50px range)
  const maxLinks = Math.max(1, ...Object.values(linkCounts));
  function nodeSize(id) {
    if (links.length === 0) return 30;
    const count = linkCounts[id] || 0;
    return 20 + (count / maxLinks) * 30;
  }

  // Build elements
  const elements = [];

  for (const note of notes) {
    const truncTitle = note.title.length > 30 ? note.title.slice(0, 27) + '...' : note.title;
    elements.push({
      group: 'nodes',
      data: {
        id: note.id,
        label: truncTitle,
        fullTitle: note.title,
        tags: note.tags,
        isHub: hubNoteIds.has(note.id),
        size: nodeSize(note.id),
      },
    });
  }

  for (const link of links) {
    elements.push({
      group: 'edges',
      data: {
        id: `${link.from_id}-${link.to_id}`,
        source: link.from_id,
        target: link.to_id,
        isGardener: link.created_by === 'gardener',
      },
    });
  }

  cyInstance = cytoscape({
    container: graphContainer,
    elements,
    style: [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          width: 'data(size)',
          height: 'data(size)',
          'background-color': '#8b949e',
          color: '#e6edf3',
          'font-size': '9px',
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': 6,
          'text-max-width': '90px',
          'text-wrap': 'ellipsis',
          'border-width': 0,
        },
      },
      {
        selector: 'node[?isHub]',
        style: {
          'background-color': '#58a6ff',
          'border-width': 2,
          'border-color': '#79c0ff',
        },
      },
      {
        selector: 'edge',
        style: {
          width: 1.5,
          'line-color': '#30363d',
          'curve-style': 'bezier',
          'line-style': 'solid',
        },
      },
      {
        selector: 'edge[?isGardener]',
        style: {
          'line-style': 'dashed',
          'line-dash-pattern': [6, 3],
        },
      },
    ],
    layout: {
      name: 'cose',
      animate: false,
      nodeOverlap: 20,
      idealEdgeLength: 80,
      padding: 20,
    },
    userZoomingEnabled: true,
    userPanningEnabled: true,
    boxSelectionEnabled: false,
  });

  // Tap handler for tooltips
  cyInstance.on('tap', 'node', (e) => {
    const node = e.target;
    const fullTitle = node.data('fullTitle');
    const tags = node.data('tags') || [];
    const pos = node.renderedPosition();
    const containerRect = graphContainer.getBoundingClientRect();

    removeTooltip();

    const tooltip = document.createElement('div');
    tooltip.id = 'cluster-tooltip';
    tooltip.style.cssText = `
      position: fixed;
      z-index: 50;
      background: #1c2128;
      border: 1px solid #30363d;
      border-radius: 4px;
      padding: 0.5rem 0.75rem;
      font-size: 0.75rem;
      color: #e6edf3;
      max-width: 250px;
      pointer-events: none;
    `;

    let html = `<div style="font-weight:600;margin-bottom:0.25rem">${escapeHtml(fullTitle)}</div>`;
    if (tags.length > 0) {
      html += `<div style="display:flex;flex-wrap:wrap;gap:0.2rem">`;
      for (const tag of tags) {
        html += `<span class="tag-pill">${escapeHtml(tag)}</span>`;
      }
      html += `</div>`;
    }
    tooltip.innerHTML = html;

    // Position relative to the viewport
    tooltip.style.left = `${containerRect.left + pos.x + 10}px`;
    tooltip.style.top = `${containerRect.top + pos.y - 10}px`;

    document.body.appendChild(tooltip);
  });

  // Tap on background to dismiss tooltip
  cyInstance.on('tap', (e) => {
    if (e.target === cyInstance) {
      removeTooltip();
    }
  });
}

function removeTooltip() {
  const existing = document.getElementById('cluster-tooltip');
  if (existing) existing.remove();
}

// ── Note list ───────────────────────────────────────────────────────────────

function renderNoteList(listContainer, notes) {
  for (const note of notes) {
    const item = document.createElement('div');
    item.className = 'note-list-item';

    const titleEl = document.createElement('div');
    titleEl.className = 'note-list-title';
    const imgPrefix = note.image_url ? '\u{1F4F7} ' : '';
    titleEl.textContent = imgPrefix + note.title;
    item.appendChild(titleEl);

    if (note.tags && note.tags.length > 0) {
      const tagsEl = document.createElement('div');
      tagsEl.className = 'cluster-tags';
      for (const tag of note.tags) {
        const pill = document.createElement('span');
        pill.className = 'tag-pill';
        pill.textContent = tag;
        tagsEl.appendChild(pill);
      }
      item.appendChild(tagsEl);
    }

    listContainer.appendChild(item);
  }
}

// ── Error state ─────────────────────────────────────────────────────────────

function renderError(container, api) {
  container.innerHTML = `
    <div class="section-header">
      <span class="section-title">Clusters</span>
    </div>
    <p class="error">
      Clusters unavailable.
      <button class="retry-btn" id="clusters-retry">Retry</button>
    </p>`;
  const btn = container.querySelector('#clusters-retry');
  if (btn) {
    btn.addEventListener('click', () => init(api));
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}
