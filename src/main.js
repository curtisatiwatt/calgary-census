import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import { loadData } from './data.js';
import { createMapTooltip } from './map-tooltip.js';
import { createContextLayers } from './context-layers.js';
import { INCOME_BINS, isNumber, colorFor, money, number, percent, searchFeatures, summarize, escapeHtml as esc, safeUrl, hashCode } from './map-utils.js';
import { POPULATION_BINS, populationShare, populationColor, donutSvg } from './population-utils.js';

const $ = id => document.getElementById(id);
const mobile = () => window.matchMedia('(max-width: 760px)').matches;
const sidebar = document.querySelector('.sidebar');
const dialog = $('method-dialog');
const PALETTE = ['#518a7b', '#c29b4d', '#7e85af', '#5c8eac', '#b67768', '#8d9963', '#947cac', '#bb8c67', '#688b92', '#a18696', '#7f8990', '#b7a268', '#c2c9bd'];
const state = {
  features: [], byCode: new Map(), metadata: {}, counts: {}, data: null, basemap: null,
  operatingTransit: null, greenTransit: null, geographicContext: null,
  roads: true, labels: true, transit: true, landmarks: true,
  groups: [], groupById: new Map(), selectedGroups: [], colors: {}, selected: null,
  mode: 'composition', income: true, contexts: [], comparisonContexts: [], composition: null,
  view: null, wholeCity: true, compareStart: 0, searchMatches: [], activeSearch: -1,
};
let syncing = false;
let syncFrame = null;
let lastMobile = mobile();
let lastComparisonPageSize = null;

function selectedGroups() { return state.groups.filter(g => state.selectedGroups.includes(g.id)); }
function populationRecord(code) { return state.data?.communities[code] || null; }
function activeContexts() { return state.mode === 'composition' ? [state.composition].filter(Boolean) : state.comparisonContexts; }
function closeTooltips(closePopups = true) { state.contexts.forEach(context => { context.tooltip.close(); if (closePopups) context.map.closePopup(); }); }
function setCollapsed(collapsed) {
  sidebar.classList.toggle('collapsed', collapsed);
  $('mobile-detail-handle').setAttribute('aria-expanded', String(!collapsed));
  $('mobile-chevron').textContent = collapsed ? '⌃' : '⌄';
}
function toggleGroups(open) {
  $('groups-panel').hidden = !open;
  $('groups-button').setAttribute('aria-expanded', String(open));
  if (open) { toggleLayers(false); $('group-search').focus(); }
}

function toggleLayers(open) {
  $('layers-panel').hidden = !open;
  $('layers-button').setAttribute('aria-expanded', String(open));
  if (open) { toggleGroups(false); closeTooltips(); }
}
function updateLayerVisibility() {
  closeTooltips();
  for (const context of state.contexts) {
    context.contextLayers?.setVisible({ roads: state.roads, transit: state.transit, landmarks: state.landmarks, communityLabels: state.labels });
    updateLabels(context);
  }
  $('transit-legend').hidden = !state.transit;
}

function renderMetadata() {
  const m = state.metadata;
  $('data-edition').textContent = `${m.populationYear} 普查 · ${m.incomeYear} 收入`;
  $('income-detail-label').textContent = `家庭税前年收入中位数 · ${m.incomeYear}`;
  $('city-income').textContent = `全市 ${money(m.cityIncomeMedian)}`;
  $('coverage-text').textContent = `${state.counts.total} 个区域 · ${m.populationYear} 普查`;
  $('year-definition').textContent = `人口资料来自 ${m.populationYear} 年人口普查，收入参考期为 ${m.incomeYear} 年，不是今天的收入与人口。`;
  $('income-definition').textContent = m.incomeDefinition || '';
  $('latest-census-note').textContent = m.latestCensusNote || '';
  if (m.populationGroupsDefinition) $('population-groups-definition').textContent = m.populationGroupsDefinition;
  $('coverage-definition').textContent = `覆盖 ${state.counts.total} 个官方区域，${Object.keys(state.data.communities).length} 个有可用人口分类，${state.counts.income} 个有收入数据；保留缺失区域的边界。`;
  $('boundary-note').textContent = m.boundaryNote || '';
  $('prepared-note').textContent = m.preparedDate ? `原始数据整理于 ${m.preparedDate}；本图为官方资料快照。` : '';
  $('license-note').textContent = m.license || '';
  $('source-list').replaceChildren();
  for (const source of m.sources || []) {
    const url = safeUrl(source.url);
    if (!url) continue;
    const link = document.createElement('a');
    Object.assign(link, { href: url, textContent: `${source.label} ↗`, target: '_blank', rel: 'noopener noreferrer' });
    $('source-list').append(link);
  }
  $('income-ramp').innerHTML = INCOME_BINS.map(bin => `<span style="background:${bin.color}" title="${esc(bin.label)}"></span>`).join('');
  $('population-ramp').innerHTML = POPULATION_BINS.map(bin => `<span style="background:${bin.color}" title="${esc(bin.label)}"></span>`).join('');
}

