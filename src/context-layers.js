import L from 'leaflet';
import { t, currentLanguage, localizeHtml } from './i18n.js';
import { isDarkTheme } from './theme.js';
import { escapeHtml as esc, safeUrl } from './map-utils.js';

export const LINE_COLORS = Object.freeze({ red: '#ca3544', blue: '#2879bd', green: '#22834b' });
const lineName = id => ({ red: 'Red Line', blue: 'Blue Line', green: 'Green Line' }[id] || id);
const statusName = status => ({ operating: '运营中', construction: '建设中 · 未运营', planned: '规划中 · 未运营' }[status] || '未运营');
const features = data => data?.type === 'FeatureCollection' && Array.isArray(data.features) ? data.features : [];

function midpoint(feature) {
  const geometry = feature.geometry;
  if (geometry?.type === 'Point') return geometry.coordinates;
  const lines = geometry?.type === 'LineString' ? [geometry.coordinates]
    : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
  let best = null;
  let bestLength = -1;
  for (const line of lines) {
    const lengths = line.slice(1).map((point, i) => Math.hypot((point[0] - line[i][0]) * .63, point[1] - line[i][1]));
    const total = lengths.reduce((sum, length) => sum + length, 0);
    if (total <= bestLength) continue;
    let traveled = 0;
    for (let i = 0; i < lengths.length; i++) {
      if (traveled + lengths[i] >= total / 2) {
        const t = lengths[i] ? (total / 2 - traveled) / lengths[i] : 0;
        best = [line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t];
        break;
      }
      traveled += lengths[i];
    }
    bestLength = total;
  }
  return best;
}

export function stationContent(properties) {
  const names = (properties.lineIds || []).map(lineName).join(' / ');
  const approximate = properties.geometryQuality === 'approximate' || properties.geometryQuality === 'schematic';
  const source = safeUrl(properties.sourceUrl);
  return localizeHtml(`<strong>${esc(properties.name)}</strong><span class="station-lines">${esc(names)}</span><span class="station-status${properties.status === 'operating' ? '' : ' future-status'}">${esc(statusName(properties.status))}</span>${properties.phaseLabel ? `<span class="station-phase">${esc(properties.phaseLabel)}${properties.funding === 'unfunded' ? ' · 远期规划 / 未获建设资金' : ''}</span>` : ''}${approximate ? '<span class="station-position-note">规划示意位置，非最终站位</span>' : ''}${properties.locationNote ? `<span class="station-position-note">${esc(properties.locationNote)}</span>` : ''}${properties.note ? `<span class="station-position-note">${esc(properties.note)}</span>` : ''}${source ? `<a class="station-source" href="${source}" target="_blank" rel="noopener noreferrer">官方线路资料 ↗</a>` : ''}`);
}

