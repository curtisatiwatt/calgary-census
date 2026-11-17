import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
// Order matters: shared base, then the two mutually exclusive layout shells, then
// everything drawn on or over the map (see the header of each file).
import './styles/base.css';
import './styles/mobile.css';
import './styles/desktop.css';
import './styles/map.css';
import { initDesktopUI } from './desktop-ui.js';
import { initMobileUI, getMobileMapInsets } from './mobile-ui.js';
import { initCommunitySheet } from './community-sheet.js';
import { loadCoreData, loadLayerData } from './data.js';
import { t, currentLanguage, initLanguagePreference, applyStaticTranslations, localizeHtml } from './i18n.js';
import { initTheme, refreshThemeControl, isDarkTheme } from './theme.js';
import { createMapTooltip } from './map-tooltip.js';
import { createCommunityHighlight } from './community-highlight.js';
import { createContextLayers } from './context-layers.js';
import {
  INCOME_BINS,
  isNumber,
  colorFor,
  money,
  number,
  percent,
  searchFeatures,
  summarize,
  escapeHtml as esc,
  safeUrl,
  parseHashState,
  buildHashState,
} from './map-utils.js';
import {
  POPULATION_BINS,
  COMPOSITION_OTHER_COLOR,
  POPULATION_GROUP_COLORS,
  populationShare,
  populationColor,
  donutSvg,
} from './population-utils.js';

const $ = id => document.getElementById(id);
const mobile = () => window.matchMedia('(max-width: 760px)').matches;
const sidebar = document.querySelector('.sidebar');
const dialog = $('method-dialog');
const state = {
  features: [],
  byCode: new Map(),
  metadata: {},
  counts: {},
  data: null,
  basemap: null,
  roads: true,
  labels: true,
  transit: false,
  landmarks: false,
  groups: [],
  groupById: new Map(),
  selectedGroups: [],
  colors: {},
  selected: null,
  selectionActive: false,
  mode: 'composition',
  income: false,
  contexts: [],
  comparisonContexts: [],
  composition: null,
  view: null,
  wholeCity: true,
  compareStart: 0,
  searchMatches: [],
  activeSearch: -1,
};
let syncing = false;
let syncFrame = null;
let lastMobile = mobile();
let mobileUI;
let communitySheet;
let desktopUI;
let observedTextSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
const labelMeasure = document.createElement('canvas').getContext('2d');

function localize(...roots) {
  roots.filter(Boolean).forEach(root => applyStaticTranslations(root));
}

/**
 * The community drawn as selected. Until the user picks one, state.selected only
 * seeds the (hidden) detail panel and the keyboard tab stop, so nothing is highlighted.
 */
function activeCode() {
  return state.selectionActive ? state.selected : null;
}
function selectedGroups() {
  return state.groups.filter(g => state.selectedGroups.includes(g.id));
}
function populationRecord(code) {
  return state.data?.communities[code] || null;
}
function activeContexts() {
  return state.mode === 'composition' ? [state.composition].filter(Boolean) : state.comparisonContexts;
}
function closeTooltips(closePopups = true) {
  state.contexts.forEach(context => {
    context.tooltip.close();
    context.highlights?.clearHover();
    if (closePopups) context.map.closePopup();
  });
}
function setCollapsed(collapsed) {
  if (mobile() && communitySheet && communitySheet.getState() !== 'closed')
    communitySheet.setSnap(collapsed ? 'peek' : 'half');
  mobileUI?.refresh();
}
function toggleGroups(open) {
  $('groups-panel').hidden = !open;
  $('groups-button').setAttribute('aria-expanded', String(open));
  if (open) {
    toggleLayers(false);
    if (!mobile()) $('group-search').focus();
  }
  mobileUI?.refresh();
}

function toggleLayers(open) {
  $('layers-panel').hidden = !open;
  $('layers-button').setAttribute('aria-expanded', String(open));
  if (open) {
    toggleGroups(false);
    closeTooltips();
  }
  mobileUI?.refresh();
}

function resizeMapsKeepingView() {
  const contexts = activeContexts();
  const current = contexts[0];
  if (!current?.map._loaded) return;
  const center = current.map.getCenter();
  const zoom = current.map.getZoom();
  cancelAnimationFrame(syncFrame);
  syncFrame = null;
  syncing = true;
  for (const context of contexts) {
    context.map.invalidateSize({ pan: false });
    // Leaflet's size change can shift the geographic centre even with pan disabled.
    context.map.setView(center, zoom, { animate: false });
  }
  syncing = false;
  syncMaps(current);
  renderOverlays(contexts);
}

function updateLayerVisibility() {
  closeTooltips();
  for (const context of state.contexts) {
    context.contextLayers?.setVisible({
      roads: state.roads,
      transit: state.transit,
      landmarks: state.landmarks,
      communityLabels: state.labels,
    });
    updateLabels(context);
  }
  $('transit-legend').hidden = state.mode !== 'composition' || !state.transit;
  mobileUI?.refresh();
}

function renderMetadata() {
  const m = state.metadata;
  $('data-edition').textContent = t('meta.edition', { population: m.populationYear, income: m.incomeYear });
  $('income-detail-label').textContent = t('meta.incomeLabel', { year: m.incomeYear });
  $('city-income').textContent = t('city.value', { value: money(m.cityIncomeMedian) });
  $('coverage-text').textContent = t('meta.coverageShort', { areas: state.counts.total, year: m.populationYear });
  $('year-definition').textContent = t('meta.years', { population: m.populationYear, income: m.incomeYear });
  $('income-definition').textContent = m.incomeDefinition || '';
  $('population-definition').textContent = m.populationDefinition || '';
  $('children-definition').textContent = m.childrenDefinition || '';
  $('household-definition').textContent = m.householdSizeDefinition || '';
  $('latest-census-note').textContent = m.latestCensusNote || '';
  if (m.populationGroupsDefinition) $('population-groups-definition').textContent = m.populationGroupsDefinition;
  $('coverage-definition').textContent = t('meta.coverage', {
    areas: state.counts.total,
    groups: Object.keys(state.data.communities).length,
    income: state.counts.income,
  });
  $('boundary-note').textContent = m.boundaryNote || '';
  $('prepared-note').textContent = m.preparedDate ? t('meta.prepared', { date: m.preparedDate }) : '';
  $('license-note').textContent = m.license || '';
  $('source-list').replaceChildren();
  for (const source of m.sources || []) {
    const url = safeUrl(source.url);
    if (!url) continue;
    const link = document.createElement('a');
    Object.assign(link, {
      href: url,
      textContent: `${t(source.label)} ↗`,
      target: '_blank',
      rel: 'noopener noreferrer',
    });
    $('source-list').append(link);
  }
  $('income-ramp').innerHTML = INCOME_BINS.map(
    bin => `<span style="background:${bin.color}" title="${esc(bin.label)}"></span>`,
  ).join('');
  const binColors = bin => `--bin-light:${bin.color};--bin-dark:${bin.dark}`;
  $('population-ramp').innerHTML = POPULATION_BINS.map(
    bin => `<span style="${binColors(bin)}" title="${esc(bin.label)}"></span>`,
  ).join('');
  document.querySelectorAll('.population-bin-labels>span').forEach((node, index) => {
    if (POPULATION_BINS[index]) node.style.cssText += binColors(POPULATION_BINS[index]);
  });
  localize(
    document.querySelector('.app-header'),
    dialog,
    $('income-legend'),
    $('population-legend'),
    document.querySelector('.map-status'),
  );
}

