/**
 * SpectrumX — Popup Dashboard Logic
 *
 * Renders the main dashboard UI with:
 * - Live countdown timer for the nearest deadline
 * - Prioritized event list (urgent → upcoming → later)
 * - Course and type filtering
 * - Source links for every event
 * - Expandable event details with smooth animation
 * - Stats overview
 * - Settings panel
 * - Keyboard shortcuts for power users
 */

import {
  getPriority, formatDate, getEventIcon, getEventLabel
} from './shared/data.js';

// ============================================================
// State
// ============================================================
let allEvents = [];
let allCourses = [];
let activeTypeFilter = 'all';
let activeCourseFilter = 'all';
let showPast = false;

// ============================================================
// DOM References
// ============================================================
const eventsContainer = document.getElementById('eventsContainer');
const skeleton = document.getElementById('skeleton');
const emptyState = document.getElementById('emptyState');
const courseFilter = document.getElementById('courseFilter');
const showPastCheckbox = document.getElementById('showPast');
const lastUpdated = document.getElementById('lastUpdated');
const urgentCount = document.getElementById('urgentCount');
const upcomingCount = document.getElementById('upcomingCount');
const laterCount = document.getElementById('laterCount');

// ============================================================
// Initialize — load data and render
// ============================================================
async function init() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_EVENTS' });

    if (!response.events || response.events.length === 0) {
      allEvents = [];
      allCourses = [];
      lastUpdated.textContent = 'No data — visit Spectrum to scan';
    } else {
      allEvents = response.events;
      allCourses = response.courses || [];
      const scraped = new Date(response.lastScraped);
      lastUpdated.textContent = `Updated ${scraped.toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })}`;
    }

    populateCourseFilter();
    renderEvents();
    updateStats();
    startCountdown();

  } catch (err) {
    console.error('[SpectrumX] Init error:', err);
    allEvents = [];
    allCourses = [];
    lastUpdated.textContent = 'No data — visit Spectrum to scan';
    populateCourseFilter();
    renderEvents();
    updateStats();
    startCountdown();
  }

  skeleton.style.display = 'none';
}

// ============================================================
// Live Countdown Timer — ticks every second
// ============================================================
let countdownInterval = null;

function startCountdown() {
  const hero = document.getElementById('countdownHero');
  if (!hero) return;

  const now = new Date();
  const upcoming = allEvents
    .filter(e => new Date(e.date) > now)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (upcoming.length === 0) {
    hero.style.display = 'none';
    return;
  }

  const next = upcoming[0];
  const course = allCourses.find(c => c.id === next.courseId);

  document.getElementById('countdownTitle').textContent = next.title;
  document.getElementById('countdownMeta').textContent =
    `${next.courseId}${course ? ' — ' + course.name : ''} · ${getEventLabel(next.type)}`;
  hero.style.display = 'block';

  if (countdownInterval) clearInterval(countdownInterval);

  function tick() {
    const diff = new Date(next.date) - new Date();
    if (diff <= 0) {
      hero.style.display = 'none';
      clearInterval(countdownInterval);
      return;
    }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    document.getElementById('cdDays').textContent = String(d).padStart(2, '0');
    document.getElementById('cdHours').textContent = String(h).padStart(2, '0');
    document.getElementById('cdMins').textContent = String(m).padStart(2, '0');
    document.getElementById('cdSecs').textContent = String(s).padStart(2, '0');

    hero.classList.toggle('urgent', diff <= 172800000);
  }

  tick();
  countdownInterval = setInterval(tick, 1000);
}

// ============================================================
// Populate course filter dropdown
// ============================================================
function populateCourseFilter() {
  courseFilter.innerHTML = '<option value="all">All Courses</option>';
  const courseIds = [...new Set(allEvents.map(e => e.courseId))];
  courseIds.forEach(id => {
    const course = allCourses.find(c => c.id === id);
    const option = document.createElement('option');
    option.value = id;
    option.textContent = course ? `${id} — ${course.name}` : id;
    courseFilter.appendChild(option);
  });
}

// ============================================================
// Filter events based on current filter state
// ============================================================
function getFilteredEvents() {
  return allEvents.filter(event => {
    const priority = getPriority(event.date);
    if (!showPast && priority === 'past') return false;
    if (activeTypeFilter !== 'all' && event.type !== activeTypeFilter) return false;
    if (activeCourseFilter !== 'all' && event.courseId !== activeCourseFilter) return false;
    return true;
  });
}

