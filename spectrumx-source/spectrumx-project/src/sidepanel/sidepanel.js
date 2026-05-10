/**
 * SpectrumX — AI Chatbot (Side Panel) v5
 *
 * Uses Ilmu AI (Anthropic-compatible API) with ilmu-glm-5.1
 * to answer questions about deadlines, events, and course schedule.
 *
 * v5 Features:
 * - Built-in API key — works out of the box
 * - Users can override with their own key
 * - Automatic retry with exponential backoff
 * - Client-side request throttle (5s between calls)
 * - Compact system prompt to minimize tokens
 * - Chat history capped at 6 messages
 * - Seamless local fallback when API unavailable
 */

import {
  getPriority, formatDate, getEventIcon, getEventLabel
} from '../shared/data.js';

// ============================================================
// API Configuration
// ============================================================
const BUILT_IN_KEY = 'sk-74051ec75bec68491743904988c68f95d7e67b977634fd8f';
const API_URL = 'https://api.ilmu.ai/anthropic/v1/messages';
const API_MODEL = 'ilmu-glm-5.1';
const API_VERSION = '2023-06-01';

// ============================================================
// Constants
// ============================================================
const MAX_CHAT_HISTORY = 6;
const MAX_UPCOMING_EVENTS = 5;
const MAX_PAST_EVENTS = 2;
const MAX_RESPONSE_TOKENS = 1024;
const MIN_REQUEST_INTERVAL = 5000;
const MAX_RETRIES = 3;
const RETRY_DELAYS = [3000, 6000, 12000];

// ============================================================
// State
// ============================================================
let events = [];
let courses = [];
let hasData = false;
let apiKey = '';
let usingBuiltInKey = false;
let chatHistory = [];
let isStreaming = false;
let lastRequestTime = 0;

// ============================================================
// DOM References
// ============================================================
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const clearBtn = document.getElementById('clearBtn');
const quickActions = document.getElementById('quickActions');
const apiBanner = document.getElementById('apiBanner');
const apiKeyInput = document.getElementById('apiKeyInput');
const apiKeySave = document.getElementById('apiKeySave');
const chatSubtitle = document.getElementById('chatSubtitle');

// ============================================================
// Initialize
// ============================================================
async function init() {
  try {
    const data = await chrome.storage.local.get(['ilmuApiKey']);
    if (data.ilmuApiKey) {
      apiKey = data.ilmuApiKey;
      usingBuiltInKey = false;
    } else {
      apiKey = BUILT_IN_KEY;
      usingBuiltInKey = true;
    }
  } catch (e) {
    apiKey = BUILT_IN_KEY;
    usingBuiltInKey = true;
  }

  if (apiBanner) apiBanner.style.display = 'none';

  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_EVENTS' });
    if (!response.events || response.events.length === 0) {
      events = [];
      courses = [];
      hasData = false;
      chatSubtitle.textContent = 'No data — visit Spectrum first';
    } else {
      events = response.events;
      courses = response.courses || [];
      hasData = true;
      chatSubtitle.textContent = `${events.length} events loaded`;
    }
  } catch (e) {
    events = [];
    courses = [];
    hasData = false;
    chatSubtitle.textContent = 'No data — visit Spectrum first';
  }
}