function renderGroupList() {
  const query = $('group-search').value.trim().toLowerCase();
  const groups = state.groups.filter(g => `${g.label} ${g.name}`.toLowerCase().includes(query));
  $('group-list').innerHTML = groups.length ? groups.map(g => `<label class="group-option" for="group-${g.id}"><input type="checkbox" id="group-${g.id}" data-group="${g.id}" ${state.selectedGroups.includes(g.id) ? 'checked' : ''}><span class="group-name">${esc(g.label)}<small>${esc(g.name)}</small></span><span class="group-city">${percent(populationShare(state.data.city, g.id))}</span></label>`).join('') : '<p class="no-results">没有找到这个类别。</p>';
  $('filter-count').textContent = `已选 ${state.selectedGroups.length} / ${state.groups.length}`;
}

function updateGroupSelection(ids, rerender = true) {
  state.selectedGroups = [...new Set(ids)].filter(id => state.groupById.has(id));
  state.compareStart = Math.min(state.compareStart, Math.max(0, state.selectedGroups.length - 1));
  $('group-count').textContent = state.selectedGroups.length;
  $('filter-count').textContent = `已选 ${state.selectedGroups.length} / ${state.groups.length}`;
  if (rerender) renderGroupList();
  renderDonutKey();
  renderDetail();
  updateDonuts();
  if (state.mode === 'distribution') rebuildComparison();
}

function renderDonutKey() {
  const groups = selectedGroups();
  $('donut-key').innerHTML = groups.map(g => `<span><i style="background:${state.colors[g.id]}"></i>${esc(g.label)}</span>`).join('') + (groups.length ? '<span><i style="background:#d5dbd5"></i>其余类别</span><span><i style="background:#fff;border:1px dotted #819080"></i>原表统计差额</span>' : '<span>未选择人口群体 · 可从上方添加</span>');
}