function refreshGroupControl() {
  const groups = selectedGroups();
  const english = currentLanguage() === 'en';
  const selection = groups.length === 1 ? t(groups[0].label) : english ? `${groups.length}` : `${groups.length} 类`;
  const label = $('group-selection-label');
  if (label)
    label.textContent = groups.length
      ? `${english ? 'Groups: ' : '人群：'}${selection}`
      : english
        ? 'Choose groups'
        : '选择人群';
  $('groups-button').setAttribute(
    'aria-label',
    `${english ? 'Choose population groups' : '选择人口群体'}${groups.length ? ` · ${selection}` : ''}`,
  );
}

function renderGroupList() {
  const query = $('group-search').value.trim().toLowerCase();
  const groups = state.groups.filter(g => `${g.label} ${g.name}`.toLowerCase().includes(query));
  $('group-list').innerHTML = groups.length
    ? groups
        .map(
          g =>
            `<label class="group-option" for="group-${g.id}"><input type="checkbox" id="group-${g.id}" data-group="${g.id}" ${state.selectedGroups.includes(g.id) ? 'checked' : ''}><span class="group-name">${esc(g.label)}<small>${esc(currentLanguage() === 'zh' ? g.name : '')}</small></span><span class="group-city">${percent(populationShare(state.data.city, g.id))}</span></label>`,
        )
        .join('')
    : '<p class="no-results">没有找到这个类别。</p>';
  $('filter-count').textContent = t('groups.selectedCount', {
    selected: state.selectedGroups.length,
    total: state.groups.length,
  });
  localize($('group-list'));
  refreshGroupControl();
}

function updateGroupSelection(ids, rerender = true) {
  state.selectedGroups = [...new Set(ids)].filter(id => state.groupById.has(id));
  state.compareStart = Math.min(state.compareStart, Math.max(0, state.selectedGroups.length - 1));
  $('group-count').textContent = state.selectedGroups.length;
  mobileUI?.refresh();
  $('filter-count').textContent = t('groups.selectedCount', {
    selected: state.selectedGroups.length,
    total: state.groups.length,
  });
  if (rerender) renderGroupList();
  refreshGroupControl();
  renderDonutKey();
  renderDetail();
  renderOverlays();
  if (state.mode === 'distribution') rebuildComparison();
  writeUrlState();
}

function renderDonutKey() {
  const groups = selectedGroups();
  $('composition-key').hidden = !groups.length;
  $('donut-key').innerHTML =
    groups.map(g => `<span><i style="background:${state.colors[g.id]}"></i>${esc(g.label)}</span>`).join('') +
    (groups.length
      ? `<span><i style="background:${COMPOSITION_OTHER_COLOR}"></i>其余类别</span><span><i class="gap-swatch"></i>原表统计差额</span>`
      : '<span>未选择人口群体 · 点击“人群”添加</span>');
  localize($('donut-key'));
}

function renderDetail() {
  const feature = state.byCode.get(state.selected);
  if (!feature) return;
  const p = feature.properties;
  const record = populationRecord(p.code);
  $('community-name').textContent = p.name;
  $('community-meta').innerHTML = [p.sectorLabel, p.typeLabel]
    .filter(Boolean)
    .map(tag => `<span>${esc(tag)}</span>`)
    .join('');
  $('population').textContent = number(record?.population ?? p.population);
  $('collapsed-summary').textContent = t('detail.summary', {
    population: number(record?.population ?? p.population),
    income: money(p.income),
  });
  $('income-value').textContent = money(p.income);
  $('income-value').classList.toggle('missing', !isNumber(p.income));
  $('income-context').textContent = isNumber(p.income)
    ? t('detail.incomeContext', {
        ratio: (p.income / state.metadata.cityIncomeMedian).toFixed(2),
        rank: p.incomeRank,
        total: state.counts.income,
      })
    : '官方资料暂无同口径收入数值';
  $('children').textContent = percent(p.children);
  $('household').textContent = isNumber(p.householdSize)
    ? t('unit.people', { count: p.householdSize.toFixed(1) })
    : t('暂无数据');
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
    localize(sidebar);
    return;
  }
  if (!groups.length) {
    $('composition-bars').innerHTML = '<p class="detail-empty">点击“人群”选择想了解的类别。</p>';
    $('composition-basis').textContent = '';
    localize(sidebar);
    return;
  }
  const rows = groups.map(g => ({
    ...g,
    count: record.counts[g.id],
    share: populationShare(record, g.id),
    city: populationShare(state.data.city, g.id),
    color: state.colors[g.id],
  }));
  const remainder = state.groups.filter(g => !state.selectedGroups.includes(g.id));
  if (remainder.length)
    rows.push({
      id: 'other',
      label: '其余类别',
      count: remainder.reduce((sum, g) => sum + record.counts[g.id], 0),
      share: remainder.reduce((sum, g) => sum + record.counts[g.id], 0) / record.population,
      city: remainder.reduce((sum, g) => sum + state.data.city.counts[g.id], 0) / state.data.city.population,
      color: COMPOSITION_OTHER_COLOR,
    });
  $('composition-bars').innerHTML = rows
    .map(
      row =>
        `<div class="composition-row" data-detail-group="${row.id}"><div class="bar-heading"><span>${esc(row.label)}</span><span><small>${t('unit.people', { count: number(row.count) })}</small><strong>${percent(row.share)}</strong></span></div><div class="bar-track"><span class="bar-fill" style="width:${Math.min(100, Math.max(0, (row.share || 0) * 100))}%;background:${row.color}"></span><i class="city-reference" style="left:${Math.min(100, Math.max(0, (row.city || 0) * 100))}%" title="${esc(t('city.value', { value: percent(row.city) }))}"></i></div><span class="sr-only">${esc(t('city.share', { value: percent(row.city) }))}</span></div>`,
    )
    .join('');
  const sum = Object.values(record.counts).reduce((a, b) => a + b, 0);
  const difference = Math.abs(sum - record.population);
  const basis = [
    t('占比按人数 ÷ 同表私人住户人口计算。灰色为未勾选类别，留白为原表统计差额。'),
    difference > 35 || difference / record.population > 0.01
      ? t('detail.discrepancy', { sum: number(sum), population: number(record.population) })
      : t('原始人数经过统计取整。'),
  ];
  // Chinese sentences run together; English ones need a space after the full stop.
  $('composition-basis').textContent = basis.map(part => part.trim()).join(currentLanguage() === 'en' ? ' ' : '');
  localize(sidebar);
}