// ============================================================
// Build system prompt
// ============================================================
function buildSystemPrompt() {
  const now = new Date();

  // ALL upcoming events (not just top 5 — AI needs full picture)
  const upcoming = events
    .filter(e => new Date(e.date) > now)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const recentPast = events
    .filter(e => new Date(e.date) <= now)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MAX_PAST_EVENTS);

  // Build rich event list with urgency tags
  let eventList = '';
  if (upcoming.length > 0) {
    eventList += `ALL UPCOMING DEADLINES (${upcoming.length} total):\n`;
    upcoming.forEach(e => {
      const p = getPriority(e.date);
      const d = formatDate(e.date);
      const c = courses.find(x => x.id === e.courseId);
      const diffMs = new Date(e.date) - now;
      const diffDays = Math.floor(diffMs / 86400000);
      const diffHours = Math.floor(diffMs / 3600000);
      let urgency;
      if (diffHours <= 24) urgency = '🔴 DUE IN HOURS';
      else if (diffHours <= 48) urgency = '🟠 DUE TOMORROW';
      else if (diffDays <= 7) urgency = '🟡 THIS WEEK';
      else urgency = '🟢 LATER';

      eventList += `- [${urgency}] ${e.title} | Course: ${e.courseId}${c ? ' (' + c.name + ')' : ''} | Type: ${getEventLabel(e.type)} | Due: ${d.absolute} (${d.relative})\n`;
      if (e.location) eventList += `  Location: ${e.location}\n`;
      eventList += `  Source: ${e.sourceUrl}\n`;
    });
  } else {
    eventList += 'No upcoming deadlines.\n';
  }

  if (recentPast.length > 0) {
    eventList += '\nPAST:\n';
    recentPast.forEach(e => {
      eventList += `- ${e.title} | ${e.courseId} | ${formatDate(e.date).absolute}\n`;
    });
  }

  // Build urgency analysis
  let urgencyAnalysis = '';
  if (upcoming.length > 0) {
    const urgent = upcoming.filter(e => { const d = new Date(e.date) - now; return d > 0 && d <= 48*3600000; });
    const thisWeek = upcoming.filter(e => { const d = new Date(e.date) - now; return d > 48*3600000 && d <= 7*86400000; });
    const byCourse = {};
    upcoming.forEach(e => {
      if (!byCourse[e.courseId]) byCourse[e.courseId] = [];
      byCourse[e.courseId].push(e.title);
    });

    if (urgent.length > 0) urgencyAnalysis += `\n🔴 URGENT (${urgent.length}): ${urgent.map(e => e.title + ' [' + e.courseId + ']').join(', ')}`;
    if (thisWeek.length > 0) urgencyAnalysis += `\n🟡 THIS WEEK (${thisWeek.length}): ${thisWeek.map(e => e.title + ' [' + e.courseId + ']').join(', ')}`;
    urgencyAnalysis += '\n\nWORKLOAD BY COURSE:';
    for (const [cid, evts] of Object.entries(byCourse)) {
      urgencyAnalysis += `\n  ${cid}: ${evts.length} upcoming — ${evts.slice(0, 3).join(', ')}`;
    }
  }

  let courseList = '';
  if (courses.length > 0) {
    courseList = 'COURSES (' + courses.length + ' enrolled):\n' + courses.map(c => `  ${c.id}: ${c.name}`).join('\n') + '\n';
  }

  return `You are SpectrumX AI — an AUTONOMOUS academic assistant for a UM (Universiti Malaya) student on SPeCTRUM (Moodle).

You are NOT a basic chatbot. You ALREADY HAVE all the student's deadline data below. Your job is to PROACTIVELY analyze it and give actionable insights.

CORE BEHAVIOR:
- NEVER ask the student to "go check their dashboard" or "copy paste deadlines" — YOU HAVE THE DATA
- ALWAYS reference specific deadlines, courses, and dates from the data below
- Proactively offer insights like "Heads up, you have 3 things due this week"
- When asked what to focus on, prioritize by: urgency → type weight (exam > assignment) → difficulty
- Identify workload bottlenecks (e.g., "3 assignments due same week")
- Be direct, concise, action-oriented. Use bullet points and bold for key info
- Use Malaysian English naturally (lah, kan, etc. — but not over the top)

═══ ${courseList}═══
${eventList}
═══ URGENCY ANALYSIS ═══${urgencyAnalysis || '\nNo urgent items.'}

═══ TODAY: ${now.toLocaleString('en-MY', { dateStyle: 'full', timeStyle: 'short' })} MYT ═══

RULES:
1. Always cite source URL when mentioning events
2. Use 🔴🟡🟢 urgency indicators
3. Don't invent deadlines — only use provided data
4. Keep answers SHORT — students want quick answers
5. If no data loaded, tell them to visit spectrum.um.edu.my and click "Deep Scan"${!hasData ? '\n\n⚠️ NOTE: No real data loaded yet. Tell the user to visit spectrum.um.edu.my and use Deep Scan.' : ''}`;
}

