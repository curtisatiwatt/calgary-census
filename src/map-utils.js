import { t } from './i18n.js';

export const INCOME_BINS = [
  { max: 60000, color: '#3979b5', label: '低于 $60,000' },
  { max: 80000, color: '#82b8d6', label: '$60,000–79,999' },
  { max: 98000, color: '#d8e5cb', label: '$80,000–97,999' },
  { max: 125000, color: '#f1d66f', label: '$98,000–124,999' },
  { max: 150000, color: '#efaa5a', label: '$125,000–149,999' },
  { max: 200000, color: '#db714d', label: '$150,000–199,999' },
  { max: Infinity, color: '#b83f42', label: '$200,000 及以上' },
];

export const isNumber = value => typeof value === 'number' && Number.isFinite(value);
export const colorFor = value => (isNumber(value) ? INCOME_BINS.find(bin => value < bin.max).color : '#d6dcd9');
// Missing values are spelled out in the current language so they read correctly
// inside translated sentences ("No data", never a bare 0).
const noData = () => t('暂无数据');
export const number = value => (isNumber(value) ? value.toLocaleString('en-CA') : noData());
export const money = value => (isNumber(value) ? `$${number(value)}` : noData());
export const percent = value =>
  isNumber(value) ? `${(value * 100).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%` : noData();

/** Map background behind every community fill; the stylesheets use the same two colours (checked by a unit test). */
export const MAP_GROUND = Object.freeze({ light: '#edf1e9', dark: '#14272e' });
/** Community fills are translucent, so what is seen is the bin colour blended with the ground. */
export const FILL_OPACITY = Object.freeze({
  population: Object.freeze({ light: 0.64, dark: 0.92 }),
  income: Object.freeze({ light: 0.67, dark: 0.7 }),
});
/** Community names are drawn in whichever of these two inks contrasts more with the fill beneath. */
export const LABEL_INK = Object.freeze({ dark: '#171a1d', light: '#f5f7fa' });