// ============================================================
// Group events by priority section
// ============================================================
function groupByPriority(events) {
  const groups = { urgent: [], upcoming: [], later: [], past: [] };
  events.forEach(event => {
    const priority = getPriority(event.date);
    if (groups[priority]) groups[priority].push(event);
  });
  Object.values(groups).forEach(group =>
    group.sort((a, b) => new Date(a.date) - new Date(b.date))
  );
  return groups;
}

// ============================================================
// Render events list
// ============================================================
function renderEvents() {
  const filtered = getFilteredEvents();

  if (filtered.length === 0) {
    eventsContainer.innerHTML = '';
    
    if (allEvents.length === 0) {
      // No data at all — show Spectrum CTA
      emptyState.innerHTML = `
        <div class="empty-illustration">
          <svg width="100" height="100" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="50" cy="50" r="40" fill="#1A1A25" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
            <text x="50" y="55" text-anchor="middle" fill="#34D399" font-size="28">📚</text>
          </svg>
        </div>
        <h3 class="empty-title">No deadlines loaded yet</h3>
        <p class="empty-text">Visit your <a href="https://spectrum.um.edu.my" target="_blank" style="color: #34D399; text-decoration: underline;">Spectrum dashboard</a> and this extension will auto-scan your courses and deadlines.</p>
      `;
    } else {
      // Has data but filters show nothing
      emptyState.innerHTML = `
        <div class="empty-illustration">
          <svg width="100" height="100" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="50" cy="50" r="40" fill="#1A1A25" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
            <path d="M35 50 L45 60 L65 40" stroke="#34D399" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <h3 class="empty-title">All clear! 🎉</h3>
        <p class="empty-text">No matching deadlines. Try adjusting your filters.</p>
      `;
    }
    
    emptyState.style.display = 'flex';
    return;
  }

  emptyState.style.display = 'none';
  const groups = groupByPriority(filtered);
  let html = '';

  const sections = [
    { key: 'urgent', label: '🔴 Due Within 48 Hours', dot: 'urgent' },
    { key: 'upcoming', label: '🟡 This Week', dot: 'upcoming' },
    { key: 'later', label: '🟢 Coming Up', dot: 'later' },
    { key: 'past', label: '⚫ Past', dot: 'past' }
  ];

  sections.forEach(section => {
    const events = groups[section.key];
    if (!events || events.length === 0) return;

    html += `
      <div class="section-header">
        <div class="section-dot ${section.dot}"></div>
        <span class="section-title">${section.label}</span>
      </div>
    `;

    events.forEach((event, index) => {
      const priority = getPriority(event.date);
      const dateInfo = formatDate(event.date);
      const course = allCourses.find(c => c.id === event.courseId);
      const courseColor = course?.color || '#8B5CF6';
      const icon = getEventIcon(event.type);

      html += `
        <div class="event-card ${priority}" data-event-id="${event.id}" style="animation-delay: ${index * 0.05}s;">
          <div class="event-icon">${icon}</div>
          <div class="event-content">
            <div class="event-title">${escapeHtml(event.title)}</div>
            <div class="event-meta">
              <span class="event-course" style="background: ${courseColor}20; color: ${courseColor}; border: 1px solid ${courseColor}30;">
                ${escapeHtml(event.courseId)}
              </span>
              <span class="event-date ${priority === 'urgent' ? 'urgent-text' : ''}">${dateInfo.absolute}</span>
            </div>
            <div class="event-detail">
              ${event.description ? `<div class="event-description">${escapeHtml(event.description)}</div>` : ''}
              ${event.location ? `<div class="event-location">📍 ${escapeHtml(event.location)}</div>` : ''}
              <a class="source-link" href="${event.sourceUrl}" target="_blank" rel="noopener" title="View on Spectrum">
                🔗 ${escapeHtml(event.sourceText || 'View on Spectrum')}
              </a>
            </div>
          </div>
          <div class="event-right">
            <span class="event-countdown ${priority}">${dateInfo.relative}</span>
            <span class="event-source" title="${escapeHtml(event.sourceText || '')}">
              <svg class="event-source-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Source
            </span>
          </div>
        </div>
      `;
    });
  });

  eventsContainer.innerHTML = html;

  eventsContainer.querySelectorAll('.event-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.source-link')) return;
      card.classList.toggle('expanded');
    });
  });
}