function renderDetail() {
  const feature = state.byCode.get(state.selected);
  if (!feature) return;
  const p = feature.properties;
  const record = populationRecord(p.code);
  $('community-name').textContent = p.name;
  $('community-meta').innerHTML = [p.sectorLabel, p.typeLabel].filter(Boolean).map(tag => `<span>${esc(tag)}</span>`).join('');
  $('population').textContent = number(record?.population ?? p.population);
  $('collapsed-summary').textContent = `人口 ${number(record?.population ?? p.population)} · 家庭收入 ${money(p.income)}`;
  $('income-value').textContent = money(p.income);
  $('income-value').classList.toggle('missing', !isNumber(p.income));
  $('income-context').textContent = isNumber(p.income)
    ? `全市的 ${(p.income / state.metadata.cityIncomeMedian).toFixed(2)} 倍 · 第 ${p.incomeRank} / ${state.counts.income}`
    : '官方资料暂无同口径收入数值';
  $('children').textContent = percent(p.children);
  $('household').textContent = isNumber(p.householdSize) ? `${p.householdSize.toFixed(1)} 人` : '暂无数据';
  $('community-note').textContent = p.note || '结合住房预算、具体地址对应的学校与通勤进行比较。';
  $('data-caveat').textContent = p.caveat || '';
  $('data-caveat').hidden = !p.caveat;
  const sourceUrl = safeUrl(record?.sourceUrl || p.sourceUrl);
  $('source-link').hidden = !sourceUrl;
  if (sourceUrl) $('source-link').href = sourceUrl;
  else $('source-link').removeAttribute('href');
  const groups = selectedGroups();
  if (!record) {
    $('composition-bars').innerHTML = '<p class="detail-empty">这个区域暂无可用的人口分类资料，不能当作 0 人。</p>';
    $('composition-basis').textContent = '';
    return;
  }
  if (!groups.length) {
    $('composition-bars').innerHTML = '<p class="detail-empty">从上方“人口群体”选择想了解的类别。</p>';
    $('composition-basis').textContent = '';
    return;
  }
  const rows = groups.map(g => ({ ...g, count: record.counts[g.id], share: populationShare(record, g.id), city: populationShare(state.data.city, g.id), color: state.colors[g.id] }));
  const remainder = state.groups.filter(g => !state.selectedGroups.includes(g.id));
  if (remainder.length) rows.push({
    id: 'other', label: '其余类别',
    count: remainder.reduce((sum, g) => sum + record.counts[g.id], 0),
    share: remainder.reduce((sum, g) => sum + record.counts[g.id], 0) / record.population,
    city: remainder.reduce((sum, g) => sum + state.data.city.counts[g.id], 0) / state.data.city.population,
    color: '#bcc7bd',
  });
  $('composition-bars').innerHTML = rows.map(row => `<div class="composition-row" data-detail-group="${row.id}"><div class="bar-heading"><span>${esc(row.label)}</span><span><small>${number(row.count)} 人</small><strong>${percent(row.share)}</strong></span></div><div class="bar-track"><span class="bar-fill" style="width:${Math.min(100, Math.max(0, (row.share || 0) * 100))}%;background:${row.color}"></span><i class="city-reference" style="left:${Math.min(100, Math.max(0, (row.city || 0) * 100))}%" title="全市 ${percent(row.city)}"></i></div><span class="sr-only">全市占比 ${percent(row.city)}</span></div>`).join('');
  const sum = Object.values(record.counts).reduce((a, b) => a + b, 0);
  const difference = Math.abs(sum - record.population);
  $('composition-basis').textContent = '占比按人数 ÷ 同表私人住户人口计算。灰色为未勾选类别，留白为原表统计差额。' + (difference > 35 || difference / record.population > 0.01 ? ` 分类合计 ${number(sum)}，表内人口 ${number(record.population)}；原表存在差异，保留原数值。` : '原始人数经过统计取整。');
}

function styleFor(context, feature) {
  const p = feature.properties;
  const value = context.groupId ? populationShare(populationRecord(p.code), context.groupId) : p.income;
  const missing = context.groupId ? value === null : state.income && !isNumber(value);
  const selected = p.code === state.selected;
  return {
    color: selected ? '#243f42' : missing ? '#a7b3ac' : '#fafbf5',
    weight: selected ? 2.5 : 0.75, opacity: 1,
    fillColor: context.groupId ? populationColor(value) : state.income ? colorFor(value) : '#e0e8dc',
    fillOpacity: missing ? 0.35 : context.groupId ? 0.86 : state.income ? 0.67 : 0.72,
    dashArray: missing ? '3 3' : null,
  };
}

function refreshStyles() {
  for (const context of state.contexts) {
    for (const layer of context.layers.values()) layer.setStyle(styleFor(context, layer.feature));
    context.layers.get(state.selected)?.bringToFront();
    updateLabels(context);
  }
}

function tooltipContent(feature, context) {
  const p = feature.properties;
  const record = populationRecord(p.code);
  const reference = p.note ? `<span class="tip-reference"><b>选区参考</b>${esc(p.note)}</span>` : '';
  if (context.groupId) {
    const group = state.groupById.get(context.groupId);
    return `<strong>${esc(p.name)}</strong>${esc(group.label)} ${percent(populationShare(record, group.id))}<br>${number(record?.counts[group.id])} 人 · 全市 ${percent(populationShare(state.data.city, group.id))}${reference}<span class="tip-note">点击固定社区，查看完整构成</span>`;
  }
  return `<strong>${esc(p.name)}</strong>家庭收入 ${money(p.income)}<br>人口 ${number(record?.population ?? p.population)}${record ? selectedGroups().slice(0, 5).map(g => `<br>${esc(g.label)} ${percent(populationShare(record, g.id))}`).join('') : '<br>人口分类暂无数据'}${reference}<span class="tip-note">点击查看社区详情</span>`;
}

