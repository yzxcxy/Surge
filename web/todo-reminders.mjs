const lunarFormatter = new Intl.DateTimeFormat('en-u-ca-chinese', {
  year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'Asia/Shanghai'
});

function lunarDateParts(date) {
  // Read the Chinese calendar at noon in China for the selected civil day.
  const noon = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 4));
  const parts = lunarFormatter.formatToParts(noon);
  return {
    month: parts.find(part => part.type === 'month')?.value,
    day: parts.find(part => part.type === 'day')?.value
  };
}

export function lunarDayLabel(date) {
  const day = Number(lunarDateParts(date).day);
  const numerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  if (day <= 10) return `初${numerals[day - 1]}`;
  if (day < 20) return `十${numerals[day - 11]}`;
  if (day === 20) return '二十';
  if (day < 30) return `廿${numerals[day - 21]}`;
  return '三十';
}

export function reminderOccurrences(when, rule = 'none', lunar = false, now = Date.now()) {
  if (!Number.isFinite(when) || when <= 0) return [];
  const anchor = new Date(when);
  const limit = { none: 1, daily: 90, weekly: 52, monthly: 24, yearly: 8 }[rule] || 1;
  const earliest = Math.max(now + 1000, when);
  const result = [];
  if (rule === 'none') return when >= earliest ? [when] : [];

  if (lunar && (rule === 'monthly' || rule === 'yearly')) {
    const target = lunarDateParts(anchor);
    const start = new Date(earliest);
    start.setHours(0, 0, 0, 0);
    for (let offset = 0; offset < 366 * 9 && result.length < limit; offset++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset, anchor.getHours(), anchor.getMinutes());
      const parts = lunarDateParts(date);
      if (parts.day === target.day && (rule === 'monthly' || parts.month === target.month) && date.getTime() >= earliest) result.push(date.getTime());
    }
    return result;
  }

  for (let index = 0; index < 4000 && result.length < limit; index++) {
    let date;
    if (rule === 'daily') date = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + index, anchor.getHours(), anchor.getMinutes());
    else if (rule === 'weekly') date = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + index * 7, anchor.getHours(), anchor.getMinutes());
    else if (rule === 'monthly') {
      date = new Date(anchor.getFullYear(), anchor.getMonth() + index, anchor.getDate(), anchor.getHours(), anchor.getMinutes());
      if (date.getDate() !== anchor.getDate()) continue;
    } else if (rule === 'yearly') {
      date = new Date(anchor.getFullYear() + index, anchor.getMonth(), anchor.getDate(), anchor.getHours(), anchor.getMinutes());
      if (date.getMonth() !== anchor.getMonth() || date.getDate() !== anchor.getDate()) continue;
    } else break;
    if (date.getTime() >= earliest) result.push(date.getTime());
  }
  return result;
}

export function reminderNotificationId(noteId, when) {
  let hash = 2166136261;
  for (const char of `${noteId}:${when}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash & 0x7fffffff) || 1;
}