function styleFor(context, feature) {
  const p = feature.properties;
  const value = context.groupId ? populationShare(populationRecord(p.code), context.groupId) : p.income;
  const missing = context.groupId ? value === null : state.income && !isNumber(value);
  const dark = isDarkTheme();
  return {
    color: missing ? (dark ? '#5a7075' : '#a7b3ac') : dark ? '#5a7075' : '#fafbf5',
    weight: 0.75,
    opacity: 1,
    fillColor: missing
      ? dark
        ? '#263b42'
        : '#d6dcd9'
      : context.groupId
        ? populationColor(value, dark)
        : state.income
          ? colorFor(value)
          : dark
            ? '#263b42'
            : '#e0e8dc',
    fillOpacity: missing ? 0.35 : context.groupId ? (dark ? 0.92 : 0.64) : state.income ? (dark ? 0.62 : 0.67) : 0.72,
    dashArray: missing ? '3 3' : null,
  };
}

function refreshStyles() {
  for (const context of state.contexts) {
    for (const layer of context.layers.values()) layer.setStyle(styleFor(context, layer.feature));
    context.highlights?.setSelected(activeCode());
    context.highlights?.refresh();
  }
}

function tooltipContent(feature, context) {
  const p = feature.properties;
  const record = populationRecord(p.code);
  if (context.groupId) {
    const group = state.groupById.get(context.groupId);
    const count = record?.counts[group.id];
    const share = percent(populationShare(state.data.city, group.id));
    // Without a published count, show only the city reference rather than "No data people".
    const detail = isNumber(count)
      ? t('tooltip.groupCity', { count: number(count), share })
      : t('city.value', { value: share });
    return localizeHtml(
      `<strong>${esc(p.name)}</strong>${esc(t('tooltip.groupShare', { group: t(group.label), value: percent(populationShare(record, group.id)) }))}<br>${esc(detail)}<span class="tip-note">点击固定社区，查看完整构成</span>`,
    );
  }
  const groups = record
    ? selectedGroups()
        .slice(0, 5)
        .map(
          g =>
            `<br>${esc(t('tooltip.groupShare', { group: t(g.label), value: percent(populationShare(record, g.id)) }))}`,
        )
        .join('')
    : '<br>人口分类暂无数据';
  return localizeHtml(
    `<strong>${esc(p.name)}</strong>${esc(t('tooltip.income', { value: money(p.income) }))}<br>${esc(t('tooltip.population', { value: number(record?.population ?? p.population) }))}${groups}<span class="tip-note">点击查看社区详情</span>`,
  );
}

function createMap(element, groupId = null) {
  const map = L.map(element, {
    zoomControl: false,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    minZoom: 8,
    maxZoom: 17,
    attributionControl: false,
  });
  const context = { map, groupId, layers: new Map(), donuts: L.layerGroup(), labels: L.layerGroup(), donutCount: 0 };
  context.tooltip = createMapTooltip({
    map,
    tooltip: L.tooltip({ className: 'community-tooltip', direction: 'top', opacity: 0.98 }),
    enabled: () => !mobile(),
    hoverEnabled: () => window.matchMedia('(any-hover: hover)').matches,
  });
  for (const [name, zIndex] of [
    ['water', 410],
    ['roads', 420],
    ['donuts', 450],
    ['labels', 470],
  ]) {
    map.createPane(name);
    map.getPane(name).style.zIndex = zIndex;
    if (name !== 'donuts') map.getPane(name).style.pointerEvents = 'none';
  }
  context.highlights = createCommunityHighlight({
    L,
    map,
    features: state.features,
    isDark: isDarkTheme,
    hoverEnabled: () => !mobile() && window.matchMedia('(any-hover: hover)').matches,
  });
  context.highlights.setSelected(activeCode());
  context.donuts.addTo(map);
  context.labels.addTo(map);
  context.boundaries = L.geoJSON(
    { type: 'FeatureCollection', features: state.features },
    {
      style: feature => styleFor(context, feature),
      onEachFeature(feature, layer) {
        const code = feature.properties.code;
        context.layers.set(code, layer);
        layer.on('add', () => {
          const path = layer.getElement();
          if (!path) return;
          path.setAttribute('data-community', code);
          path.setAttribute('aria-label', feature.properties.name);
          path.setAttribute('role', 'button');
          // Roving tab stop: one community per map is tabbable; arrows move between them.
          path.setAttribute('tabindex', code === (context.focusCode ?? state.selected) ? '0' : '-1');
          path.addEventListener('keydown', event => communityKeydown(context, code, event));
        });
        layer.on('click', () => {
          selectCommunity(code, false);
          toggleGroups(false);
        });
        context.highlights.bind(layer, code);
        context.tooltip.bind(layer, {
          content: () => tooltipContent(feature, context),
          anchor: event => event?.latlng || layer.getBounds().getCenter(),
        });
      },
    },
  ).addTo(map);
  if (!groupId) {
    context.contextLayers = createContextLayers({
      context,
      visible: {
        roads: state.roads,
        transit: state.transit,
        landmarks: state.landmarks,
        communityLabels: state.labels,
      },
      getLabelObstacles: () => [...mapLabelObstacles(map), ...(context.donutBoxes || [])],
      onStationOpen: () => {
        closeTooltips();
        toggleGroups(false);
        toggleLayers(false);
        if (mobile()) setCollapsed(true);
      },
    });
  } else {
    renderComparisonBasemap(context);
  }
  state.contexts.push(context);
  map.on('popupopen', () => {
    context.popupOpen = true;
  });
  map.on('popupclose', () => {
    context.popupOpen = false;
  });
  map.on('movestart zoomstart', () => {
    context.tooltip.close();
    if (!syncing) closeTooltips(false);
  });
  map.on('dragstart', () => {
    state.wholeCity = false;
  });
  map.on('zoomstart', () => {
    if (!syncing) state.wholeCity = false;
  });
  map.on('move', () => {
    if (syncing || !activeContexts().includes(context)) return;
    cancelAnimationFrame(syncFrame);
    syncFrame = requestAnimationFrame(() => syncMaps(context));
  });
  map.on('moveend', () => {
    if (syncing || !activeContexts().includes(context)) return;
    syncMaps(context);
    renderOverlays();
  });
  return context;
}