function createMap(element, groupId = null) {
  const map = L.map(element, { zoomControl: false, zoomSnap: 0.25, zoomDelta: 0.5, minZoom: 8, maxZoom: 17, attributionControl: true });
  const context = { map, groupId, layers: new Map(), donuts: L.layerGroup(), labels: L.layerGroup(), donutCount: 0 };
  context.tooltip = createMapTooltip({ map, tooltip: L.tooltip({ className: 'community-tooltip', direction: 'top', opacity: 0.98 }), enabled: () => !mobile(), hoverEnabled: () => window.matchMedia('(any-hover: hover)').matches });
  for (const [name, zIndex] of [['water', 410], ['roads', 420], ['donuts', 450], ['labels', 470]]) {
    map.createPane(name);
    map.getPane(name).style.zIndex = zIndex;
    if (name !== 'donuts') map.getPane(name).style.pointerEvents = 'none';
  }
  context.donuts.addTo(map);
  context.labels.addTo(map);
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution('<a href="https://www.calgary.ca/communities/profiles.html" target="_blank" rel="noopener">City of Calgary</a> · 2021');
  context.boundaries = L.geoJSON({ type: 'FeatureCollection', features: state.features }, {
    style: feature => styleFor(context, feature),
    onEachFeature(feature, layer) {
      const code = feature.properties.code;
      context.layers.set(code, layer);
      layer.on('add', () => { const path = layer.getElement(); path?.setAttribute('data-community', code); path?.setAttribute('aria-label', feature.properties.name); });
      layer.on('click', () => { selectCommunity(code, false); toggleGroups(false); });
      context.tooltip.bind(layer, { content: () => tooltipContent(feature, context), anchor: event => event?.latlng || layer.getBounds().getCenter() });
    },
  }).addTo(map);
  context.contextLayers = createContextLayers({ context, basemap: state.basemap, geography: state.geographicContext, operatingTransit: state.operatingTransit, greenTransit: state.greenTransit, communityNames: state.features.map(f => f.properties.name), visible: { roads: state.roads, transit: state.transit, landmarks: state.landmarks, communityLabels: state.labels }, onStationOpen: () => { closeTooltips(); toggleGroups(false); toggleLayers(false); if (mobile()) setCollapsed(true); } });
  state.contexts.push(context);
  map.on('movestart zoomstart', () => {
    context.tooltip.close();
    if (!syncing) closeTooltips(false);
  });
  map.on('dragstart', () => { state.wholeCity = false; });
  map.on('zoomstart', () => { if (!syncing) state.wholeCity = false; });
  map.on('move', () => {
    if (syncing || !activeContexts().includes(context)) return;
    cancelAnimationFrame(syncFrame);
    syncFrame = requestAnimationFrame(() => syncMaps(context));
  });
  map.on('moveend', () => {
    if (syncing || !activeContexts().includes(context)) return;
    syncMaps(context);
    for (const c of activeContexts()) updateLabels(c);
    if (context === state.composition) updateDonuts();
  });
  return context;
}


function syncMaps(source) {
  if (!state.contexts.includes(source) || !activeContexts().includes(source) || !source.map._loaded || syncing) return;
  syncing = true;
  const center = source.map.getCenter();
  const zoom = source.map.getZoom();
  state.view = { center: [center.lat, center.lng], zoom };
  for (const context of activeContexts()) if (context !== source) context.map.setView(center, zoom, { animate: false });
  syncing = false;
}

function fitCity() {
  const contexts = activeContexts();
  if (!contexts.length) return;
  closeTooltips();
  syncing = true;
  const first = contexts[0];
  first.map.fitBounds(first.boundaries.getBounds(), { paddingTopLeft: [24, 65], paddingBottomRight: [24, mobile() ? 140 : 100], animate: false });
  syncing = false;
  syncMaps(first);
  state.wholeCity = true;
  contexts.forEach(updateLabels);
  updateDonuts();
}

function fitCommunity(code) {
  const contexts = activeContexts();
  const layer = contexts[0]?.layers.get(code);
  if (!layer) return;
  syncing = true;
  contexts[0].map.fitBounds(layer.getBounds(), { paddingTopLeft: [35, 60], paddingBottomRight: [35, mobile() ? Math.min(sidebar.getBoundingClientRect().height + 25, contexts[0].map.getSize().y * .55) : 100], maxZoom: 14, animate: false });
  syncing = false;
  state.wholeCity = false;
  syncMaps(contexts[0]);
  contexts.forEach(updateLabels);
  updateDonuts();
}