// ============================================================
// Sleep helper
// ============================================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// Send message to Ilmu AI (Anthropic-compatible)
// ============================================================
async function sendToAPI(userMessage) {
  if (!apiKey) {
    return { error: true, text: 'No API key available.' };
  }

  chatHistory.push({ role: 'user', content: userMessage });

  if (chatHistory.length > MAX_CHAT_HISTORY) {
    chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY);
  }

  const timeSinceLastRequest = Date.now() - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await sleep(MIN_REQUEST_INTERVAL - timeSinceLastRequest);
  }

  const requestBody = {
    model: API_MODEL,
    max_tokens: MAX_RESPONSE_TOKENS,
    system: buildSystemPrompt(),
    messages: chatHistory
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const delay = RETRY_DELAYS[attempt - 1] || 12000;
        console.log(`[SpectrumX Chat] Retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
        await sleep(delay);
      }

      lastRequestTime = Date.now();

      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION
        },
        body: JSON.stringify(requestBody)
      });

      // ---- Success ----
      if (response.ok) {
        const data = await response.json();
        const assistantText = data.content?.[0]?.text || '';

        if (!assistantText.trim()) {
          if (attempt < MAX_RETRIES) continue;
          return { error: true, text: 'Empty response from AI. Try again.' };
        }

        chatHistory.push({ role: 'assistant', content: assistantText });
        console.log('[SpectrumX Chat] API success on attempt', attempt + 1);
        return { error: false, text: assistantText };
      }

      // ---- Errors ----
      const errBody = await response.json().catch(() => ({}));
      const errMsg = errBody.error?.message || errBody.message || '';
      console.warn(`[SpectrumX Chat] API error ${response.status} on attempt ${attempt + 1}:`, errMsg);

      // 401 — bad key
      if (response.status === 401) {
        return { error: true, text: '❌ Invalid API key. Check your key and try again.' };
      }

      // 429 — rate limited
      if (response.status === 429) {
        if (attempt < MAX_RETRIES) continue;
        return { error: true, text: '⏳ Rate limited. Wait a minute and try again.' };
      }

      // 400 — context/token error
      if (response.status === 400) {
        if (/token|context|length|too.long/i.test(errMsg)) {
          chatHistory = chatHistory.slice(-2);
          if (attempt < 1) continue;
          return { error: true, text: '📝 Context too long. Clear the chat and try again.' };
        }
        return { error: true, text: `⚠️ Bad request: ${errMsg || 'Unknown'}` };
      }

      // 402/403 — billing/quota
      if (response.status === 402 || response.status === 403) {
        return { error: true, text: '💳 API quota exceeded. Check your plan.' };
      }

      // 500+ — server error
      if (response.status >= 500) {
        if (attempt < MAX_RETRIES) continue;
        return { error: true, text: '🔧 Servers are down. Try again in a moment.' };
      }

      return { error: true, text: `⚠️ API error (${response.status}): ${errMsg || 'Unknown'}` };

    } catch (err) {
      console.warn(`[SpectrumX Chat] Network error on attempt ${attempt + 1}:`, err.message);
      if (attempt < MAX_RETRIES) continue;
      if (err.name === 'TypeError' && err.message.includes('fetch')) {
        return { error: true, text: '🌐 No internet connection.' };
      }
      return { error: true, text: `❌ Connection error: ${err.message}` };
    }
  }

  return { error: true, text: 'Failed after multiple retries. Try again.' };
}

// ============================================================
// Local fallback — works without API
// ============================================================
async function handleNoAPIFallback(userMessage) {
  const lower = userMessage.toLowerCase();
  const now = new Date();

  const upcoming = events
    .filter(e => new Date(e.date) > now)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  let responseText = '';
  let matchedEvents = [];

  if (/urgent|most urgent|soon|next|first/i.test(lower)) {
    matchedEvents = upcoming.slice(0, 3);
    responseText = matchedEvents.length > 0
      ? 'Here are your most urgent deadlines:'
      : 'No upcoming deadlines! You\'re all caught up 🎉';

  } else if (/this week|due.*week|week/i.test(lower)) {
    const weekEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    matchedEvents = upcoming.filter(e => new Date(e.date) <= weekEnd);
    responseText = matchedEvents.length > 0
      ? `You have ${matchedEvents.length} thing${matchedEvents.length > 1 ? 's' : ''} due this week:`
      : 'Nothing due this week! 🎉';

  } else if (/exam/i.test(lower)) {
    matchedEvents = upcoming.filter(e => e.type === 'exam' || e.type === 'quiz');
    responseText = matchedEvents.length > 0
      ? `Found ${matchedEvents.length} upcoming exam/quiz:`
      : 'No exams or quizzes coming up!';

  } else if (/assign/i.test(lower)) {
    matchedEvents = upcoming.filter(e => e.type === 'assignment');
    responseText = matchedEvents.length > 0
      ? `Found ${matchedEvents.length} upcoming assignment${matchedEvents.length > 1 ? 's' : ''}:`
      : 'No assignments due!';

  } else if (/all|everything|summar|deadline/i.test(lower)) {
    matchedEvents = upcoming;
    responseText = matchedEvents.length > 0
      ? `Here's everything coming up (${matchedEvents.length} events):`
      : 'No upcoming deadlines found!';

  } else {
    const courseMatch = lower.match(/([a-z]{2,4}\d{3,4}[a-z]?)/i);
    if (courseMatch) {
      const code = courseMatch[1].toUpperCase();
      matchedEvents = upcoming.filter(e =>
        e.courseId.toUpperCase() === code ||
        e.courseId.toUpperCase().includes(code)
      );
      const course = courses.find(c =>
        c.id.toUpperCase() === code || c.id.toUpperCase().includes(code)
      );
      responseText = matchedEvents.length > 0
        ? `Deadlines for ${code}${course ? ' (' + course.name + ')' : ''}:`
        : `No upcoming deadlines for ${code}.`;
    } else {
      matchedEvents = upcoming.slice(0, 5);
      responseText = 'Here\'s a summary of your upcoming deadlines:';
    }
  }

  return { responseText, matchedEvents };
}