/** Context geometry never changes census statistics or the heat-map scale. */
export function createContextLayers({ context, basemap, geography, operatingTransit, greenTransit, communityNames = [], visible, onStationOpen }) {
  const map = context.map;
  const definitions = [['geography', 405], ['water', 410], ['roads', 420], ['roadLabels', 425], ['transit', 440], ['stations', 480], ['stationLabels', 485], ['landmarkLabels', 490]];
  for (const [name, zIndex] of definitions) {
    if (!map.getPane(name)) map.createPane(name);
    const pane = map.getPane(name);
    pane.style.zIndex = zIndex;
    if (name !== 'stations') pane.style.pointerEvents = 'none';
  }
  const roadLabels = L.layerGroup().addTo(map);
  const stationLabels = L.layerGroup().addTo(map);
  const landmarkLabels = L.layerGroup().addTo(map);
  const transitFeatures = [...features(operatingTransit), ...features(greenTransit)];
  const routes = transitFeatures.filter(f => f.properties.kind === 'transit_route');
  const stations = transitFeatures.filter(f => f.properties.kind === 'transit_station' && f.geometry?.type === 'Point');
  const roadFeatures = features(basemap).filter(f => f.properties.kind === 'road');
  const areaFeatures = features(geography).filter(f => ['airport', 'park', 'reserve'].includes(f.properties.kind));
  const normalizeName = name => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const parkLabelsByName = new Map();
  const iconicParks = new Set(['nosehillpark', 'fishcreekpark', 'northglenmorepark', 'southglenmorepark', 'bownesspark', 'princesislandpark']);
  for (const feature of areaFeatures.filter(f => f.properties.kind === 'park' && f.properties.named !== false)) {
    const p = feature.properties;
    // A single descriptive park label, not depot/school/parcel names from the same site.
    const name = String(p.name || '').split(';').map(part => part.trim()).find(part => /\bpark\b|natural area|sanctuary|wetland|garden|ravine/i.test(part));
    if (!name) continue;
    const key = normalizeName(name);
    const existing = parkLabelsByName.get(key);
    if (!existing || (p.areaHa || 0) > (existing.feature.properties.areaHa || 0)) parkLabelsByName.set(key, { feature, name, key, iconic: iconicParks.has(key) });
  }
  const parkLabelCandidates = [...parkLabelsByName.values()].sort((a, b) => Number(b.iconic) - Number(a.iconic) || (b.feature.properties.areaHa || 0) - (a.feature.properties.areaHa || 0));
  const roads = [];
  const railways = [];
  const routeLayers = [];
  const routeCasings = [];
  const stationLayers = [];
  const labelBoxes = [];
  const collection = items => ({ type: 'FeatureCollection', features: items });

  const areasLayer = L.geoJSON(collection(areaFeatures), {
    pane: 'geography', interactive: false,
    style: feature => {
      const kind = feature.properties.kind;
      return kind === 'airport' ? { color: '#9585ad', weight: .8, opacity: .55, fillColor: '#c3b9da', fillOpacity: .42 }
        : kind === 'reserve' ? { color: '#af926b', weight: 1, dashArray: '5 4', opacity: .6, fillColor: '#ded0b7', fillOpacity: .35 }
          : { color: '#80a777', weight: .4, opacity: .4, fillColor: '#a5c898', fillOpacity: .42 };
    },
  }).addTo(map);
  const waterLayer = L.geoJSON(basemap || collection([]), { filter: f => f.properties.kind === 'water', pane: 'water', interactive: false, style: { color: '#75a7b5', weight: .85, fillColor: '#a5cad4', fillOpacity: .9 } }).addTo(map);
  for (const casing of [true, false]) {
    const layer = L.geoJSON(collection(roadFeatures), { pane: 'roads', interactive: false, style: { color: casing ? '#6d8275' : '#fffff7', weight: casing ? 3.1 : 1.6, opacity: casing ? .55 : .96 } }).addTo(map);
    roads.push({ layer, casing });
  }
  for (const casing of [true, false]) {
    const layer = L.geoJSON(geography || collection([]), { filter: f => f.properties.kind === 'railway', pane: 'roads', interactive: false, style: { color: casing ? '#65716e' : '#f5f6ed', weight: casing ? 2.1 : 1.2, opacity: .85, dashArray: casing ? null : '7 5' } }).addTo(map);
    railways.push({ layer, casing });
  }
  // All casings are painted first so shared Red / Blue track retains both colours.
  for (const feature of routes) {
    const layer = L.geoJSON(feature, { pane: 'transit', interactive: false, style: { color: '#fffef7', weight: 4, opacity: .8 } }).addTo(map);
    routeCasings.push({ layer, lineId: feature.properties.lineId, future: feature.properties.funding === 'unfunded' });
  }
  for (const lineId of ['red', 'blue', 'green']) {
    for (const feature of routes.filter(f => f.properties.lineId === lineId)) {
      const future = feature.properties.funding === 'unfunded';
      const layer = L.geoJSON(feature, { pane: 'transit', interactive: false, style: { color: future ? '#65a17b' : LINE_COLORS[lineId], weight: future ? 2.2 : lineId === 'red' ? 5.2 : 3.1, opacity: future ? .82 : .94, dashArray: future ? '3 6' : lineId === 'green' ? '7 6' : null, lineCap: 'round', lineJoin: 'round' } }).addTo(map);
      routeLayers.push({ layer, lineId, future });
    }
  }
  for (const feature of stations) {
    const p = feature.properties;
    const ids = p.lineIds || [];
    const shared = ids.includes('red') && ids.includes('blue');
    const color = p.funding === 'unfunded' ? '#65a17b' : LINE_COLORS[ids[0]] || LINE_COLORS.green;
    const future = p.status !== 'operating';
    const marker = L.circleMarker([feature.geometry.coordinates[1], feature.geometry.coordinates[0]], { pane: 'stations', className: 'transit-station', radius: shared ? 4.7 : 3.7, color: shared ? LINE_COLORS.blue : color, weight: 1.9, fillColor: shared ? '#efb3b6' : '#fffef8', fillOpacity: 1, dashArray: future ? '2 2' : null, bubblingMouseEvents: false }).addTo(map);
    const open = () => {
      onStationOpen?.();
      context.tooltip.close();
      L.popup({ className: 'station-popup', maxWidth: 280, autoPan: true, autoPanPaddingTopLeft: [12, 48], autoPanPaddingBottomRight: [12, window.matchMedia('(max-width: 760px)').matches ? 145 : 24], closeButton: true, autoClose: true, closeOnClick: true })
        .setLatLng(marker.getLatLng()).setContent(stationContent(p)).openOn(map);
    };
    marker.on('click', open);
    const keydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } };
    let element = null;
    const detachElement = () => { element?.removeEventListener('keydown', keydown); element = null; };
    const attachElement = () => {
      detachElement();
      element = marker.getElement();
      element?.setAttribute('data-station-id', p.id);
      element?.setAttribute('aria-label', `${p.name} · ${ids.map(lineName).join(' / ')} · ${statusName(p.status)}`);
      element?.setAttribute('tabindex', '0');
      element?.setAttribute('role', 'button');
      element?.addEventListener('keydown', keydown);
    };
    marker.on('add', attachElement);
    marker.on('remove', detachElement);
    attachElement();
    context.tooltip.bind(marker, { content: () => stationContent(p), anchor: () => marker.getLatLng(), offset: [0, -8] });
    stationLayers.push({ marker, shared, properties: p });
  }

  function setVisible(next) {
    visible = { ...visible, ...next };
    for (const name of ['roads', 'roadLabels']) map.getPane(name).style.display = visible.roads ? '' : 'none';
    for (const name of ['transit', 'stations', 'stationLabels']) map.getPane(name).style.display = visible.transit ? '' : 'none';
    for (const name of ['geography', 'landmarkLabels']) map.getPane(name).style.display = visible.landmarks ? '' : 'none';
    if (!visible.transit) { context.tooltip.close(); map.closePopup(); }
  }

  let lastStyleBucket = null;
  function update() {
    if (!map._loaded) return;
    const zoom = map.getZoom();
    const bounds = map.getBounds();
    const size = map.getSize();
    const dark = isDarkTheme();
    const zoomBucket = zoom < 11.5 ? 0 : zoom < 13 ? 1 : 2;
    const styleBucket = `${zoomBucket}:${dark}`;
    if (styleBucket !== lastStyleBucket) {
      lastStyleBucket = styleBucket;
      const detail = zoomBucket === 2;
      areasLayer.setStyle(feature => {
        const kind = feature.properties.kind;
        return kind === 'airport' ? { color: dark ? '#77718c' : '#9585ad', fillColor: dark ? '#3d3c57' : '#c3b9da' }
          : kind === 'reserve' ? { color: dark ? '#81765d' : '#af926b', fillColor: dark ? '#484333' : '#ded0b7' }
          : { color: dark ? '#416850' : '#80a777', fillColor: dark ? '#27483a' : '#a5c898' };
      });
      waterLayer.setStyle({ color: dark ? '#3e6976' : '#75a7b5', fillColor: dark ? '#234958' : '#a5cad4' });
      roads.forEach(({ layer, casing }) => layer.setStyle({ color: casing ? (dark ? '#20343a' : '#6d8275') : (dark ? '#637278' : '#fffff7'), weight: casing ? (detail ? 3.4 : 2.2) : (detail ? 1.8 : 1.1) }));
      railways.forEach(({ layer, casing }) => layer.setStyle({ color: casing ? (dark ? '#83918d' : '#65716e') : (dark ? '#20343a' : '#f5f6ed'), weight: casing ? (detail ? 2 : 1.2) : (detail ? 1.1 : .7), opacity: detail ? .75 : .42 }));
      const routeWeight = (lineId, future) => future ? (detail ? 2.3 : 1.6) : lineId === 'red' ? (detail ? 5 : 3.4) : (detail ? 3 : 2.1);
      routeCasings.forEach(({ layer, lineId, future }) => layer.setStyle({ color: dark ? '#14272e' : '#fffef7', weight: routeWeight(lineId, future) + (detail ? 1.8 : 1.2) }));
      routeLayers.forEach(({ layer, lineId, future }) => layer.setStyle({ color: future ? (dark ? '#668e70' : '#65a17b') : dark ? ({red:'#ee7d87',blue:'#74b9e9',green:'#7bbf8c'}[lineId]) : LINE_COLORS[lineId], weight: routeWeight(lineId, future) }));
      stationLayers.forEach(({ marker, shared, properties }) => {
        marker.setRadius(detail ? (shared ? 4.7 : 3.8) : (shared ? 3.1 : 2.4));
        const id = shared ? 'blue' : properties.lineIds?.[0] || 'green';
        marker.setStyle({color: dark ? ({red:'#ee7d87',blue:'#74b9e9',green:'#7bbf8c'}[id]) : LINE_COLORS[id], fillColor: shared ? (dark ? '#a25c67' : '#efb3b6') : (dark ? '#20343a' : '#fffef8')});
      });
    }
    // At overview scales, neighbouring downtown dots merge visually. Reveal them
    // progressively instead of drawing a dense string of overlapping targets.
    const stationPoints = [];
    for (const { marker, properties } of stationLayers) {
      const point = map.latLngToContainerPoint(marker.getLatLng());
      const minGap = zoom < 11.5 ? 13 : zoom < 13 ? 8 : 0;
      const shown = bounds.contains(marker.getLatLng()) && !stationPoints.some(p => Math.hypot(p.x - point.x, p.y - point.y) < minGap);
      if (shown) stationPoints.push(point);
      const element = marker.getElement();
      if (element) {
        element.style.display = shown ? '' : 'none';
        element.setAttribute('tabindex', shown ? '0' : '-1');
        element.setAttribute('aria-label', `${properties.name} · ${(properties.lineIds || []).map(lineName).join(' / ')} · ${t(statusName(properties.status))}`);
      }
    }
    roadLabels.clearLayers();
    stationLabels.clearLayers();
    landmarkLabels.clearLayers();
    labelBoxes.length = 0;
    const reserveBox = box => {
      if (box.x < 8 || box.y < 8 || box.x + box.w > size.x - 8 || box.y + box.h > size.y - 8) return false;
      if (labelBoxes.some(a => box.x < a.x + a.w + 9 && box.x + box.w + 9 > a.x && box.y < a.y + a.h + 6 && box.y + box.h + 6 > a.y)) return false;
      labelBoxes.push(box);
      return true;
    };
    let parksShown = 0;
    const candidates = [
      ...areaFeatures.filter(f => f.properties.kind !== 'park').map(feature => ({ feature, name: feature.properties.name, iconic: true })),
      ...parkLabelCandidates,
    ];
    if (visible.landmarks) for (const { feature, name, iconic } of candidates) {
      const p = feature.properties;
      if (p.kind === 'park') {
        if (zoom < 11 || (zoom < 13 && (!iconic || parksShown >= 3))) continue;
        if (zoom >= 13 && !iconic && !(p.areaHa >= 20)) continue;
      }
      const coordinates = p.labelPoint || p.centroid;
      const point = Array.isArray(coordinates) && coordinates.length >= 2
        ? L.latLng(coordinates[1], coordinates[0]) : L.geoJSON(feature).getBounds().getCenter();
      if (!bounds.contains(point)) continue;
      const pixel = map.latLngToContainerPoint(point);
      const text = p.kind === 'airport' ? 'YYC AIRPORT' : name;
      const width = p.kind === 'airport' ? 100 : p.kind === 'reserve' ? 150 : Math.min(140, text.length * 5.7);
      const height = 28;
      if (!reserveBox({ x: pixel.x - width / 2, y: pixel.y - height / 2, w: width, h: height })) continue;
      if (p.kind === 'park') parksShown++;
      L.marker(point, { pane: 'landmarkLabels', interactive: false, keyboard: false, icon: L.divIcon({ className: `landmark-label ${p.kind}-label`, html: `<span>${esc(text)}</span>`, iconSize: [width, height], iconAnchor: [width / 2, height / 2] }) }).addTo(landmarkLabels);
    }
    if (visible.transit && zoom >= 13) for (const feature of stations) {
      const [lng, lat] = feature.geometry.coordinates;
      if (!bounds.contains([lat, lng])) continue;
      const p = feature.properties;
      const point = map.latLngToContainerPoint([lat, lng]);
      const text = `${p.name}${p.status === 'operating' ? '' : currentLanguage() === 'en' ? ' · not in service' : ' · 未运营'}`;
      const width = Math.min(210, text.length * 5.8);
      if (!reserveBox({ x: point.x + 7, y: point.y - 8, w: width, h: 19 })) continue;
      L.marker([lat, lng], { pane: 'stationLabels', interactive: false, keyboard: false, icon: L.divIcon({ className: `station-label${p.status === 'operating' ? '' : ' future-station-label'}`, html: `<span>${esc(text)}</span>`, iconSize: [width, 20], iconAnchor: [-7, 8] }) }).addTo(stationLabels);
    }
    if (visible.roads && zoom >= 12) for (const feature of roadFeatures) {
      const point = midpoint(feature);
      if (!point || !bounds.contains([point[1], point[0]])) continue;
      const text = feature.properties.name;
      const pixel = map.latLngToContainerPoint([point[1], point[0]]);
      const width = Math.min(150, text.length * 5.4);
      if (!reserveBox({ x: pixel.x - width / 2, y: pixel.y - 8, w: width, h: 16 })) continue;
      L.marker([point[1], point[0]], { pane: 'roadLabels', interactive: false, keyboard: false, icon: L.divIcon({ className: 'road-label', html: `<span>${esc(text)}</span>`, iconSize: [width, 16], iconAnchor: [width / 2, 8] }) }).addTo(roadLabels);
    }
  }
  setVisible(visible);
  return { setVisible, update, labelBoxes, stationCount: stations.length };
}
