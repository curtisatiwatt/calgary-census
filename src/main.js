import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import { loadData } from './data.js';
import {
  INCOME_BINS, isNumber, colorFor, money, number, percent, bubbleRadius,
  searchFeatures, summarize, escapeHtml as esc, safeUrl, hashCode,
} from './map-utils.js';

const $ = id => document.getElementById(id);
const mobile = () => window.matchMedia('(max-width: 760px)').matches;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sidebar = document.querySelector('.sidebar');
const layerPanel = document.querySelector('.layer-panel');
const dialog = $('method-dialog');

const state = {
  features: [], byCode: new Map(), layers: new Map(), metadata: {}, counts: {},
  shortlist: [], selected: null, mode: 'count', bubbles: true, labels: true,
  searchMatches: [], activeSearch: -1,
};
let map, boundaries, bubbleGroup, labelGroup, roadGroup;

function setCollapsed(collapsed) {
  sidebar.classList.toggle('collapsed', collapsed);
  $('mobile-detail-handle').setAttribute('aria-expanded', String(!collapsed));
  $('mobile-chevron').textContent = collapsed ? '⌃' : '⌄';
}

function closeLayers() {
  $('mobile-layers').hidden = true;
  $('mobile-layers-button').setAttribute('aria-expanded', 'false');
}

function syncLayout() {
  const parent = mobile() ? $('mobile-layers') : sidebar;
  if (layerPanel.parentElement !== parent) {
    if (mobile()) parent.append(layerPanel);
    else sidebar.insertBefore(layerPanel, $('detail-panel'));
  }
  if (!mobile()) closeLayers();
}

function renderMetadata() {
  const m = state.metadata;
  const c = state.counts;
  $('data-edition').textContent = `${m.populationYear} 普查 · ${m.incomeYear} 收入`;
  $('income-edition').textContent = `CAD · 税前 ${m.incomeYear}`;
  $('income-detail-label').textContent = `家庭税前年收入中位数 · ${m.incomeYear}`;
  $('city-income').textContent = `全市 ${money(m.cityIncomeMedian)}`;
  $('population-label').textContent = m.populationLabel || '人口';
  $('coverage-text').textContent = `${c.total} 个区域 · ${m.populationYear} 普查`;
  $('latest-census-note').textContent = m.latestCensusNote || '请以官方来源的资料发布日期为准。';
  $('income-bins-note').textContent = `收入区间：${INCOME_BINS.map(bin => bin.label).join('；')}。`;
  $('year-definition').textContent = `本图采用 ${m.populationYear} 年人口普查资料，收入参考期为 ${m.incomeYear} 年；不是今天的收入与人口。`;
  $('income-definition').textContent = m.incomeDefinition || '收入为私人住户税前总年收入中位数，单位为加元。';
  $('population-definition').textContent = m.populationDefinition || '';
  $('children-definition').textContent = m.childrenDefinition || '';
  $('household-size-definition').textContent = m.householdSizeDefinition || '';
  $('children').title = m.childrenDefinition || '';
  $('household').title = m.householdSizeDefinition || '';
  $('population').title = m.populationDefinition || '';
  $('chinese-definition').textContent = m.chineseDefinition || '使用普查中的 Chinese 人口类别，不等于中国国籍、中国出生或普通话使用者。';
  $('city-chinese-note').textContent = isNumber(m.cityChineseCount)
    ? `全市公布的华人人数为 ${number(m.cityChineseCount)}，占 ${percent(m.cityChinesePct)}。社区数值受统计取整影响，不宜直接相加替代全市值。`
    : '社区数值受统计取整影响，不宜直接相加推算全市人数。';
  $('coverage-definition').textContent = `覆盖 ${c.total} 个官方社区区域；${c.income} 个有可用收入数值，${c.chinese} 个有可用华人人口数值。`;
  $('missing-data-note').textContent = m.missingDataNote || '';
  $('rounding-note').textContent = m.roundingNote || '';
  $('boundary-note').textContent = m.boundaryNote || '边界与统计按官方社区标识对应，缺失值保留为空。';
  $('prepared-note').textContent = m.preparedDate ? `数据整理于 ${m.preparedDate}；此版本为资料快照。` : '';
  $('license-note').textContent = m.license || '';
  $('source-list').replaceChildren();
  for (const source of m.sources || []) {
    const url = safeUrl(source.url);
    if (!url) continue;
    const link = document.createElement('a');
    link.href = url;
    link.textContent = `${source.label} ↗`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    $('source-list').append(link);
  }
}

