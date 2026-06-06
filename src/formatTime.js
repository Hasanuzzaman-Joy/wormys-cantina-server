/** US 12-hour display, e.g. "2:00 PM". Pass-through if unrecognized. */
function formatTimeUS(raw) {
  if (!raw || !String(raw).trim()) return raw;

  const s = String(raw).trim();

  const ampm = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm|a\.m\.|p\.m\.)$/i);
  if (ampm) {
    const h = parseInt(ampm[1], 10);
    const period = ampm[3].replace(/\./g, "").toUpperCase().startsWith("A") ? "AM" : "PM";
    return `${h}:${ampm[2]} ${period}`;
  }

  const h24 = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (h24) {
    let h = parseInt(h24[1], 10);
    const m = h24[2];
    const period = h >= 12 ? "PM" : "AM";
    if (h === 0) h = 12;
    else if (h > 12) h -= 12;
    return `${h}:${m} ${period}`;
  }

  return s;
}

module.exports = { formatTimeUS };