// ============================================================
// Render Messages
// ============================================================

function addUserMessage(text) {
  const div = document.createElement('div');
  div.className = 'message user';
  div.innerHTML = `
    <div class="message-avatar">👤</div>
    <div class="message-bubble">
      <div class="message-text">${escapeHtml(text)}</div>
    </div>
  `;
  chatMessages.appendChild(div);
  scrollToBottom();
}

function addTypingIndicator() {
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.id = 'typingIndicator';
  div.innerHTML = `
    <div class="message-avatar">⚡</div>
    <div class="message-bubble">
      <div class="typing-indicator">
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
      </div>
    </div>
  `;
  chatMessages.appendChild(div);
  scrollToBottom();
}

function removeTypingIndicator() {
  document.getElementById('typingIndicator')?.remove();
}

function addAssistantMessage(text, matchedEvents = []) {
  const div = document.createElement('div');
  div.className = 'message assistant';

  let htmlText = escapeHtml(text)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');

  let eventCardsHtml = '';
  if (matchedEvents.length > 0) {
    matchedEvents.forEach(event => {
      const priority = getPriority(event.date);
      const dateInfo = formatDate(event.date);
      const icon = getEventIcon(event.type);

      eventCardsHtml += `
        <div class="chat-event-card ${priority}">
          <span class="chat-event-icon">${icon}</span>
          <div class="chat-event-info">
            <div class="chat-event-title">${escapeHtml(event.title)}</div>
            <div class="chat-event-meta">${escapeHtml(event.courseId)} · ${dateInfo.absolute}</div>
            <a class="chat-event-source" href="${event.sourceUrl}" target="_blank" rel="noopener">
              🔗 ${escapeHtml(event.sourceText || 'View on Spectrum')}
            </a>
          </div>
          <span class="chat-event-countdown ${priority}">${dateInfo.relative}</span>
        </div>
      `;
    });
  }

  div.innerHTML = `
    <div class="message-avatar">⚡</div>
    <div class="message-bubble">
      <div class="message-text">${htmlText}</div>
      ${eventCardsHtml}
    </div>
  `;

  chatMessages.appendChild(div);
  scrollToBottom();
}