function renderBubbleLegend() {
  const maximum = state.mode === 'count' ? state.counts.maxCount : state.counts.maxPercent;
  if (!maximum) return;
  const values = state.mode === 'count'
    ? [Math.round(maximum / 8), Math.round(maximum / 2), maximum]
    : [maximum / 8, maximum / 2, maximum];
  $('bubble-legend').innerHTML = values.map(value => {
    const size = bubbleRadius(value, maximum, mobile()) * 2;
    const label = state.mode === 'count' ? number(Math.round(value)) : percent(value);
    return `<div class="bubble-example"><span class="bubble-symbol" style="width:${size}px;height:${size}px"></span><span>${label}</span></div>`;
  }).join('');
  $('bubble-description').textContent = state.mode === 'count'
    ? '圆面积代表人数；无圆点可能为 0 或缺数据。'
    : '圆面积代表占比；无圆点可能为 0 或缺数据。';
}

function baseStyle(feature) {
  const missing = !isNumber(feature.properties.income);
  return {
    color: missing ? '#aebbb4' : '#f5f6e8', weight: 0.8, opacity: 0.9,
    fillColor: colorFor(feature.properties.income), fillOpacity: missing ? 0.35 : 0.75,
    dashArray: missing ? '3 3' : null,
  };
}

function selectedStyle(feature) {
  return { ...baseStyle(feature), color: '#234d47', weight: 2.6, opacity: 1, fillOpacity: 0.82 };
}

function refreshOutlines() {
  for (const [code, layer] of state.layers) {
    layer.setStyle(code === state.selected ? selectedStyle(layer.feature) : baseStyle(layer.feature));
  }
  state.layers.get(state.selected)?.bringToFront();
}

function renderDetail(feature, preview = false) {
  if (!feature) return;
  const p = feature.properties;
  const m = state.metadata;
  $('community-name').textContent = p.name;
  $('mobile-selection-label').textContent = preview ? '悬停预览' : '社区详情';
  const tags = [p.sectorLabel, p.typeLabel].filter(Boolean);
  $('community-meta').innerHTML = tags.map(tag => `<span>${esc(tag)}</span>`).join('');
  $('selection-status').textContent = preview ? '悬停预览 · 点击固定'
    : state.shortlist.includes(p.code) ? '关注社区' : '已选社区';
  $('income-value').textContent = money(p.income);
  $('income-value').style.color = isNumber(p.income) ? '#294d4b' : '#83918b';
  $('collapsed-summary').textContent = `${m.incomeYear} 收入 ${money(p.income)} · 华人 ${number(p.chineseCount)}（${percent(p.chinesePct)}）`;
  const ratio = isNumber(m.cityIncomeMedian) && m.cityIncomeMedian > 0
    ? `全市的 ${(p.income / m.cityIncomeMedian).toFixed(2)} 倍 · ` : '';
  $('income-context').textContent = isNumber(p.income)
    ? `${ratio}收入第 ${p.incomeRank} / ${state.counts.income} 名`
    : '官方资料没有可用的同口径收入数值';
  $('chinese-count').textContent = number(p.chineseCount);
  $('chinese-percent').textContent = percent(p.chinesePct);
  $('chinese-basis').textContent = !isNumber(p.chineseCount)
    ? '华人人数暂无数据，不代表没有华人居民。'
    : `采用官方社区档案公布人数与占比；比例已取整。${p.chineseCount === 0 ? '公布的 0 值受统计取整影响。' : ''}`;
  $('children').textContent = percent(p.children);
  $('household').textContent = isNumber(p.householdSize) ? `${p.householdSize.toFixed(1)} 人` : '暂无数据';
  $('population').textContent = number(p.population);
  $('community-note').textContent = p.note || '请结合具体地址的学校、住房成本和通勤情况进行比较。';
  $('data-caveat').textContent = p.caveat || '';
  $('data-caveat').hidden = !p.caveat;
  const sourceUrl = safeUrl(p.sourceUrl);
  $('source-link').hidden = !sourceUrl;
  if (sourceUrl) $('source-link').href = sourceUrl;
  else $('source-link').removeAttribute('href');
  $('focus-community').dataset.code = p.code;
}

