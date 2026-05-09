/**
 * SpectrumX — Shared Constants & Utilities
 * 
 * Event types, priority levels, colors, and utility functions
 * used across popup, sidepanel, and content scripts.
 */

// ============================================================
// Event Types — categorizes different academic events
// ============================================================
export const EVENT_TYPES = {
  EXAM: 'exam',
  QUIZ: 'quiz',
  ASSIGNMENT: 'assignment',
  LAB: 'lab',
  VIVA: 'viva',
  PRESENTATION: 'presentation',
  PROJECT: 'project',
  TUTORIAL: 'tutorial',
  OTHER: 'other'
};

// ============================================================
// Priority Levels — used for visual urgency indicators
// ============================================================
export const PRIORITY = {
  URGENT: 'urgent',      // Due within 48 hours
  UPCOMING: 'upcoming',  // Due within 7 days
  LATER: 'later'         // Due after 7 days
};

// ============================================================
// Color palette for course tags — each course gets a unique color
// ============================================================
export const COURSE_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#BB8FCE', '#85C1E9', '#F1948A', '#82E0AA'
];

// ============================================================
// Utility: Determine priority based on how soon the event is
// ============================================================
export function getPriority(dateString) {
  const now = new Date();
  const eventDate = new Date(dateString);
  const hoursUntil = (eventDate - now) / (1000 * 60 * 60);

  if (hoursUntil < 0) return 'past';
  if (hoursUntil <= 48) return PRIORITY.URGENT;
  if (hoursUntil <= 168) return PRIORITY.UPCOMING; // 7 days
  return PRIORITY.LATER;
}

// ============================================================
// Utility: Format date for display
// ============================================================
export function formatDate(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = date - now;
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMs < 0) {
    return { relative: 'Past', absolute: date.toLocaleDateString('en-MY', { day: 'numeric', month: 'short' }) };
  }
  if (diffHours < 1) {
    const mins = Math.floor(diffMs / (1000 * 60));
    return { relative: `${mins}m left`, absolute: date.toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' }) };
  }
  if (diffHours < 24) {
    return { relative: `${diffHours}h left`, absolute: `Today, ${date.toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })}` };
  }
  if (diffDays === 1) {
    return { relative: 'Tomorrow', absolute: `Tomorrow, ${date.toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })}` };
  }
  if (diffDays < 7) {
    return {
      relative: `${diffDays} days`,
      absolute: date.toLocaleDateString('en-MY', { weekday: 'short', day: 'numeric', month: 'short' }) +
        `, ${date.toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })}`
    };
  }
  return {
    relative: `${diffDays} days`,
    absolute: date.toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' }) +
      `, ${date.toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })}`
  };
}

// ============================================================
// Utility: Get icon for event type
// ============================================================
export function getEventIcon(type) {
  const icons = {
    [EVENT_TYPES.EXAM]: '📝',
    [EVENT_TYPES.QUIZ]: '❓',
    [EVENT_TYPES.ASSIGNMENT]: '📄',
    [EVENT_TYPES.LAB]: '🔬',
    [EVENT_TYPES.VIVA]: '🎤',
    [EVENT_TYPES.PRESENTATION]: '📊',
    [EVENT_TYPES.PROJECT]: '🏗️',
    [EVENT_TYPES.TUTORIAL]: '📚',
    [EVENT_TYPES.OTHER]: '📌'
  };
  return icons[type] || '📌';
}

// ============================================================
// Utility: Get human-readable label for event type
// ============================================================
export function getEventLabel(type) {
  const labels = {
    [EVENT_TYPES.EXAM]: 'Exam',
    [EVENT_TYPES.QUIZ]: 'Quiz',
    [EVENT_TYPES.ASSIGNMENT]: 'Assignment',
    [EVENT_TYPES.LAB]: 'Lab',
    [EVENT_TYPES.VIVA]: 'Viva',
    [EVENT_TYPES.PRESENTATION]: 'Presentation',
    [EVENT_TYPES.PROJECT]: 'Project',
    [EVENT_TYPES.TUTORIAL]: 'Tutorial',
    [EVENT_TYPES.OTHER]: 'Other'
  };
  return labels[type] || 'Other';
}