function selectCommunity(code, zoom = true, expand = true) {
  if (!state.byCode.has(code)) return;
  closeTooltips();
  state.selected = code;
  if (mobile() && expand) setCollapsed(false);
  renderDetail();
  refreshStyles();
  updateDonuts();
  renderComparisonHeadings();
  if (zoom) fitCommunity(code);
  $('announcer').textContent = `已选择 ${state.byCode.get(code).properties.name}。人口构成已更新。`;
  try { history.replaceState(null, '', `#${encodeURIComponent(code)}`); } catch { /* embedded preview */ }
}

function updateDonuts() {
  const context = state.composition;
  if (!context || state.mode !== 'composition' || !context.map._loaded) return;
  context.tooltip.close();
  context.donuts.clearLayers();
  const groups = selectedGroups();
  if (!groups.length) { $('donut-status').textContent = '未选人口群体，暂不显示构成圆'; return; }
  const map = context.map;
  const size = mobile() ? 28 : 32;
  const occupied = [];
  const candidates = state.features.filter(f => populationRecord(f.properties.code) && map.getBounds().contains([f.properties.centroid[1], f.properties.centroid[0]]))
    .sort((a, b) => (a.properties.code === state.selected ? -1 : b.properties.code === state.selected ? 1 : (populationRecord(b.properties.code)?.population || 0) - (populationRecord(a.properties.code)?.population || 0)));
  let shown = 0;
  for (const feature of candidates) {
    const p = feature.properties;
    const point = map.latLngToContainerPoint([p.centroid[1], p.centroid[0]]);
    if (point.x < size / 2 || point.y < size / 2 || point.x > map.getSize().x - size / 2 || point.y > map.getSize().y - size / 2) continue;
    if (occupied.some(other => point.distanceTo(other) < size + 10) && p.code !== state.selected) continue;
    const html = donutSvg(populationRecord(p.code), state.selectedGroups, state.colors, size);
    if (!html) continue;
    occupied.push(point);
    const marker = L.marker([p.centroid[1], p.centroid[0]], {
      icon: L.divIcon({ className: `population-donut${p.code === state.selected ? ' selected-donut' : ''}`, html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
      pane: 'donuts', keyboard: true, title: `${p.name} 人口构成`, alt: `${p.name} 人口构成`, riseOnHover: false,
    }).addTo(context.donuts);
    marker.getElement()?.setAttribute('data-population-code', p.code);
    marker.getElement()?.setAttribute('aria-label', `${p.name}，点击查看人口构成`);
    marker.on('click', () => { selectCommunity(p.code, false); toggleGroups(false); });
    context.tooltip.bind(marker, { content: () => tooltipContent(feature, context), anchor: () => marker.getLatLng(), offset: [0, -size / 2] });
    shown++;
  }
  context.donutCount = shown;
  $('donut-status').textContent = `当前显示 ${shown} 个构成圈 · 放大可查看更多`;
}

function updateLabels(context) {
  const map = context.map;
  if (!map._loaded) return;
  context.contextLayers?.update();
  context.labels.clearLayers();
  if (!state.labels) return;
  const zoom = map.getZoom();
  const fontSize = zoom < 10.25 ? 6.5 : zoom < 11 ? 7.1 : zoom < 12 ? 8 : zoom < 13 ? 9 : 10;
  const candidates = state.features.filter(f => {
    const p = f.properties;
    return map.getBounds().contains([p.centroid[1], p.centroid[0]]) && (!/^\d/.test(p.name) || p.code === state.selected);
  });
  for (const feature of candidates) {
    const p = feature.properties;
    const prominent = p.code === state.selected;
    const label = `${p.code === 'CIA' ? 'YYC · ' : ''}${p.name.toUpperCase()}`;
    const size = prominent ? Math.max(9, fontSize + 1) : fontSize;
    const width = Math.min(zoom < 11 ? 95 : 170, Math.max(44, label.length * size * .57));
    const offset = context.groupId ? -2 : 10;
    L.marker([p.centroid[1], p.centroid[0]], {
      icon: L.divIcon({ className: `community-label all-community-label${prominent ? ' focus-label' : ''}`, html: `<span style="font-size:${size}px">${esc(label)}</span>`, iconSize: [width, 28], iconAnchor: [width / 2, -offset] }),
      interactive: false, keyboard: false, pane: 'labels', zIndexOffset: prominent ? 1000 : 0,
    }).addTo(context.labels);
  }
}

function comparisonPageSize() {
  if (mobile()) return 1;
  const width = document.querySelector('.map-workspace').clientWidth;
  return width >= 780 ? 3 : width >= 500 ? 2 : 1;
}
function renderComparisonHeadings() {
  for (const context of state.comparisonContexts) {
    const group = state.groupById.get(context.groupId);
    const value = populationShare(populationRecord(state.selected), group.id);
    const name = state.byCode.get(state.selected)?.properties.name || '';
    const node = document.querySelector(`[data-map-heading="${group.id}"]`);
    if (node) node.innerHTML = `<div><h2>${esc(group.label)}</h2><span>全市 ${percent(populationShare(state.data.city, group.id))}</span></div><p title="${esc(name)}">${esc(name)} <strong>${percent(value)}</strong></p>`;
  }
}

function rebuildComparison() {
  cancelAnimationFrame(syncFrame); syncFrame = null;
  closeTooltips();
  for (const context of state.comparisonContexts) {
    context.tooltip.destroy(); context.map.remove();
    state.contexts = state.contexts.filter(c => c !== context);
  }
  state.comparisonContexts = [];
  const groups = selectedGroups();
  const size = comparisonPageSize();
  lastComparisonPageSize = size;
  state.compareStart = Math.floor(Math.min(state.compareStart, Math.max(0, groups.length - 1)) / size) * size;
  const shown = groups.slice(state.compareStart, state.compareStart + size);
  $('comparison-empty').hidden = groups.length !== 0;
  $('population-legend').hidden = groups.length === 0;
  $('comparison-select').innerHTML = groups.map((g, index) => `<option value="${index}" ${index === state.compareStart ? 'selected' : ''}>${esc(g.label)}</option>`).join('');
  $('comparison-select').disabled = !groups.length;
  $('comparison-page').textContent = groups.length ? `${state.compareStart + 1}–${state.compareStart + shown.length} / ${groups.length}` : '0 / 0';
  $('previous-groups').disabled = state.compareStart === 0;
  $('next-groups').disabled = state.compareStart + size >= groups.length;
  $('comparison-maps').style.setProperty('--map-columns', String(Math.max(1, shown.length)));
  $('comparison-maps').innerHTML = shown.map(g => `<section class="comparison-card"><header class="comparison-card-heading" data-map-heading="${g.id}"></header><div id="compare-${g.id}" class="comparison-map" role="region" aria-label="${esc(g.label)}在 Calgary 各社区的占比地图"></div></section>`).join('');
  if (!groups.length) return;
  syncing = true;
  state.comparisonContexts = shown.map(g => createMap(`compare-${g.id}`, g.id));
  for (const context of state.comparisonContexts) if (state.view) context.map.setView(state.view.center, state.view.zoom, { animate: false });
  syncing = false;
  renderComparisonHeadings();
  requestAnimationFrame(() => {
    for (const context of state.comparisonContexts) context.map.invalidateSize({ pan: false });
    if (state.wholeCity || !state.view) fitCity();
    else { refreshStyles(); state.comparisonContexts.forEach(updateLabels); }
  });
}

function selectView(mode) {
  if (state.mode === mode) return;
  cancelAnimationFrame(syncFrame); syncFrame = null;
  const current = activeContexts()[0];
  if (current?.map._loaded) syncMaps(current);
  closeTooltips();
  state.mode = mode;
  for (const candidate of ['composition', 'distribution']) {
    const active = candidate === mode;
    $(`${candidate}-tab`).classList.toggle('active', active);
    $(`${candidate}-tab`).setAttribute('aria-selected', String(active));
    $(`${candidate}-tab`).tabIndex = active ? 0 : -1;
    $(`${candidate}-view`).hidden = !active;
  }
  $('income-control').hidden = mode !== 'composition';
  $('mode-description').textContent = mode === 'composition' ? '一个社区，一张构成图' : '同一色阶，查看聚居分布';
  document.querySelector('.map-workspace').classList.toggle('comparing', mode === 'distribution');
  if (mode === 'distribution') rebuildComparison();
  else requestAnimationFrame(() => {
    syncing = true;
    state.composition.map.invalidateSize({ pan: false });
    if (state.view) state.composition.map.setView(state.view.center, state.view.zoom, { animate: false });
    syncing = false;
    if (state.wholeCity) fitCity();
    else { updateLabels(state.composition); updateDonuts(); }
  });
}

function closeSearch() {
  $('search-results').hidden = true;
  $('search').setAttribute('aria-expanded', 'false');
  $('search').removeAttribute('aria-activedescendant');
  state.activeSearch = -1; state.searchMatches = [];
}
function renderSearch() {
  const query = $('search').value.trim();
  state.searchMatches = searchFeatures(state.features, query); state.activeSearch = -1;
  if (!query) return closeSearch();
  $('search-results').hidden = false; $('search').setAttribute('aria-expanded', 'true');
  $('search-results').innerHTML = state.searchMatches.length ? state.searchMatches.map((feature, i) => {
    const p = feature.properties;
    return `<button class="search-result" id="search-option-${i}" role="option" aria-selected="false" data-code="${esc(p.code)}"><span><strong>${esc(p.name)}</strong><small>${esc([p.sectorLabel, p.typeLabel].filter(Boolean).join(' · '))}</small></span><span>${money(p.income)}</span></button>`;
  }).join('') : '<p class="no-results">没有找到社区，可输入英文名或社区代码。</p>';
}
function chooseSearchResult(code) {
  selectCommunity(code); $('search').value = ''; closeSearch(); $('search').blur(); toggleGroups(false);
}

function setReady(ready) {
  document.querySelectorAll('.view-tabs button,#groups-button,#group-search,#default-groups,#all-groups,#clear-groups,#income-toggle,#layers-button,#roads-toggle,#labels-toggle,#transit-toggle,#landmarks-toggle,#search,#fit-city,#zoom-in,#zoom-out,#focus-community').forEach(control => { control.disabled = !ready; });
}

function initializeControls() {
  setReady(false);
  if (mobile()) setCollapsed(true);
  for (const mode of ['composition', 'distribution']) $(`${mode}-tab`).addEventListener('click', () => selectView(mode));
  document.querySelector('.view-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const mode = event.key === 'Home' ? 'composition' : event.key === 'End' ? 'distribution' : state.mode === 'composition' ? 'distribution' : 'composition';
    selectView(mode); $(`${mode}-tab`).focus();
  });
  $('layers-button').addEventListener('click', () => toggleLayers($('layers-panel').hidden));
  $('close-layers').addEventListener('click', () => { toggleLayers(false); $('layers-button').focus(); });
  for (const layer of ['roads', 'labels', 'transit', 'landmarks']) $(`${layer}-toggle`).addEventListener('change', event => { state[layer] = event.target.checked; updateLayerVisibility(); });
  $('groups-button').addEventListener('click', () => toggleGroups($('groups-panel').hidden));
  $('close-groups').addEventListener('click', () => { toggleGroups(false); $('groups-button').focus(); });
  $('empty-choose-groups').addEventListener('click', () => toggleGroups(true));
  $('group-search').addEventListener('input', renderGroupList);
  $('group-list').addEventListener('change', event => {
    const id = event.target.dataset.group;
    if (!id) return;
    updateGroupSelection(event.target.checked ? [...state.selectedGroups, id] : state.selectedGroups.filter(value => value !== id), false);
  });
  $('default-groups').addEventListener('click', () => updateGroupSelection(state.data.defaultGroupIds));
  $('all-groups').addEventListener('click', () => updateGroupSelection(state.groups.map(g => g.id)));
  $('clear-groups').addEventListener('click', () => updateGroupSelection([]));
  $('income-toggle').addEventListener('change', event => { state.income = event.target.checked; $('income-legend').hidden = !state.income; refreshStyles(); });
  $('previous-groups').addEventListener('click', () => { state.compareStart -= comparisonPageSize(); rebuildComparison(); });
  $('next-groups').addEventListener('click', () => { state.compareStart += comparisonPageSize(); rebuildComparison(); });
  $('comparison-select').addEventListener('change', event => { state.compareStart = Number(event.target.value); rebuildComparison(); });
  $('fit-city').addEventListener('click', fitCity);
  $('zoom-in').addEventListener('click', () => activeContexts()[0]?.map.zoomIn(0.5));
  $('zoom-out').addEventListener('click', () => activeContexts()[0]?.map.zoomOut(0.5));
  $('focus-community').addEventListener('click', () => fitCommunity(state.selected));
  $('mobile-detail-handle').addEventListener('click', () => setCollapsed(!sidebar.classList.contains('collapsed')));
  $('method-button').addEventListener('click', () => { toggleGroups(false); toggleLayers(false); closeTooltips(); dialog.showModal(); });
  $('close-method').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  $('search').addEventListener('input', renderSearch);
  $('search').addEventListener('focus', () => { if ($('search').value) renderSearch(); });
  $('search-results').addEventListener('click', event => { const button = event.target.closest('[data-code]'); if (button) chooseSearchResult(button.dataset.code); });
  $('search').addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeSearch(); $('search').blur(); }
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && state.searchMatches.length) {
      event.preventDefault(); const count = state.searchMatches.length;
      state.activeSearch = state.activeSearch < 0 ? (event.key === 'ArrowDown' ? 0 : count - 1) : (state.activeSearch + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      document.querySelectorAll('.search-result').forEach((button, i) => { button.classList.toggle('active', i === state.activeSearch); button.setAttribute('aria-selected', String(i === state.activeSearch)); });
      const option = $(`search-option-${state.activeSearch}`); $('search').setAttribute('aria-activedescendant', option.id); option.scrollIntoView({ block: 'nearest' });
    }
    if (event.key === 'Enter' && state.searchMatches.length) { event.preventDefault(); chooseSearchResult(state.searchMatches[Math.max(0, state.activeSearch)].properties.code); }
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('.search-wrap')) closeSearch();
    if (!event.target.closest('#layers-panel') && !event.target.closest('#layers-button')) toggleLayers(false);
    if (!event.target.closest('#groups-panel') && !event.target.closest('#groups-button') && !event.target.closest('#empty-choose-groups')) toggleGroups(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeTooltips(); if (!$('layers-panel').hidden) { toggleLayers(false); $('layers-button').focus(); } if (!$('groups-panel').hidden) { toggleGroups(false); $('groups-button').focus(); } }
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !dialog.open) { event.preventDefault(); $('search').focus(); }
  });
  window.addEventListener('hashchange', () => { const code = hashCode(location.hash, state.features); if (code && code !== state.selected) selectCommunity(code); });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const changed = lastMobile !== mobile(); lastMobile = mobile();
      if (changed && mobile()) setCollapsed(true);
      if (state.mode === 'distribution' && (changed || lastComparisonPageSize !== comparisonPageSize())) rebuildComparison();
      else {
        syncing = true;
        for (const context of activeContexts()) context.map.invalidateSize({ pan: false });
        syncing = false;
        if (state.wholeCity) fitCity(); else { activeContexts().forEach(updateLabels); updateDonuts(); }
      }
    }, 150);
  });
}