function tooltip(p) {
  return `<strong>${esc(p.name)}</strong>家庭收入 ${money(p.income)}<br>华人 ${number(p.chineseCount)} · ${percent(p.chinesePct)}<span class="tip-note">${esc(p.note)}</span>`;
}

function previewFeature(feature) {
  if (mobile()) return;
  const layer = state.layers.get(feature.properties.code);
  layer?.setStyle({ weight: 2.3, color: '#486b60', fillOpacity: 0.88 });
  layer?.bringToFront();
  renderDetail(feature, true);
}

function stopPreview() {
  if (mobile()) return;
  refreshOutlines();
  renderDetail(state.byCode.get(state.selected));
}

function bindFeature(feature, layer) {
  const code = feature.properties.code;
  state.layers.set(code, layer);
  layer.on('add', () => layer.getElement()?.setAttribute('data-community', code));
  layer.on('click', () => { selectCommunity(code, false); closeLayers(); });
  layer.on('mouseover', () => previewFeature(feature));
  layer.on('mouseout', stopPreview);
  layer.bindTooltip(tooltip(feature.properties), {
    className: 'community-tooltip', direction: 'top', sticky: true, offset: [0, -10], opacity: 0.98,
  });
  layer.on('tooltipopen', () => { if (mobile()) layer.closeTooltip(); });
}

function fitPadding(focus = false) {
  if (!mobile()) return focus
    ? { padding: [65, 80], maxZoom: 14 }
    : { paddingTopLeft: [28, 65], paddingBottomRight: [28, 100] };
  const panelHeight = sidebar.getBoundingClientRect().height;
  return {
    paddingTopLeft: [18, 100], paddingBottomRight: [18, Math.min(panelHeight + 40, map.getSize().y * 0.53)],
    ...(focus ? { maxZoom: 14 } : {}),
  };
}

function fitCity() {
  if (!boundaries) return;
  map.eachLayer(layer => layer.closeTooltip?.());
  map.fitBounds(boundaries.getBounds(), { ...fitPadding(), animate: !reducedMotion() });
}

function fitCommunity(code) {
  const layer = state.layers.get(code);
  if (layer) map.fitBounds(layer.getBounds(), { ...fitPadding(true), animate: !reducedMotion() });
}