// ============================================================
// Update stats bar
// ============================================================
function updateStats() {
  let urgent = 0, upcoming = 0, later = 0;
  allEvents.forEach(event => {
    const priority = getPriority(event.date);
    if (priority === 'urgent') urgent++;
    else if (priority === 'upcoming') upcoming++;
    else if (priority === 'later') later++;
  });
  urgentCount.textContent = urgent;
  upcomingCount.textContent = upcoming;
  laterCount.textContent = later;
}

// ============================================================
// Escape HTML to prevent XSS
// ============================================================
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================
// Event Listeners
// ============================================================

document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    activeTypeFilter = chip.dataset.filter;
    renderEvents();
  });
});

courseFilter.addEventListener('change', () => {
  activeCourseFilter = courseFilter.value;
  renderEvents();
});

showPastCheckbox.addEventListener('change', () => {
  showPast = showPastCheckbox.checked;
  renderEvents();
});

document.getElementById('refreshBtn').addEventListener('click', async () => {
  await init();
});

// Deep Scan button — triggers offscreen-powered scan of all Spectrum pages
document.getElementById('deepScanBtn').addEventListener('click', async () => {
  const btn = document.getElementById('deepScanBtn');
  const scanStatus = document.getElementById('scanStatus');
  const scanText = document.getElementById('scanText');
  const scanBar = document.getElementById('scanProgressBar');

  btn.classList.add('scanning');
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Scanning...';
  scanStatus.style.display = 'flex';
  scanText.textContent = 'Starting DeepScan...';
  scanBar.style.width = '5%';

  // Listen for progress updates from background (offscreen scanner)
  const progressListener = (message) => {
    if (message.type === 'DEEP_SCAN_PROGRESS') {
      const { phase, message: msg } = message.payload;
      const phases = { dashboard: 15, calendar: 35, courses: 70 };
      const pct = phases[phase] || 50;
      scanBar.style.width = pct + '%';
      scanText.textContent = msg;
    }
  };
  chrome.runtime.onMessage.addListener(progressListener);

  try {
    // Use the new offscreen-powered DEEP_SCAN (no Spectrum tab needed!)
    const result = await chrome.runtime.sendMessage({ type: 'DEEP_SCAN' });

    if (result.success) {
      scanBar.style.width = '100%';
      scanText.textContent = `Found ${result.eventsFound} events across ${result.pagesScanned} pages ✅`;
      // Refresh the dashboard with new data
      await new Promise(r => setTimeout(r, 1000));
      await init();
    } else {
      scanText.textContent = result.error || 'Scan failed';
      scanBar.style.width = '0%';
    }
  } catch (err) {
    scanText.textContent = 'Error: ' + (err.message || 'Unknown error');
    scanBar.style.width = '0%';
  }

  chrome.runtime.onMessage.removeListener(progressListener);

  btn.classList.remove('scanning');
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Deep Scan';

  setTimeout(() => {
    scanStatus.style.display = 'none';
    scanBar.style.width = '0%';
  }, 4000);
});

document.getElementById('chatbotBtn').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html') });
  }
});

document.getElementById('settingsBtn').addEventListener('click', () => {
  document.getElementById('settingsPanel').style.display = 'flex';
});

document.getElementById('backBtn').addEventListener('click', () => {
  document.getElementById('settingsPanel').style.display = 'none';
});

// Settings: Notifications toggle
document.getElementById('notifToggle').addEventListener('change', async (e) => {
  const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  settings.notificationsEnabled = e.target.checked;
  await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', payload: settings });
});

// Settings: Notify hours
document.getElementById('notifyHours').addEventListener('change', async (e) => {
  const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  settings.notifyBeforeHours = parseInt(e.target.value);
  await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', payload: settings });
});

// ============================================================
// Keyboard Shortcuts
// ============================================================
document.addEventListener('keydown', (e) => {
  if (e.key >= '1' && e.key <= '6' && !e.ctrlKey && !e.metaKey) {
    const chips = document.querySelectorAll('.filter-chip');
    const idx = parseInt(e.key) - 1;
    if (chips[idx]) chips[idx].click();
  }
  if (e.key === 'r' && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== 'INPUT') {
    document.getElementById('refreshBtn').click();
  }
});

// ============================================================
// Boot
// ============================================================
init();