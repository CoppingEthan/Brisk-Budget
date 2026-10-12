import { html, on } from '../core/dom.js';

export const EMOJIS = [
  '🍽️', '🛒', '☕', '🍺', '🍕', '🏠', '🔑', '🛠️', '🛋️', '🌱', '📄', '💡', '💧', '🔥', '📱', '📺', '🚗', '⛽', '🚆', '🚌',
  '🅿️', '✈️', '🏖️', '🏨', '🛍️', '👕', '👟', '🎁', '💻', '🎬', '🎮', '🎵', '📚', '🎨', '⚽', '🏋️', '💊', '🩺', '🦷', '👓',
  '💇', '🛡️', '👶', '🧸', '🎓', '🏫', '🐾', '🐶', '🐱', '💰', '💵', '💳', '🏦', '📈', '🐷', '🧾', '🔄', '📦', '❤️', '🙏',
  '🎉', '🍼', '🧹', '🧺', '🔧', '⚡', '📮', '🏥', '🚲', '🧳', '🎟️', '📰', '☂️', '🌍', '💼', '🧑‍💻', '📁', '⭐', '🔔', '❓'
];

export const COLOURS = [
  '#fb923c', '#facc15', '#60a5fa', '#818cf8', '#f472b6', '#c084fc', '#f87171', '#2dd4bf',
  '#22d3ee', '#fb7185', '#f59e0b', '#34d399', '#4ade80', '#a78bfa', '#38bdf8', '#e879f9', '#94a3b8'
];

// What screen readers say for each swatch, instead of a hex code
const COLOUR_NAMES = {
  '#fb923c': 'Orange', '#facc15': 'Yellow', '#60a5fa': 'Blue', '#818cf8': 'Indigo', '#f472b6': 'Pink',
  '#c084fc': 'Purple', '#f87171': 'Red', '#2dd4bf': 'Teal', '#22d3ee': 'Cyan', '#fb7185': 'Rose',
  '#f59e0b': 'Amber', '#34d399': 'Emerald', '#4ade80': 'Green', '#a78bfa': 'Violet', '#38bdf8': 'Sky blue',
  '#e879f9': 'Magenta', '#94a3b8': 'Grey'
};

// An emoji grid bound to a hidden input called `name`; typing a custom emoji also works
export function emojiPicker(name, current = '📁') {
  return html`
    <div class="field">
      <span class="field-label">Emoji</span>
      <div class="input-group">
        <span class="input-prefix" data-emoji-preview style="font-size:1.25rem">${current}</span>
        <input class="input" name="${name}" value="${current}" maxlength="16" aria-label="Emoji" autocomplete="off">
      </div>
      <div class="emoji-grid" role="group" aria-label="Choose an emoji">
        ${EMOJIS.map(e => html`<button type="button" data-emoji="${e}" aria-pressed="${String(e === current)}">${e}</button>`)}
      </div>
    </div>
  `;
}

export function colourPicker(name, current) {
  const value = current || COLOURS[0];
  return html`
    <div class="field">
      <span class="field-label">Colour</span>
      <input type="hidden" name="${name}" value="${value}">
      <div class="swatches" role="group" aria-label="Colour">
        ${COLOURS.map(c => html`<button type="button" style="--cat:${c}" data-colour="${c}" aria-pressed="${String(c === value)}" aria-label="${COLOUR_NAMES[c] || c}" title="${COLOUR_NAMES[c] || c}"></button>`)}
      </div>
    </div>
  `;
}

export function bindPickers(root) {
  on(root, 'click', '[data-emoji]', (event, button) => {
    const input = root.querySelector('input[aria-label="Emoji"]');
    input.value = button.dataset.emoji;
    input.dispatchEvent(new Event('input'));
  });
  on(root, 'input', 'input[aria-label="Emoji"]', (event, input) => {
    const preview = root.querySelector('[data-emoji-preview]');
    if (preview) preview.textContent = input.value || '📁';
    for (const b of root.querySelectorAll('[data-emoji]')) b.setAttribute('aria-pressed', String(b.dataset.emoji === input.value));
  });
  on(root, 'click', '[data-colour]', (event, button) => {
    const input = button.closest('.field').querySelector('input[type="hidden"]');
    input.value = button.dataset.colour;
    for (const b of button.parentElement.children) b.setAttribute('aria-pressed', String(b === button));
  });
}