const channels = color => [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
/** `color` painted at `opacity` over an opaque `ground`, as #rrggbb. */
export function blendColor(color, ground, opacity) {
  const under = channels(ground);
  return `#${channels(color)
    .map((value, index) =>
      Math.round(value * opacity + under[index] * (1 - opacity))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}
/** The colour a bin really has on the map; legends show this, not the raw bin colour. */
export function displayedFill(kind, color, dark = false) {
  const theme = dark ? 'dark' : 'light';
  return blendColor(color, MAP_GROUND[theme], FILL_OPACITY[kind][theme]);
}
export function relativeLuminance(color) {
  const [r, g, b] = channels(color).map(value => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio between two opaque colours. */
export function contrastRatio(first, second) {
  const [high, low] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}
/** 'dark' or 'light': the label ink that reads better on an opaque fill. */
export function labelInk(fill) {
  return contrastRatio(fill, LABEL_INK.dark) >= contrastRatio(fill, LABEL_INK.light) ? 'dark' : 'light';
}

export const ARROW_DIRECTIONS = Object.freeze({
  ArrowRight: [1, 0],
  ArrowLeft: [-1, 0],
  ArrowDown: [0, 1],
  ArrowUp: [0, -1],
});
/**
 * Arrow-key movement between features on a map: the index of the screen point
 * nearest to `from` in the arrow's direction, favouring points straight ahead;
 * -1 when nothing lies that way.
 */
export function nearestInDirection(from, points, [dx, dy]) {
  let best = -1;
  let bestScore = Infinity;
  points.forEach((point, index) => {
    const along = (point.x - from.x) * dx + (point.y - from.y) * dy;
    if (along <= 2) return;
    const score = along + Math.abs((point.x - from.x) * dy - (point.y - from.y) * dx) * 2;
    if (score < bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

export function normalize(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

/**
 * Where `query` sits inside `text`, as [start, end) offsets into `text`, or null when it is not there.
 * It compares the way search does: case, accents, spaces and punctuation are ignored, so
 * "mountp" is found in "Mount Pleasant" and the range covers "Mount P".
 */
export function matchRange(text, query) {
  const source = String(text ?? '');
  const q = normalize(query);
  if (!q) return null;
  let flat = '';
  const starts = [];
  const ends = [];
  let i = 0;
  for (const char of source) {
    for (const c of normalize(char)) {
      flat += c;
      starts.push(i);
      ends.push(i + char.length);
    }
    i += char.length;
  }
  const at = flat.indexOf(q);
  return at < 0 ? null : [starts[at], ends[at + q.length - 1]];
}

export function searchFeatures(features, query) {
  const q = normalize(query);
  if (!q) return [];
  return features
    .map(feature => {
      const p = feature.properties;
      const name = normalize(p.name);
      const aliases = (p.aliases || []).map(normalize);
      const score =
        name === q || normalize(p.code) === q
          ? 0
          : name.startsWith(q)
            ? 1
            : name.includes(q)
              ? 2
              : aliases.some(alias => alias.includes(q))
                ? 3
                : 99;
      return { feature, score };
    })
    .filter(item => item.score < 99)
    .sort((a, b) => a.score - b.score || a.feature.properties.name.localeCompare(b.feature.properties.name))
    .slice(0, 12)
    .map(item => item.feature);
}

export function summarize(features) {
  const incomes = features.filter(f => isNumber(f.properties.income));
  return {
    total: features.length,
    income: incomes.length,
  };
}

export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    char =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char],
  );
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Shareable view state in the URL hash, e.g.
 * `#ASP?view=compare&groups=chinese,south_asian&compare=south_asian&income=1&layers=transit&hide=roads`.
 * `layers` lists the optional layers switched on (transit, landmarks); `hide`
 * lists the default layers switched off (roads, labels). A bare `#ASP` (the
 * original deep-link format) still selects a community.
 */
export function parseHashState(hash, features, groupIds = []) {
  const raw = String(hash ?? '').replace(/^#/, '');
  const split = raw.indexOf('?');
  const codePart = split < 0 ? raw : raw.slice(0, split);
  const params = new URLSearchParams(split < 0 ? '' : raw.slice(split + 1));
  let code = null;
  try {
    const decoded = decodeURIComponent(codePart);
    code = decoded && features.some(f => String(f.properties.code) === decoded) ? decoded : null;
  } catch {
    code = null;
  }
  const valid = new Set(groupIds);
  const list = key =>
    (params.get(key) || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
  const groups = [...new Set(list('groups').filter(id => valid.has(id)))];
  const compare = groups.includes(params.get('compare')) ? params.get('compare') : null;
  const layers = new Set(list('layers'));
  const hidden = new Set(list('hide'));
  return {
    code,
    groups,
    compare,
    view: params.get('view') === 'compare' ? 'distribution' : 'composition',
    income: params.get('income') === '1',
    transit: layers.has('transit'),
    landmarks: layers.has('landmarks'),
    roads: !hidden.has('roads'),
    labels: !hidden.has('labels'),
  };
}

export function buildHashState({
  code = null,
  view = 'composition',
  groups = [],
  compare = null,
  income = false,
  transit = false,
  landmarks = false,
  roads = true,
  labels = true,
} = {}) {
  const params = [];
  if (view === 'distribution') params.push('view=compare');
  if (groups.length) params.push(`groups=${groups.map(encodeURIComponent).join(',')}`);
  if (view === 'distribution' && compare && compare !== groups[0])
    params.push(`compare=${encodeURIComponent(compare)}`);
  if (income) params.push('income=1');
  const layers = [transit && 'transit', landmarks && 'landmarks'].filter(Boolean);
  if (layers.length) params.push(`layers=${layers.join(',')}`);
  const hidden = [!roads && 'roads', !labels && 'labels'].filter(Boolean);
  if (hidden.length) params.push(`hide=${hidden.join(',')}`);
  const head = code ? encodeURIComponent(code) : '';
  return head || params.length ? `#${head}${params.length ? `?${params.join('&')}` : ''}` : '';
}

export function hashCode(hash, features) {
  return parseHashState(hash, features).code;
}
