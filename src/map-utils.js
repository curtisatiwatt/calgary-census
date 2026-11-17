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
export const colorFor = value => isNumber(value)
  ? INCOME_BINS.find(bin => value < bin.max).color
  : '#d6dcd9';
export const number = value => isNumber(value) ? value.toLocaleString('en-CA') : '暂无数据';
export const money = value => isNumber(value) ? `$${number(value)}` : '暂无数据';
export const percent = value => isNumber(value)
  ? `${(value * 100).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`
  : '暂无数据';

export function normalize(value) {
  return String(value ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

export function searchFeatures(features, query) {
  const q = normalize(query);
  if (!q) return [];
  return features.map(feature => {
    const p = feature.properties;
    const name = normalize(p.name);
    const aliases = (p.aliases || []).map(normalize);
    const score = name === q || normalize(p.code) === q ? 0
      : name.startsWith(q) ? 1
      : name.includes(q) ? 2
      : aliases.some(alias => alias.includes(q)) ? 3 : 99;
    return { feature, score };
  }).filter(item => item.score < 99)
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
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
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
 * `#ASP?view=compare&groups=chinese,south_asian&compare=south_asian&income=1&layers=transit`.
 * A bare `#ASP` (the original deep-link format) still selects a community.
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
  } catch { code = null; }
  const valid = new Set(groupIds);
  const list = key => (params.get(key) || '').split(',').map(value => value.trim()).filter(Boolean);
  const groups = [...new Set(list('groups').filter(id => valid.has(id)))];
  const compare = groups.includes(params.get('compare')) ? params.get('compare') : null;
  const layers = new Set(list('layers'));
  return {
    code, groups, compare,
    view: params.get('view') === 'compare' ? 'distribution' : 'composition',
    income: params.get('income') === '1',
    transit: layers.has('transit'),
    landmarks: layers.has('landmarks'),
  };
}

export function buildHashState({ code = null, view = 'composition', groups = [], compare = null, income = false, transit = false, landmarks = false } = {}) {
  const params = [];
  if (view === 'distribution') params.push('view=compare');
  if (groups.length) params.push(`groups=${groups.map(encodeURIComponent).join(',')}`);
  if (view === 'distribution' && compare && compare !== groups[0]) params.push(`compare=${encodeURIComponent(compare)}`);
  if (income) params.push('income=1');
  const layers = [transit && 'transit', landmarks && 'landmarks'].filter(Boolean);
  if (layers.length) params.push(`layers=${layers.join(',')}`);
  const head = code ? encodeURIComponent(code) : '';
  return head || params.length ? `#${head}${params.length ? `?${params.join('&')}` : ''}` : '';
}

export function hashCode(hash, features) {
  return parseHashState(hash, features).code;
}
