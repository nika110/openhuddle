// Landing and join pages: copy buttons and the one-time lobby reveal.

for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', () => copyFrom(btn));
}

async function copyFrom(btn) {
  const target = document.getElementById(btn.dataset.copy);
  if (!target) return;
  const text = target.textContent.trim();
  try {
    await navigator.clipboard.writeText(text);
    flash(btn, 'Copied');
  } catch {
    const range = document.createRange();
    range.selectNodeContents(target);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    flash(btn, 'Press Ctrl+C');
  }
}

function flash(btn, label) {
  const original = btn.dataset.label || btn.textContent;
  btn.dataset.label = original;
  btn.textContent = label;
  btn.classList.add('done');
  clearTimeout(btn._timer);
  btn._timer = setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove('done');
  }, 1600);
}

const feed = document.querySelector('[data-reveal]');
const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (feed && !calm) {
  const items = [...feed.children];
  feed.classList.add('revealing');
  items.forEach((li, i) => {
    setTimeout(() => {
      li.classList.add('shown');
      const player = li.dataset.player;
      const doing = li.dataset.doing;
      if (player && doing) {
        const row = document.querySelector(`.players [data-player="${player}"] .doing`);
        if (row) {
          row.textContent = doing;
          row.classList.add('changed');
        }
      }
    }, 700 + i * 1200);
  });
}