function addErrorMessage(text) {
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.innerHTML = `
    <div class="message-avatar">⚡</div>
    <div class="message-bubble">
      <div class="error-msg">${escapeHtml(text)}</div>
    </div>
  `;
  chatMessages.appendChild(div);
  scrollToBottom();
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================
// Send message flow
// ============================================================
async function sendMessage(text) {
  if (!text.trim() || isStreaming) return;

  isStreaming = true;
  sendBtn.disabled = true;
  chatInput.value = '';
  chatInput.style.height = 'auto';

  if (quickActions) quickActions.style.display = 'none';

  addUserMessage(text);
  addTypingIndicator();

  const result = await sendToAPI(text);
  removeTypingIndicator();

  if (result.error) {
    addErrorMessage(result.text);
    const { responseText, matchedEvents } = await handleNoAPIFallback(text);
    if (matchedEvents.length > 0 || responseText.includes('🎉')) {
      addAssistantMessage('📎 Meanwhile, here\'s what I found:\n' + responseText, matchedEvents);
    }
  } else {
    const mentionedEvents = findMentionedEvents(result.text);
    addAssistantMessage(result.text, mentionedEvents);
  }

  isStreaming = false;
  updateSendButton();
}

function findMentionedEvents(responseText) {
  const lower = responseText.toLowerCase();
  return events.filter(e => {
    const titleWords = e.title.toLowerCase().split(/\s+/);
    const titleMatch = titleWords.some(word =>
      word.length > 3 && lower.includes(word)
    );
    const courseMatch = lower.includes(e.courseId.toLowerCase());
    return titleMatch || courseMatch;
  }).filter(e => new Date(e.date) > new Date())
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, 6);
}

function updateSendButton() {
  sendBtn.disabled = !chatInput.value.trim() || isStreaming;
}

// ============================================================
// Event Listeners
// ============================================================

chatInput.addEventListener('input', () => {
  updateSendButton();
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage(chatInput.value);
  }
});

sendBtn.addEventListener('click', () => {
  sendMessage(chatInput.value);
});

quickActions?.addEventListener('click', (e) => {
  const chip = e.target.closest('.quick-chip');
  if (chip) sendMessage(chip.dataset.query);
});

clearBtn.addEventListener('click', () => {
  chatHistory = [];
  const welcome = chatMessages.querySelector('.message');
  chatMessages.innerHTML = '';
  if (welcome) chatMessages.appendChild(welcome);

  if (quickActions) {
    quickActions.style.display = 'flex';
    chatMessages.appendChild(quickActions);
  }
});

apiKeySave.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;

  apiKey = key;
  usingBuiltInKey = false;
  try {
    await chrome.storage.local.set({ ilmuApiKey: key });
  } catch (e) {}
  apiBanner.style.display = 'none';
  addAssistantMessage('✅ Custom API key saved! Will use your key instead.', []);
});

apiKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') apiKeySave.click();
});

// ============================================================
// Listen for DeepScan results from background
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DEEP_SCAN_RESULT') {
    const { eventsFound, pagesScanned, scanType } = message.payload || {};
    const label = scanType === 'current-course' ? 'course scan' : 'full DeepScan';

    // Refresh events data so AI has the latest
    init().then(() => {
      if (eventsFound > 0) {
        addAssistantMessage(
          `🔍 **${label} complete!** Found **${eventsFound} events** across **${pagesScanned} pages**.\n\nYour deadline data is now updated. Ask me anything about your upcoming deadlines!`,
          events.slice(0, 5)
        );
      } else {
        addAssistantMessage(
          `🔍 **${label} complete.** No new events found this time. Make sure you're logged into Spectrum and try again.`,
          []
        );
      }
    });
  }

  if (message.type === 'DEEP_SCAN_PROGRESS') {
    const { message: msg } = message.payload || {};
    // Update subtitle to show progress
    if (chatSubtitle && msg) {
      chatSubtitle.textContent = `Scanning: ${msg}`;
    }
  }
});

// ============================================================
// Boot
// ============================================================
init();
