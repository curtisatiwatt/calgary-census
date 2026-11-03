import L from 'leaflet';
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
  return `<strong>${esc(properties.name)}</strong><span class="station-lines">${esc(names)}</span><span class="station-status${properties.status === 'operating' ? '' : ' future-status'}">${esc(statusName(properties.status))}</span>${properties.phaseLabel ? `<span class="station-phase">${esc(properties.phaseLabel)}${properties.funding === 'unfunded' ? ' · 远期规划 / 未获建设资金' : ''}</span>` : ''}${approximate ? '<span class="station-position-note">规划示意位置，非最终站位</span>' : ''}${properties.locationNote ? `<span class="station-position-note">${esc(properties.locationNote)}</span>` : ''}${properties.note ? `<span class="station-position-note">${esc(properties.note)}</span>` : ''}${source ? `<a class="station-source" href="${source}" target="_blank" rel="noopener noreferrer">官方线路资料 ↗</a>` : ''}`;
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
  const knownCommunities = new Set(communityNames.map(normalizeName));
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
  const stationLayers = [];
  const collection = items => ({ type: 'FeatureCollection', features: items });

  L.geoJSON(collection(areaFeatures), {
    pane: 'geography', interactive: false,
    style: feature => {
      const kind = feature.properties.kind;
      return kind === 'airport' ? { color: '#9585ad', weight: 1, opacity: .85, fillColor: '#c3b9da', fillOpacity: .64 }
        : kind === 'reserve' ? { color: '#af926b', weight: 1.4, dashArray: '5 4', opacity: .9, fillColor: '#ded0b7', fillOpacity: .6 }
          : { color: '#80a777', weight: .65, opacity: .75, fillColor: '#a5c898', fillOpacity: .58 };
    },
  }).addTo(map);
  L.geoJSON(basemap || collection([]), { filter: f => f.properties.kind === 'water', pane: 'water', interactive: false, style: { color: '#75a7b5', weight: .85, fillColor: '#a5cad4', fillOpacity: .9 } }).addTo(map);
  for (const casing of [true, false]) {
    const layer = L.geoJSON(collection(roadFeatures), { pane: 'roads', interactive: false, style: { color: casing ? '#6d8275' : '#fffff7', weight: casing ? 3.1 : 1.6, opacity: casing ? .55 : .96 } }).addTo(map);
    roads.push({ layer, casing });
  }
  for (const casing of [true, false]) {
    const layer = L.geoJSON(geography || collection([]), { filter: f => f.properties.kind === 'railway', pane: 'roads', interactive: false, style: { color: casing ? '#65716e' : '#f5f6ed', weight: casing ? 2.1 : 1.2, opacity: .85, dashArray: casing ? null : '7 5' } }).addTo(map);
    railways.push({ layer, casing });
  }
  // All casings are painted first so shared Red / Blue track retains both colours.
  for (const feature of routes) L.geoJSON(feature, { pane: 'transit', interactive: false, style: { color: '#fffef7', weight: feature.properties.funding === 'unfunded' ? 4.5 : feature.properties.lineId === 'red' ? 7.2 : 6.5, opacity: .92 } }).addTo(map);
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
    stationLayers.push({ marker, shared });
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
    const styleBucket = zoom >= 12;
    if (styleBucket !== lastStyleBucket) {
      lastStyleBucket = styleBucket;
    roads.forEach(({ layer, casing }) => layer.setStyle({ weight: casing ? (zoom >= 12 ? 3.8 : 2.9) : (zoom >= 12 ? 2 : 1.35) }));
    railways.forEach(({ layer, casing }) => layer.setStyle({ weight: casing ? (zoom >= 12 ? 2.5 : 1.8) : (zoom >= 12 ? 1.5 : 1) }));
    routeLayers.forEach(({ layer, lineId, future }) => layer.setStyle({ weight: future ? (zoom >= 12 ? 2.7 : 2) : lineId === 'red' ? (zoom >= 12 ? 5.8 : 4.7) : (zoom >= 12 ? 3.7 : 2.8) }));
    stationLayers.forEach(({ marker, shared }) => marker.setRadius(zoom >= 12 ? (shared ? 5.2 : 4.5) : (shared ? 3.8 : 3)));
    }
    roadLabels.clearLayers();
    stationLabels.clearLayers();
    landmarkLabels.clearLayers();
    if (zoom >= 12) for (const feature of roadFeatures) {
      const point = midpoint(feature);
      if (!point || !bounds.contains([point[1], point[0]])) continue;
      const text = feature.properties.name;
      L.marker([point[1], point[0]], { pane: 'roadLabels', interactive: false, keyboard: false, icon: L.divIcon({ className: 'road-label', html: `<span>${esc(text)}</span>`, iconSize: [140, 16], iconAnchor: [70, 8] }) }).addTo(roadLabels);
    }
    const occupied = [];
    if (zoom >= 11.75) for (const feature of stations) {
      const [lng, lat] = feature.geometry.coordinates;
      if (!bounds.contains([lat, lng])) continue;
      const p = feature.properties;
      const point = map.latLngToContainerPoint([lat, lng]);
      const width = Math.min(165, p.name.length * 5.1);
      // Downtown station labels are only thinned at medium zoom; every station dot stays visible.
      const box = { x: point.x + 7, y: point.y - 8, w: width, h: 17 };
      if (zoom < 14 && occupied.some(a => box.x < a.x + a.w && box.x + box.w > a.x && box.y < a.y + a.h && box.y + box.h > a.y)) continue;
      occupied.push(box);
      L.marker([lat, lng], { pane: 'stationLabels', interactive: false, keyboard: false, icon: L.divIcon({ className: `station-label${p.status === 'operating' ? '' : ' future-station-label'}`, html: `<span>${esc(p.name)}${p.status === 'operating' ? '' : ' · 未运营'}</span>`, iconSize: [width, 20], iconAnchor: [-7, 8] }) }).addTo(stationLabels);
    }
    const areaLabelsOccupied = [];
    let parksShown = 0;
    const candidates = [
      ...areaFeatures.filter(f => f.properties.kind !== 'park').map(feature => ({ feature, name: feature.properties.name, key: normalizeName(feature.properties.name), iconic: true })),
      ...parkLabelCandidates,
    ];
    for (const candidate of candidates) {
      const { feature, name, key, iconic } = candidate;
      const p = feature.properties;
      if (visible.communityLabels && (knownCommunities.has(key) || p.kind === 'airport')) continue;
      if (p.kind === 'park') {
        if (zoom < 13 && (!iconic || parksShown >= 6)) continue;
        if (zoom >= 13 && !iconic && !(p.areaHa >= 20)) continue;
      }
      const coordinates = p.labelPoint || p.centroid;
      let point;
      if (Array.isArray(coordinates) && coordinates.length >= 2) point = L.latLng(coordinates[1], coordinates[0]);
      else point = L.geoJSON(feature).getBounds().getCenter();
      if (!bounds.contains(point)) continue;
      const pixel = map.latLngToContainerPoint(point);
      const width = p.kind === 'airport' ? 185 : p.kind === 'reserve' ? 175 : 132;
      const height = 28;
      const box = { x: pixel.x - width / 2, y: pixel.y - height / 2, w: width, h: height };
      if (areaLabelsOccupied.some(a => box.x < a.x + a.w + 8 && box.x + box.w + 8 > a.x && box.y < a.y + a.h + 5 && box.y + box.h + 5 > a.y)) continue;
      areaLabelsOccupied.push(box);
      if (p.kind === 'park') parksShown++;
      const text = p.kind === 'airport' ? 'YYC · CALGARY INTERNATIONAL AIRPORT' : name;
      L.marker(point, { pane: 'landmarkLabels', interactive: false, keyboard: false, icon: L.divIcon({ className: `landmark-label ${p.kind}-label`, html: `<span>${esc(text)}</span>`, iconSize: [width, height], iconAnchor: [width / 2, height / 2] }) }).addTo(landmarkLabels);
    }
  }
  setVisible(visible);
  return { setVisible, update, stationCount: stations.length };
}