// Context layers load after the census map is usable; transit and landmarks
// only when first switched on.
const layerData = {};
const layerRequests = {};
const layerFailures = new Set();
const LAYER_NAMES = { basemap: '道路与河流', railways: '铁路', transit: 'CTrain 线路与车站', landmarks: '地理地标' };
function ensureLayer(name) {
  if (layerData[name] || layerRequests[name]) return;
  layerFailures.delete(name);
  layerRequests[name] = loadLayerData(name)
    .then(data => {
      layerData[name] = data;
      attachLayers();
    })
    .catch(() => {
      layerFailures.add(name);
    })
    .finally(() => {
      delete layerRequests[name];
      renderLayerWarning();
    });
}
function attachLayers() {
  const layers = state.composition?.contextLayers;
  if (layers) {
    if (layerData.basemap) layers.setBasemap(layerData.basemap[0]);
    if (layerData.railways) layers.setRailways(layerData.railways[0]);
    if (layerData.landmarks) layers.setLandmarks(...layerData.landmarks);
    if (layerData.transit) layers.setTransit(...layerData.transit);
  }
  if (layerData.basemap && !state.basemap) {
    state.basemap = layerData.basemap[0];
    state.comparisonContexts.filter(context => !context.refreshBasemap).forEach(renderComparisonBasemap);
  }
  renderOverlays();
}
function renderLayerWarning() {
  const failed = [...layerFailures].map(name => LAYER_NAMES[name]);
  $('map-warning').hidden = !failed.length;
  if (!failed.length) return;
  $('map-warning').textContent = t('warning.layers', {
    layers: failed.map(label => t(label)).join(t('list.separator')),
  });
  localize($('map-warning'));
}
function ensureVisibleLayers() {
  ensureLayer('basemap');
  if (state.roads) ensureLayer('railways');
  if (state.transit) ensureLayer('transit');
  if (state.landmarks) ensureLayer('landmarks');
}

const ARROWS = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
function setRovingCommunity(context, code) {
  if (!context.layers.has(code)) return;
  if (context.focusCode && context.focusCode !== code)
    context.layers.get(context.focusCode)?.getElement()?.setAttribute('tabindex', '-1');
  context.focusCode = code;
  context.layers.get(code).getElement()?.setAttribute('tabindex', '0');
}
/** Nearest community centre in the arrow's direction, favouring ones straight ahead. */
function neighbourInDirection(map, code, [dx, dy]) {
  const point = feature => map.latLngToContainerPoint([feature.properties.centroid[1], feature.properties.centroid[0]]);
  const from = point(state.byCode.get(code));
  let best = null;
  let bestScore = Infinity;
  for (const feature of state.features) {
    if (feature.properties.code === code) continue;
    const p = point(feature);
    const along = (p.x - from.x) * dx + (p.y - from.y) * dy;
    if (along <= 2) continue;
    const score = along + Math.abs((p.x - from.x) * dy - (p.y - from.y) * dx) * 2;
    if (score < bestScore) {
      bestScore = score;
      best = feature;
    }
  }
  return best;
}
function communityKeydown(context, code, event) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    selectCommunity(code, false);
    toggleGroups(false);
    return;
  }
  const direction = ARROWS[event.key];
  if (!direction) return;
  // Arrows move between communities instead of panning the map.
  event.preventDefault();
  event.stopPropagation();
  const next = neighbourInDirection(context.map, code, direction);
  if (!next) return;
  const nextCode = next.properties.code;
  setRovingCommunity(context, nextCode);
  context.map.panInside([next.properties.centroid[1], next.properties.centroid[0]], {
    ...fitPadding(context.map),
    animate: false,
  });
  context.layers.get(nextCode).getElement()?.focus({ preventScroll: true });
}

