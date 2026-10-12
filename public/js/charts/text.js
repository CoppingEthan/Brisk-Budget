// Measuring chart labels in the page's own font, so they can be fitted instead of overflowing.
let context = null;

// Width in px of `text` (a rough estimate if canvas isn't available)
export function textWidth(text, { size, weight = 400, family = 'sans-serif' }) {
  context ??= document.createElement('canvas').getContext('2d');
  if (!context) return text.length * size * 0.6;
  context.font = `${weight} ${size}px ${family}`;
  return context.measureText(text).width;
}

// Shorten `text` with "…" so it fits `max` px
export function fitText(text, max, font) {
  if (textWidth(text, font) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(`${text.slice(0, mid).trimEnd()}…`, font) <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}