async function init() {
  initializeControls();
  try {
    const data = await loadData();
    state.metadata = data.metadata; state.features = data.features; state.data = data.populationData; state.basemap = data.basemap;
    state.operatingTransit = data.operatingTransit; state.greenTransit = data.greenTransit; state.geographicContext = data.geographicContext;
    state.byCode = new Map(data.features.map(f => [f.properties.code, f])); state.counts = summarize(data.features);
    state.groups = data.populationData.groups; state.groupById = new Map(state.groups.map(g => [g.id, g]));
    state.colors = Object.fromEntries(state.groups.map((g, i) => [g.id, PALETTE[i % PALETTE.length]]));
    state.selectedGroups = data.populationData.defaultGroupIds.filter(id => state.groupById.has(id));
    const linkedCode = hashCode(location.hash, state.features);
    state.selected = linkedCode || (state.byCode.has('PAN') ? 'PAN' : data.features[0].properties.code);
    renderMetadata(); renderGroupList(); renderDonutKey(); renderDetail();
    $('group-count').textContent = state.selectedGroups.length;
    state.composition = createMap('composition-map');
    const unavailable = [[data.basemap, '道路与河流'], [data.operatingTransit, '运营 CTrain'], [data.greenTransit, 'Green Line'], [data.geographicContext, '铁路与地理地标']].filter(([loaded]) => !loaded).map(([, label]) => label);
    if (unavailable.length) { $('map-warning').textContent = `${unavailable.join('、')}暂未载入，社区统计仍可使用。`; $('map-warning').hidden = false; }
    $('loading-overlay').hidden = true;
    fitCity(); selectCommunity(state.selected, false, false);
    if (linkedCode) fitCommunity(linkedCode);
    setReady(true);
  } catch (error) {
    $('loading-overlay').hidden = false;
    $('loading-overlay').innerHTML = `<strong>地图暂时无法载入</strong><span>${esc(error.message)}</span><button class="map-button" id="retry">重新载入</button>`;
    $('retry').addEventListener('click', () => location.reload());
    $('coverage-text').textContent = '数据载入失败';
  }
}

init();