function renderComparisonBasemap(context) {
  if (!state.basemap?.features) return;
  // Light, non-interactive basemap on canvas; communities above stay SVG.
  const water = L.geoJSON(state.basemap, {
    filter: f => f.properties.kind === 'water',
    pane: 'water',
    renderer: L.canvas({ pane: 'water' }),
    interactive: false,
  }).addTo(context.map);
  const roadRenderer = L.canvas({ pane: 'roads' });
  const roadEdges = L.geoJSON(state.basemap, {
    filter: f => f.properties.kind === 'road',
    pane: 'roads',
    renderer: roadRenderer,
    interactive: false,
  }).addTo(context.map);
  const roads = L.geoJSON(state.basemap, {
    filter: f => f.properties.kind === 'road',
    pane: 'roads',
    renderer: roadRenderer,
    interactive: false,
  }).addTo(context.map);
  context.refreshBasemap = () => {
    const dark = isDarkTheme();
    water.setStyle({
      color: dark ? '#3e6976' : '#8bb8c1',
      weight: 0.55,
      fillColor: dark ? '#234958' : '#b5d3d8',
      fillOpacity: 0.75,
    });
    roadEdges.setStyle({ color: dark ? '#223239' : '#737b80', weight: 3, opacity: 0.8 });
    roads.setStyle({ color: dark ? '#a6b0b5' : '#ffffff', weight: 1.6, opacity: 0.95 });
  };
  context.refreshBasemap();
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

function mapLabelObstacles(map) {
  const size = map.getSize();
  const mapRect = map.getContainer().getBoundingClientRect();
  const visible = node => node.offsetWidth && node.offsetHeight;
  const rectOf = node => {
    const r = node.getBoundingClientRect();
    return { x: r.left - mapRect.left - 5, y: r.top - mapRect.top - 5, w: r.width + 10, h: r.height + 10 };
  };
  const floating = ['.map-tools', '#mobile-legend-button'];
  let bands;
  if (mobile()) {
    const { top, bottom, left, right } = getMobileMapInsets();
    bands = [
      { x: 0, y: 0, w: size.x, h: top },
      { x: 0, y: size.y - bottom, w: size.x, h: bottom },
      { x: 0, y: 0, w: left, h: size.y },
      { x: size.x - right, y: 0, w: right, h: size.y },
    ];
  } else {
    // Desktop only covers the map with a rail/details panel on the left and a
    // few floating boxes; the rest of the top edge stays available for labels.
    const { left } = desktopUI?.getInsets() || { left: 0 };
    bands = [{ x: 0, y: 0, w: left, h: size.y }];
    floating.push('.app-header', '.comparison-pager', '#mobile-legend-dialog[open]');
  }
  const controls = [...document.querySelectorAll(floating.join(','))].filter(visible).map(rectOf);
  return [...bands, ...controls];
}

function fitPadding(map, community = false) {
  if (!mobile()) {
    const inset = desktopUI?.getInsets() || { top: 24, right: 24, bottom: 24, left: 24 };
    return {
      paddingTopLeft: [inset.left + 24, inset.top + 24],
      paddingBottomRight: [inset.right + 24, Math.max(100, inset.bottom + 24)],
    };
  }
  const { top, left, right } = getMobileMapInsets();
  // Fit to the destination stop, rather than the old height during its animation.
  const bottom = (communitySheet?.getTargetInset() || 0) + 14;
  const size = map.getSize();
  const available = Math.max(0, size.y - 120);
  const total = top + bottom + 32;
  const scale = total > available ? available / total : 1;
  return {
    paddingTopLeft: [Math.max(16, left || 0), (top + 16) * scale],
    paddingBottomRight: [Math.max(16, right || 0), (bottom + 16) * scale],
  };
}

function fitCity() {
  const contexts = activeContexts();
  if (!contexts.length) return;
  closeTooltips();
  syncing = true;
  const first = contexts[0];
  first.map.fitBounds(first.boundaries.getBounds(), { ...fitPadding(first.map), animate: false });
  syncing = false;
  syncMaps(first);
  state.wholeCity = true;
  renderOverlays(contexts);
}

function fitCommunity(code, collapse = true) {
  const contexts = activeContexts();
  const layer = contexts[0]?.layers.get(code);
  if (!layer) return;
  if (mobile() && collapse) setCollapsed(true);
  syncing = true;
  contexts[0].map.fitBounds(layer.getBounds(), { ...fitPadding(contexts[0].map, true), maxZoom: 14, animate: false });
  syncing = false;
  state.wholeCity = false;
  syncMaps(contexts[0]);
  renderOverlays(contexts);
}

/** Keep the shareable URL in step with the view (community, view, groups, layers). */
function writeUrlState() {
  if (!state.data) return;
  const hash = buildHashState({
    // Canonical (display) order, so the first listed group is the compare view's default.
    code: state.selectionActive ? state.selected : null,
    view: state.mode,
    groups: selectedGroups().map(g => g.id),
    compare: selectedGroups()[state.compareStart]?.id,
    income: state.income,
    transit: state.transit,
    landmarks: state.landmarks,
  });
  try {
    history.replaceState(null, '', hash || `${location.pathname}${location.search}`);
  } catch {
    /* embedded preview */
  }
}
function readUrlState() {
  return parseHashState(
    location.hash,
    state.features,
    state.groups.map(g => g.id),
  );
}
function applyUrlState(link) {
  state.income = link.income;
  $('income-toggle').checked = link.income;
  $('income-legend').hidden = !link.income;
  for (const layer of ['transit', 'landmarks']) {
    state[layer] = link[layer];
    $(`${layer}-toggle`).checked = link[layer];
  }
  updateLayerVisibility();
  ensureVisibleLayers();
  updateGroupSelection(link.groups);
  state.compareStart = Math.max(
    0,
    selectedGroups().findIndex(g => g.id === link.compare),
  );
  if (link.view !== state.mode) selectView(link.view);
  else if (state.mode === 'distribution') rebuildComparison();
  refreshStyles();
  if (link.code && (!state.selectionActive || link.code !== state.selected)) selectCommunity(link.code);
  writeUrlState();
}

function selectCommunity(code, zoom = true, expand = true) {
  if (!state.byCode.has(code)) return;
  closeTooltips();
  state.selected = code;
  if (expand) state.selectionActive = true;
  renderDetail();
  if (expand) {
    // Both layouts record the open panel, so crossing the breakpoint keeps it open.
    communitySheet.open('half');
    desktopUI?.openDetails();
  } else communitySheet?.refresh();
  refreshStyles();
  for (const context of state.contexts) setRovingCommunity(context, code);
  renderOverlays();
  renderComparisonHeadings();
  if (zoom) fitCommunity(code, false);
  else if (expand && !mobile()) {
    const centroid = state.byCode.get(code).properties.centroid;
    const context = activeContexts()[0];
    if (centroid && context)
      context.map.panInside([centroid[1], centroid[0]], { ...fitPadding(context.map, true), animate: false });
  }
  if (expand) $('announcer').textContent = t('announce.selected', { name: state.byCode.get(code).properties.name });
  if (expand) writeUrlState();
}

/** Keyboard focus returns to the map's community tab stop when its panel goes away. */
function focusMapCommunity() {
  const context = activeContexts()[0];
  const path = context?.layers.get(context.focusCode ?? state.selected)?.getElement();
  (path || context?.map.getContainer())?.focus({ preventScroll: true });
}

/** Closing the details (X, Escape, or a link without a community) returns to "nothing selected". */
function clearSelection() {
  if (!state.selectionActive) return;
  const hadFocus = sidebar.contains(document.activeElement);
  state.selectionActive = false;
  closeTooltips();
  if (communitySheet.getState() !== 'closed') communitySheet.setSnap('closed');
  desktopUI?.clearSelection();
  refreshStyles();
  renderOverlays();
  if (hadFocus) focusMapCommunity();
  $('announcer').textContent = t('announce.cleared');
  writeUrlState();
}

/** Rings claim their space first so every map label can avoid them. */
function renderOverlays(contexts = activeContexts()) {
  updateDonuts();
  contexts.forEach(updateLabels);
}

function updateDonuts() {
  const context = state.composition;
  if (!context || state.mode !== 'composition' || !context.map._loaded) return;
  context.tooltip.close();
  context.donuts.clearLayers();
  context.donutBoxes = [];
  context.donutCodes = new Set();
  const groups = selectedGroups();
  if (!groups.length) return;
  const map = context.map;
  const size = mobile() ? 28 : 32;
  const hitSize = mobile() ? 44 : size;
  const obstacles = mapLabelObstacles(map);
  const occupied = [];
  const selected = activeCode();
  const candidates = state.features
    .filter(
      f =>
        populationRecord(f.properties.code) &&
        map.getBounds().contains([f.properties.centroid[1], f.properties.centroid[0]]),
    )
    .sort((a, b) =>
      a.properties.code === selected
        ? -1
        : b.properties.code === selected
          ? 1
          : (populationRecord(b.properties.code)?.population || 0) -
            (populationRecord(a.properties.code)?.population || 0),
    );
  let shown = 0;
  for (const feature of candidates) {
    const p = feature.properties;
    const point = map.latLngToContainerPoint([p.centroid[1], p.centroid[0]]);
    if (
      point.x < hitSize / 2 ||
      point.y < hitSize / 2 ||
      point.x > map.getSize().x - hitSize / 2 ||
      point.y > map.getSize().y - hitSize / 2
    )
      continue;
    if (
      obstacles.some(
        b =>
          point.x + hitSize / 2 > b.x &&
          point.x - hitSize / 2 < b.x + b.w &&
          point.y + hitSize / 2 > b.y &&
          point.y - hitSize / 2 < b.y + b.h,
      )
    )
      continue;
    if (occupied.some(other => point.distanceTo(other) < hitSize + 14) && p.code !== selected) continue;
    const html = donutSvg(populationRecord(p.code), state.selectedGroups, state.colors, size);
    if (!html) continue;
    occupied.push(point);
    context.donutBoxes.push({
      x: point.x - size / 2 - 2,
      y: point.y - size / 2 - 2,
      w: size + 4,
      h: size + 4,
      code: p.code,
      ring: true,
    });
    context.donutCodes.add(p.code);
    const marker = L.marker([p.centroid[1], p.centroid[0]], {
      icon: L.divIcon({
        className: `population-donut${p.code === selected ? ' selected-donut' : ''}`,
        html,
        iconSize: [hitSize, hitSize],
        iconAnchor: [hitSize / 2, hitSize / 2],
      }),
      // Communities are reached by keyboard through their polygons; rings would duplicate every stop.
      pane: 'donuts',
      keyboard: false,
      title: t('ring.title', { name: p.name }),
      alt: t('ring.title', { name: p.name }),
      riseOnHover: false,
    }).addTo(context.donuts);
    marker.getElement()?.setAttribute('data-population-code', p.code);
    marker.getElement()?.setAttribute('aria-hidden', 'true');
    marker.on('click', () => {
      selectCommunity(p.code, false);
      toggleGroups(false);
    });
    context.highlights.bind(marker, p.code);
    context.tooltip.bind(marker, {
      content: () => tooltipContent(feature, context),
      anchor: () => marker.getLatLng(),
      offset: [0, -size / 2],
    });
    shown++;
  }
  context.donutCount = shown;
}

function updateLabels(context) {
  const map = context.map;
  if (!map._loaded) return;
  context.contextLayers?.update();
  context.labels.clearLayers();
  const comparison = Boolean(context.groupId);
  if (!comparison && !state.labels) return;
  const zoom = map.getZoom();
  const viewport = map.getSize();
  const tier =
    zoom < 11.5
      ? { cap: 32, pixels: 28000, minPopulation: 9000 }
      : zoom < 12.5
        ? { cap: 45, pixels: 22000, minPopulation: 3500 }
        : zoom < 13.5
          ? { cap: 70, pixels: 16000, minPopulation: 0 }
          : { cap: 100, pixels: 12000, minPopulation: 0 };
  const textScale = parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 || 1;
  const density = (comparison ? 1.7 : 1.2) * textScale * textScale;
  const cap = Math.max(
    3,
    Math.min(Math.round(tier.cap / density), Math.floor((viewport.x * viewport.y) / (tier.pixels * density))),
  );
  const fontSize = (zoom < 12 ? 12 : 13) * textScale;
  const selected = activeCode();
  const candidates = state.features
    .filter(feature => {
      const p = feature.properties;
      if (!map.getBounds().contains([p.centroid[1], p.centroid[0]])) return false;
      if (!comparison && state.landmarks && (p.code === 'CIA' || p.type === 'Major Park')) return false;
      if (p.code === selected) return true;
      if (/^\d/.test(p.name)) return false;
      if (zoom < 12.5 && (!isNumber(p.population) || p.population < tier.minPopulation)) return false;
      return zoom >= 13.5 || p.type === 'Residential';
    })
    .map(feature => {
      const p = feature.properties;
      const bounds = context.layers.get(p.code)?.getBounds();
      const area = bounds
        ? Math.abs((bounds.getEast() - bounds.getWest()) * (bounds.getNorth() - bounds.getSouth()))
        : 0;
      return { feature, priority: (p.population || 0) + area * 400000 };
    })
    .sort(
      (a, b) =>
        Number(b.feature.properties.code === selected) - Number(a.feature.properties.code === selected) ||
        b.priority - a.priority ||
        a.feature.properties.code.localeCompare(b.feature.properties.code),
    );
  const occupied = [
    ...(context.contextLayers?.labelBoxes || [...mapLabelObstacles(map), ...(context.donutBoxes || [])]),
  ];
  let shown = 0;
  for (const { feature } of candidates) {
    if (shown >= cap) break;
    const p = feature.properties;
    const prominent = p.code === selected;
    const label = p.name.toUpperCase();
    const size = fontSize;
    const maxWidth = Math.min(210 * textScale, viewport.x * 0.65);
    labelMeasure.font = `600 ${size}px ${getComputedStyle(document.documentElement).fontFamily}`;
    const lines = [''];
    for (const word of label.split(' ')) {
      const current = lines.length - 1;
      const next = lines[current] ? `${lines[current]} ${word}` : word;
      if (lines[current] && labelMeasure.measureText(next).width > maxWidth) lines.push(word);
      else lines[current] = next;
    }
    const width = Math.ceil(Math.max(54, ...lines.map(line => labelMeasure.measureText(line).width)) + 6);
    const height = Math.ceil(lines.length * size * 1.22);
    const point = map.latLngToContainerPoint([p.centroid[1], p.centroid[0]]);
    // Sit below (or else above) this community's own ring; centre the name when
    // no ring is drawn. Other communities' rings are hard obstacles with no gap.
    const hasRing = !comparison && context.donutCodes?.has(p.code);
    const others = occupied.filter(a => !(a.ring && a.code === p.code));
    const gapX = zoom < 12 ? 16 : 10;
    const gapY = zoom < 12 ? 12 : 7;
    const blocked = (box, loose = false) =>
      others.some(a => {
        const gx = a.ring ? 0 : loose ? 8 : gapX;
        const gy = a.ring ? 0 : loose ? 6 : gapY;
        return box.x < a.x + a.w + gx && box.x + box.w + gx > a.x && box.y < a.y + a.h + gy && box.y + box.h + gy > a.y;
      });
    const inView = box =>
      box.x >= 6 && box.y >= 8 && box.x + width <= viewport.x - 6 && box.y + height <= viewport.y - 18;
    const candidates = hasRing ? [20, -height - 18] : prominent ? [-height / 2, -height - 18, 32] : [-height / 2];
    const boxAt = candidate => ({ x: point.x - width / 2, y: point.y + candidate, w: width, h: height });
    const offset = candidates.find(candidate => {
      const box = boxAt(candidate);
      return inView(box) && !blocked(box, prominent);
    });
    if (offset === undefined) continue;
    const box = boxAt(offset);
    occupied.push(box);
    L.marker([p.centroid[1], p.centroid[0]], {
      icon: L.divIcon({
        className: `community-label hierarchy-community-label${prominent ? ' focus-label' : ''}`,
        html: `<span style="font-size:${size}px;line-height:1.22;font-weight:600">${lines.map(esc).join('<br>')}</span>`,
        iconSize: [width, height],
        iconAnchor: [width / 2, -offset],
      }),
      interactive: false,
      keyboard: false,
      pane: 'labels',
      zIndexOffset: prominent ? 1000 : 0,
    }).addTo(context.labels);
    shown++;
  }
}

function renderMobileSummary() {
  const p = state.byCode.get(state.selected)?.properties;
  if (!p) return;
  if (state.mode === 'distribution') {
    const group = selectedGroups()[state.compareStart];
    $('collapsed-summary').textContent = group
      ? t('summary.compare', {
          group: t(group.label),
          share: percent(populationShare(populationRecord(p.code), group.id)),
          city: percent(populationShare(state.data.city, group.id)),
        })
      : t('选择人口群体');
  }
  mobileUI?.refresh();
}

/** The compared group's city-wide baseline sits beside the group switcher. */
function renderComparisonHeadings() {
  const group = state.groupById.get(state.comparisonContexts[0]?.groupId);
  $('comparison-city').textContent = group
    ? t('city.value', { value: percent(populationShare(state.data.city, group.id)) })
    : '';
  if (group) $('comparison-map')?.setAttribute('aria-label', t('compare.mapLabel', { group: t(group.label) }));
  localize($('comparison-select'));
  renderMobileSummary();
}

function destroyComparisonMap() {
  for (const context of state.comparisonContexts) {
    context.highlights.destroy();
    context.tooltip.destroy();
    context.map.remove();
    state.contexts = state.contexts.filter(c => c !== context);
  }
  state.comparisonContexts = [];
  $('comparison-maps').replaceChildren();
}

/**
 * One comparison map is reused for every group: switching groups only changes
 * its groupId and restyles the existing paths instead of rebuilding Leaflet.
 */
function rebuildComparison({ preserveView = true } = {}) {
  cancelAnimationFrame(syncFrame);
  syncFrame = null;
  closeTooltips();
  const groups = selectedGroups();
  state.compareStart = Math.max(0, Math.min(state.compareStart, groups.length - 1));
  const group = groups[state.compareStart];
  $('comparison-empty').hidden = Boolean(group);
  $('population-legend').hidden = !group;
  $('comparison-select').innerHTML = groups
    .map(
      (g, index) =>
        `<option value="${index}" ${index === state.compareStart ? 'selected' : ''}>${esc(g.label)}</option>`,
    )
    .join('');
  $('comparison-select').disabled = !groups.length;
  $('comparison-page').textContent = groups.length ? `${state.compareStart + 1} / ${groups.length}` : '0 / 0';
  $('previous-groups').disabled = state.compareStart === 0;
  $('next-groups').disabled = state.compareStart + 1 >= groups.length;
  localize($('comparison-select'));
  if (!group) {
    destroyComparisonMap();
    renderMobileSummary();
    return;
  }
  let context = state.comparisonContexts[0];
  const created = !context;
  if (created) {
    $('comparison-maps').innerHTML =
      '<section class="comparison-card"><div id="comparison-map" class="comparison-map" role="region"></div></section>';
    syncing = true;
    context = createMap('comparison-map', group.id);
    state.comparisonContexts = [context];
    if (state.view) context.map.setView(state.view.center, state.view.zoom, { animate: false });
    syncing = false;
  } else if (context.groupId !== group.id) {
    context.groupId = group.id;
    for (const layer of context.layers.values()) layer.setStyle(styleFor(context, layer.feature));
  }
  renderComparisonHeadings();
  writeUrlState();
  // The map may have been hidden (composition view) or just created: settle its size.
  requestAnimationFrame(() => {
    if (preserveView && state.view) {
      resizeMapsKeepingView();
      return;
    }
    context.map.invalidateSize({ pan: false });
    if (state.wholeCity || !state.view) fitCity();
    else {
      refreshStyles();
      updateLabels(context);
    }
  });
}

function selectView(mode) {
  if (state.mode === mode) return;
  cancelAnimationFrame(syncFrame);
  syncFrame = null;
  const current = activeContexts()[0];
  if (current?.map._loaded) syncMaps(current);
  closeTooltips();
  state.mode = mode;
  renderDetail();
  renderMobileSummary();
  for (const candidate of ['composition', 'distribution']) {
    const active = candidate === mode;
    $(`${candidate}-tab`).classList.toggle('active', active);
    $(`${candidate}-tab`).setAttribute('aria-selected', String(active));
    $(`${candidate}-tab`).tabIndex = active ? 0 : -1;
    $(`${candidate}-view`).hidden = !active;
  }
  $('income-control').hidden = mode !== 'composition';
  $('layers-button').hidden = mode !== 'composition';
  $('transit-legend').hidden = mode !== 'composition' || !state.transit;
  toggleLayers(false);
  $('mode-description').textContent = t(mode === 'composition' ? '一个社区，一张构成图' : '同一色阶，查看聚居分布');
  document.querySelector('.map-workspace').classList.toggle('comparing', mode === 'distribution');
  mobileUI?.refresh();
  writeUrlState();
  if (mode === 'distribution') rebuildComparison();
  else
    requestAnimationFrame(() => {
      syncing = true;
      state.composition.map.invalidateSize({ pan: false });
      if (state.view) state.composition.map.setView(state.view.center, state.view.zoom, { animate: false });
      syncing = false;
      if (state.wholeCity) fitCity();
      else renderOverlays();
    });
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
  $('search-results').innerHTML = state.searchMatches.length
    ? state.searchMatches
        .map((feature, i) => {
          const p = feature.properties;
          return `<button class="search-result" id="search-option-${i}" role="option" aria-selected="false" data-code="${esc(p.code)}"><span><strong>${esc(p.name)}</strong><small>${esc(
            [p.sectorLabel, p.typeLabel]
              .filter(Boolean)
              .map(tag => t(tag))
              .join(' · '),
          )}</small></span><span>${money(p.income)}</span></button>`;
        })
        .join('')
    : '<p class="no-results">没有找到社区，可输入英文名或社区代码。</p>';
  localize($('search-results'));
}
function chooseSearchResult(code) {
  if (mobile()) $('search').blur();
  selectCommunity(code);
  $('search').value = '';
  closeSearch();
  $('search').blur();
  toggleGroups(false);
}

function setReady(ready) {
  document
    .querySelectorAll(
      '.view-tabs button,#groups-button,#group-search,#default-groups,#all-groups,#clear-groups,#income-toggle,#layers-button,#roads-toggle,#labels-toggle,#transit-toggle,#landmarks-toggle,#search,#fit-city,#zoom-in,#zoom-out,#focus-community',
    )
    .forEach(control => {
      control.disabled = !ready;
    });
}

function initializeControls() {
  setReady(false);
  window.addEventListener('atlas-languagechange', () => {
    closeTooltips();
    applyStaticTranslations();
    refreshThemeControl();
    mobileUI?.refresh();
    if (state.data) {
      renderMetadata();
      renderGroupList();
      renderDonutKey();
      renderDetail();
      renderComparisonHeadings();
      communitySheet?.refresh();
      $('mode-description').textContent = t(
        state.mode === 'composition' ? '一个社区，一张构成图' : '同一色阶，查看聚居分布',
      );
      renderOverlays(state.contexts);
      renderLayerWarning();
      if ($('search').value) renderSearch();
    }
  });
  window.addEventListener('atlas-themechange', () => {
    closeTooltips();
    refreshStyles();
    state.contexts.forEach(context => context.refreshBasemap?.());
  });
  for (const mode of ['composition', 'distribution'])
    $(`${mode}-tab`).addEventListener('click', () => selectView(mode));
  document.querySelector('.view-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const mode =
      event.key === 'Home'
        ? 'composition'
        : event.key === 'End'
          ? 'distribution'
          : state.mode === 'composition'
            ? 'distribution'
            : 'composition';
    selectView(mode);
    $(`${mode}-tab`).focus();
  });
  $('layers-button').addEventListener('click', () => toggleLayers($('layers-panel').hidden));
  $('close-layers').addEventListener('click', () => {
    toggleLayers(false);
    (mobile() ? $('mobile-more') : $('layers-button')).focus();
  });
  for (const layer of ['roads', 'labels', 'transit', 'landmarks'])
    $(`${layer}-toggle`).addEventListener('change', event => {
      state[layer] = event.target.checked;
      ensureVisibleLayers();
      updateLayerVisibility();
      writeUrlState();
    });
  $('groups-button').addEventListener('click', () => toggleGroups($('groups-panel').hidden));
  $('close-groups').addEventListener('click', () => {
    toggleGroups(false);
    (mobile() ? $('mobile-more') : $('groups-button')).focus({ preventScroll: true });
  });
  $('empty-choose-groups').addEventListener('click', () => {
    toggleGroups(true);
  });
  $('group-search').addEventListener('input', renderGroupList);
  $('group-list').addEventListener('change', event => {
    const id = event.target.dataset.group;
    if (!id) return;
    updateGroupSelection(
      event.target.checked ? [...state.selectedGroups, id] : state.selectedGroups.filter(value => value !== id),
      false,
    );
  });
  $('default-groups').addEventListener('click', () => updateGroupSelection(state.data.defaultGroupIds));
  $('all-groups').addEventListener('click', () => updateGroupSelection(state.groups.map(g => g.id)));
  $('clear-groups').addEventListener('click', () => updateGroupSelection([]));
  $('income-toggle').addEventListener('change', event => {
    state.income = event.target.checked;
    $('income-legend').hidden = !state.income;
    refreshStyles();
    mobileUI?.refresh();
    writeUrlState();
  });
  $('previous-groups').addEventListener('click', () => {
    state.compareStart -= 1;
    rebuildComparison();
  });
  $('next-groups').addEventListener('click', () => {
    state.compareStart += 1;
    rebuildComparison();
  });
  $('comparison-select').addEventListener('change', event => {
    state.compareStart = Number(event.target.value);
    rebuildComparison();
  });
  $('fit-city').addEventListener('click', fitCity);
  $('zoom-in').addEventListener('click', () => activeContexts()[0]?.map.zoomIn(0.5));
  $('zoom-out').addEventListener('click', () => activeContexts()[0]?.map.zoomOut(0.5));
  $('focus-community').addEventListener('click', () => fitCommunity(state.selected));
  $('method-button').addEventListener('click', () => {
    toggleGroups(false);
    toggleLayers(false);
    closeTooltips();
    dialog.showModal();
  });
  $('close-method').addEventListener('click', () => {
    dialog.close();
    (mobile() ? $('mobile-more') : $('method-button')).focus({ preventScroll: true });
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      dialog.close();
  });
  $('search').addEventListener('input', renderSearch);
  $('search').addEventListener('focus', () => {
    if ($('search').value) renderSearch();
  });
  $('search-results').addEventListener('click', event => {
    const button = event.target.closest('[data-code]');
    if (button) chooseSearchResult(button.dataset.code);
  });
  $('search').addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      // Only leave the search box; the same press must not also close a panel or the selection.
      event.stopPropagation();
      closeSearch();
      $('search').blur();
    }
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && state.searchMatches.length) {
      event.preventDefault();
      const count = state.searchMatches.length;
      state.activeSearch =
        state.activeSearch < 0
          ? event.key === 'ArrowDown'
            ? 0
            : count - 1
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
  document.addEventListener('click', event => {
    if (!event.target.closest('.search-wrap')) closeSearch();
    if (!event.target.closest('#layers-panel') && !event.target.closest('#layers-button')) toggleLayers(false);
    if (
      !event.target.closest('#groups-panel') &&
      !event.target.closest('#groups-button') &&
      !event.target.closest('#empty-choose-groups')
    )
      toggleGroups(false);
  });
  // The desktop legend card is a non-modal <dialog open>; only a modal dialog owns the keyboard.
  const modalOpen = () => Boolean(document.querySelector('dialog:modal'));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !modalOpen()) {
      // One layer per press: a station popup, then an open panel, then the selection.
      const hadPopup = state.contexts.some(context => context.popupOpen);
      closeTooltips();
      if (hadPopup) return;
      if (!$('layers-panel').hidden) {
        toggleLayers(false);
        (mobile() ? $('mobile-more') : $('layers-button')).focus();
      } else if (!$('groups-panel').hidden) {
        toggleGroups(false);
        (mobile() ? $('mobile-more') : $('groups-button')).focus({ preventScroll: true });
      } else if (!mobile()) clearSelection();
    }
    if (
      event.key === '/' &&
      !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) &&
      !modalOpen()
    ) {
      event.preventDefault();
      $('search').focus();
    }
  });
  window.addEventListener('hashchange', () => {
    if (!state.data) return;
    const link = readUrlState();
    // A bare #CODE (the original link format) only jumps to that community and
    // keeps the current view; a link carrying view parameters restores all of it.
    if (location.hash.includes('?')) applyUrlState(link);
    else if (link.code && (!state.selectionActive || link.code !== state.selected)) selectCommunity(link.code);
  });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const changed = lastMobile !== mobile();
      lastMobile = mobile();
      // Keyboard and browser chrome resize the viewport. Preserve the user's camera.
      mobileUI?.refresh();
      resizeMapsKeepingView();
      if (changed && state.wholeCity) fitCity();
    }, 150);
  });
}