function selectCommunity(code, zoom = true, expand = true) {
  const feature = state.byCode.get(code);
  if (!feature) return;
  state.selected = code;
  if (mobile() && expand) setCollapsed(false);
  renderDetail(feature);
  refreshOutlines();
  document.querySelectorAll('.shortcut').forEach(button => {
    const active = button.dataset.code === code;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (zoom) fitCommunity(code);
  const p = feature.properties;
  $('announcer').textContent = `已选择 ${p.name}。家庭收入 ${money(p.income)}，华人人数 ${number(p.chineseCount)}。`;
  try { history.replaceState(null, '', `#${encodeURIComponent(code)}`); } catch { /* embedded preview */ }
  updateLabels();
}

function updateBubbles() {
  if (!map) return;
  bubbleGroup.clearLayers();
  if (!state.bubbles) return;
  const key = state.mode === 'count' ? 'chineseCount' : 'chinesePct';
  const maximum = state.mode === 'count' ? state.counts.maxCount : state.counts.maxPercent;
  const sorted = [...state.features].filter(f => isNumber(f.properties[key]))
    .sort((a, b) => b.properties[key] - a.properties[key]);
  for (const feature of sorted) {
    const p = feature.properties;
    const radius = bubbleRadius(p[key], maximum, mobile());
    if (!radius) continue;
    const circle = L.circleMarker([p.centroid[1], p.centroid[0]], {
      radius, color: '#284d59', weight: 1.3, fillColor: '#2b5363',
      fillOpacity: 0.15, opacity: 0.8, pane: 'bubbles', bubblingMouseEvents: false,
    }).addTo(bubbleGroup);
    circle.getElement()?.setAttribute('data-population-code', p.code);
    circle.on('click', () => { selectCommunity(p.code, false); closeLayers(); });
    circle.on('mouseover', () => previewFeature(feature));
    circle.on('mouseout', stopPreview);
    circle.bindTooltip(tooltip(p), { className: 'community-tooltip', direction: 'top', offset: [0, -radius - 3] });
    circle.on('tooltipopen', () => { if (mobile()) circle.closeTooltip(); });
  }
}

function updateLabels() {
  if (!map) return;
  labelGroup.clearLayers();
  if (!state.labels) return;
  const bounds = map.getBounds();
  const priority = p => p.code === state.selected ? 0 : state.shortlist.includes(p.code) ? 1 : 2;
  const candidates = state.features.filter(f => {
    const p = f.properties;
    return bounds.contains([p.centroid[1], p.centroid[0]]) && (isNumber(p.population) || priority(p) < 2);
  }).sort((a, b) => priority(a.properties) - priority(b.properties)
    || (b.properties.population || 0) - (a.properties.population || 0));
  const occupied = [];
  for (const feature of candidates) {
    const p = feature.properties;
    const prominent = priority(p) < 2;
    if (map.getZoom() < 11 && !prominent && p.chineseCount < state.counts.maxCount * 0.6) continue;
    const point = map.latLngToContainerPoint([p.centroid[1], p.centroid[0]]);
    const width = Math.min(185, p.name.length * (prominent ? 6 : 5));
    const box = { x: point.x - width / 2, y: point.y + 8, w: width, h: prominent ? 19 : 15 };
    const overlaps = occupied.some(other => box.x < other.x + other.w + 6 && box.x + box.w + 6 > other.x
      && box.y < other.y + other.h + 4 && box.y + box.h + 4 > other.y);
    if (overlaps && p.code !== state.selected) continue;
    occupied.push(box);
    L.marker([p.centroid[1], p.centroid[0]], {
      icon: L.divIcon({ className: `community-label${prominent ? ' focus-label' : ''}`, html: esc(p.name), iconSize: [width, 20], iconAnchor: [width / 2, -8] }),
      interactive: false, keyboard: false, pane: 'labels',
    }).addTo(labelGroup);
  }
}

function renderBasemap(data) {
  if (!data?.features) {
    $('map-warning').textContent = '道路与河流参考图暂未载入，社区边界及统计仍可使用。';
    $('map-warning').hidden = false;
    return;
  }
  L.geoJSON(data, {
    filter: f => f.properties.kind === 'water', pane: 'water', interactive: false,
    style: { color: '#79aebb', weight: 0.7, fillColor: '#a7ccd3', fillOpacity: 0.9 },
  }).addTo(map);
  for (const style of [
    { color: '#667f70', weight: 2.5, opacity: 0.4 },
    { color: '#fffff4', weight: 1.2, opacity: 0.9 },
  ]) {
    L.geoJSON(data, { filter: f => f.properties.kind === 'road', pane: 'roads', interactive: false, style }).addTo(roadGroup);
  }
}

function selectMode(mode) {
  state.mode = mode;
  for (const candidate of ['count', 'percent']) {
    const active = candidate === mode;
    $(`${candidate}-mode`).classList.toggle('active', active);
    $(`${candidate}-mode`).setAttribute('aria-pressed', String(active));
  }
  renderBubbleLegend();
  updateBubbles();
}

function closeSearch() {
  $('search-results').hidden = true;
  $('search').setAttribute('aria-expanded', 'false');
  $('search').removeAttribute('aria-activedescendant');
  state.activeSearch = -1;
  state.searchMatches = [];
}

function renderSearch() {
  const query = $('search').value.trim();
  state.searchMatches = searchFeatures(state.features, query);
  state.activeSearch = -1;
  if (!query) return closeSearch();
  $('search-results').hidden = false;
  $('search').setAttribute('aria-expanded', 'true');
  $('search-results').innerHTML = state.searchMatches.length ? state.searchMatches.map((feature, i) => {
    const p = feature.properties;
    const label = [p.sectorLabel, p.typeLabel].filter(Boolean).join(' · ') || `社区代码 ${p.code}`;
    return `<button class="search-result" id="search-option-${i}" role="option" aria-selected="false" data-code="${esc(p.code)}"><span><strong>${esc(p.name)}</strong><small>${esc(label)}</small></span><span>${money(p.income)}</span></button>`;
  }).join('') : '<div class="no-results">没有找到这个社区。可输入英文名或社区代码。</div>';
}

function chooseSearchResult(code) {
  selectCommunity(code);
  $('search').value = '';
  closeSearch();
  $('search').blur();
}

function initializeControls() {
  syncLayout();
  if (mobile()) setCollapsed(true);
  for (const bin of INCOME_BINS) {
    const span = document.createElement('span');
    span.style.background = bin.color;
    span.title = bin.label;
    $('income-ramp').append(span);
  }
  $('count-mode').addEventListener('click', () => selectMode('count'));
  $('percent-mode').addEventListener('click', () => selectMode('percent'));
  $('bubbles-toggle').addEventListener('change', event => { state.bubbles = event.target.checked; updateBubbles(); });
  $('labels-toggle').addEventListener('change', event => { state.labels = event.target.checked; updateLabels(); });
  $('roads-toggle').addEventListener('change', event => {
    if (!map) return;
    if (event.target.checked) roadGroup.addTo(map); else roadGroup.remove();
  });
  $('fit-city').addEventListener('click', fitCity);
  $('zoom-in').addEventListener('click', () => map?.zoomIn(0.5));
  $('zoom-out').addEventListener('click', () => map?.zoomOut(0.5));
  $('focus-community').addEventListener('click', event => selectCommunity(event.currentTarget.dataset.code));
  $('mobile-layers-button').addEventListener('click', () => {
    const open = $('mobile-layers').hidden;
    $('mobile-layers').hidden = !open;
    $('mobile-layers-button').setAttribute('aria-expanded', String(open));
  });
  $('mobile-detail-handle').addEventListener('click', () => setCollapsed(!sidebar.classList.contains('collapsed')));
  $('method-button').addEventListener('click', () => dialog.showModal());
  $('close-method').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  $('search').addEventListener('input', renderSearch);
  $('search').addEventListener('focus', () => { if ($('search').value) renderSearch(); });
  $('search-results').addEventListener('click', event => {
    const button = event.target.closest('[data-code]');
    if (button) chooseSearchResult(button.dataset.code);
  });
  $('search').addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeSearch(); $('search').blur(); }
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && state.searchMatches.length) {
      event.preventDefault();
      const count = state.searchMatches.length;
      state.activeSearch = state.activeSearch < 0
        ? (event.key === 'ArrowDown' ? 0 : count - 1)
        : (state.activeSearch + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      document.querySelectorAll('.search-result').forEach((button, i) => {
        button.classList.toggle('active', i === state.activeSearch);
        button.setAttribute('aria-selected', String(i === state.activeSearch));
      });
      const option = $(`search-option-${state.activeSearch}`);
      $('search').setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    }
    if (event.key === 'Enter' && state.searchMatches.length) {
      event.preventDefault();
      chooseSearchResult(state.searchMatches[Math.max(0, state.activeSearch)].properties.code);
    }
  });
  document.addEventListener('click', event => { if (!event.target.closest('.search-wrap')) closeSearch(); });
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && !dialog.open) {
      event.preventDefault();
      $('search').focus();
    }
  });
  let resizeTimer;
  window.addEventListener('resize', () => {
    syncLayout();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      map?.invalidateSize(); updateLabels(); updateBubbles(); renderBubbleLegend();
    }, 150);
  });
}