async function init() {
  applyStaticTranslations();
  initTheme();
  communitySheet = initCommunitySheet({ onChange: () => mobileUI?.refresh(), onClose: clearSelection });
  initializeControls();
  initLanguagePreference();
  mobileUI = initMobileUI({
    onLayoutChange: () => {
      const nextTextSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const changedText = nextTextSize !== observedTextSize;
      observedTextSize = nextTextSize;
      if (changedText && state.wholeCity && activeContexts().length) fitCity();
      renderOverlays();
    },
  });
  desktopUI = initDesktopUI({ onLayoutChange: () => renderOverlays(), onClose: clearSelection });
  try {
    const data = await loadCoreData();
    state.metadata = data.metadata;
    state.features = data.features;
    state.data = data.populationData;
    state.byCode = new Map(data.features.map(f => [f.properties.code, f]));
    state.counts = summarize(data.features);
    state.groups = data.populationData.groups;
    state.groupById = new Map(state.groups.map(g => [g.id, g]));
    state.colors = Object.fromEntries(state.groups.map(g => [g.id, POPULATION_GROUP_COLORS[g.id] || '#4c7870']));
    state.selectedGroups = [];
    const link = readUrlState();
    state.selected = link.code || (state.byCode.has('PAN') ? 'PAN' : data.features[0].properties.code);
    renderMetadata();
    renderGroupList();
    renderDonutKey();
    renderDetail();
    $('group-count').textContent = state.selectedGroups.length;
    state.composition = createMap('composition-map');
    $('loading-overlay').hidden = true;
    mobileUI.refresh();
    fitCity();
    selectCommunity(state.selected, false, false);
    applyUrlState(link);
    setReady(true);
    ensureVisibleLayers();
  } catch (error) {
    $('loading-overlay').hidden = false;
    $('loading-overlay').innerHTML =
      `<strong>地图暂时无法载入</strong><span>${esc(error.message)}</span><button class="map-button" id="retry">重新载入</button>`;
    $('retry').addEventListener('click', () => location.reload());
    $('coverage-text').textContent = '数据载入失败';
    localize($('loading-overlay'), $('coverage-text'));
  }
}

init();