async function init() {
  initializeControls();
  try {
    const data = await loadData();
    state.metadata = data.metadata;
    state.features = data.features;
    state.byCode = new Map(data.features.map(f => [f.properties.code, f]));
    state.counts = summarize(data.features);
    const requested = data.metadata.shortlist || ['ASP', 'WSP', 'SPH', 'EPK', 'RID', 'AUB'];
    state.shortlist = requested.map(value => state.byCode.get(String(value))
      || data.features.find(f => f.properties.name.toLowerCase() === String(value).toLowerCase()))
      .filter(Boolean).map(f => f.properties.code).slice(0, 6);
    renderMetadata();
    renderBubbleLegend();
    map = L.map('map', { zoomControl: false, zoomSnap: 0.25, zoomDelta: 0.5, minZoom: 8, maxZoom: 17, attributionControl: true });
    for (const [name, zIndex] of [['water', 410], ['roads', 420], ['bubbles', 450], ['labels', 470]]) {
      map.createPane(name);
      map.getPane(name).style.zIndex = zIndex;
      if (name !== 'bubbles') map.getPane(name).style.pointerEvents = 'none';
    }
    roadGroup = L.layerGroup().addTo(map);
    bubbleGroup = L.layerGroup().addTo(map);
    labelGroup = L.layerGroup().addTo(map);
    map.attributionControl.setPrefix(false);
    map.attributionControl.addAttribution('官方边界与数据：<a href="https://www.calgary.ca/communities/profiles.html" target="_blank" rel="noopener">City of Calgary</a>');
    boundaries = L.geoJSON({ type: 'FeatureCollection', features: data.features }, { style: baseStyle, onEachFeature: bindFeature }).addTo(map);
    renderBasemap(data.basemap);
    for (const code of state.shortlist) {
      const button = document.createElement('button');
      button.className = 'shortcut';
      button.dataset.code = code;
      button.textContent = state.byCode.get(code).properties.name;
      button.addEventListener('click', () => selectCommunity(code));
      $('shortcuts').append(button);
    }
    const linkedCode = hashCode(location.hash, state.features);
    const initialCode = linkedCode || state.shortlist[0] || data.features[0].properties.code;
    $('loading-overlay').hidden = true;
    fitCity();
    selectCommunity(initialCode, false, false);
    updateBubbles();
    updateLabels();
    map.on('zoomend moveend', updateLabels);
    if (linkedCode) fitCommunity(linkedCode);
    if (mobile()) $('map-hint').textContent = '点击社区查看详情';
  } catch (error) {
    $('loading-overlay').hidden = false;
    $('loading-overlay').innerHTML = `<strong>地图暂时无法载入</strong><span>${esc(error.message)}</span><button class="map-button" id="retry">重新载入</button>`;
    $('retry').addEventListener('click', () => location.reload());
    $('coverage-text').textContent = '数据载入失败';
  }
}

init();
