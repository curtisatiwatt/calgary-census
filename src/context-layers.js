import L from 'leaflet';
import { t, currentLanguage, localizeHtml } from './i18n.js';
import { isDarkTheme } from './theme.js';
import { escapeHtml as esc, safeUrl, ARROW_DIRECTIONS, nearestInDirection } from './map-utils.js';
import {
  displayMapName,
  groupRoadLabels,
  roadPriority,
  visibleLineAnchors,
  visibleWaterAnchors,
} from './label-placement.js';

export const LINE_COLORS = Object.freeze({ red: '#ca3544', blue: '#2879bd', green: '#22834b' });
const lineName = id => ({ red: 'Red Line', blue: 'Blue Line', green: 'Green Line' })[id] || id;
const statusName = status =>
  ({ operating: '运营中', construction: '建设中 · 未运营', planned: '规划中 · 未运营' })[status] || '未运营';
const stationLabel = p => `${p.name} · ${(p.lineIds || []).map(lineName).join(' / ')} · ${t(statusName(p.status))}`;
const features = data => (data?.type === 'FeatureCollection' && Array.isArray(data.features) ? data.features : []);

export function stationContent(properties) {
  const names = (properties.lineIds || []).map(lineName).join(' / ');
  const approximate = properties.geometryQuality === 'approximate' || properties.geometryQuality === 'schematic';
  const source = safeUrl(properties.sourceUrl);
  return localizeHtml(
    `<strong>${esc(properties.name)}</strong><span class="station-lines">${esc(names)}</span><span class="station-status${properties.status === 'operating' ? '' : ' future-status'}">${esc(statusName(properties.status))}</span>${properties.phaseLabel ? `<span class="station-phase">${esc(properties.funding === 'unfunded' ? t('station.unfunded', { phase: t(properties.phaseLabel) }) : properties.phaseLabel)}</span>` : ''}${approximate ? '<span class="station-position-note">规划示意位置，非最终站位</span>' : ''}${properties.locationNote ? `<span class="station-position-note">${esc(properties.locationNote)}</span>` : ''}${properties.note ? `<span class="station-position-note">${esc(properties.note)}</span>` : ''}${source ? `<a class="station-source" href="${source}" target="_blank" rel="noopener noreferrer">官方线路资料 ↗</a>` : ''}`,
  );
}

/**
 * Context geometry never changes census statistics or the heat-map scale.
 * Each dataset is attached when it arrives (setBasemap, setRailways,
 * setLandmarks, setTransit), so the census map never waits for context layers.
 */
export function createContextLayers({ context, visible, onStationOpen, getLabelObstacles, getFocusPadding }) {
  const map = context.map;
  const definitions = [
    ['geography', 405],
    ['water', 410],
    ['roads', 420],
    ['roadLabels', 460],
    ['waterLabels', 465],
    ['transit', 440],
    ['stations', 480],
    ['stationLabels', 485],
    ['landmarkLabels', 490],
  ];
  for (const [name, zIndex] of definitions) {
    if (!map.getPane(name)) map.createPane(name);
    const pane = map.getPane(name);
    pane.style.zIndex = zIndex;
    if (name !== 'stations') pane.style.pointerEvents = 'none';
  }
  const roadLabels = L.layerGroup().addTo(map);
  const waterLabels = L.layerGroup().addTo(map);
  const stationLabels = L.layerGroup().addTo(map);
  const landmarkLabels = L.layerGroup().addTo(map);
  const project = coordinate => map.latLngToContainerPoint([coordinate[1], coordinate[0]]);
  function waterPriority(name) {
    return /river/i.test(name) ? 4 : /reservoir/i.test(name) ? 3 : /creek/i.test(name) ? 2 : 1;
  }
  const normalizeName = name =>
    String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const iconicParks = new Set([
    'nosehillpark',
    'fishcreekpark',
    'northglenmorepark',
    'southglenmorepark',
    'bownesspark',
    'princesislandpark',
  ]);
  let stations = [];
  let roadLabelGroups = [];
  let waterFeatures = [];
  let orientationFeatures = [];
  let areaFeatures = [];
  let parkLabelCandidates = [];
  let areasLayer = null;
  let waterLayer = null;
  const roads = [];
  const railways = [];
  const routeLayers = [];
  const routeCasings = [];
  const stationLayers = [];
  // All stations share one tab stop; arrow keys move it from station to station.
  let focusStationId = null;
  const labelBoxes = [];
  const collection = items => ({ type: 'FeatureCollection', features: items });
  const textMeasure = document.createElement('canvas').getContext('2d');
  const loaded = { basemap: false, railways: false, landmarks: false, transit: false };
  // Decorative, non-interactive geometry is drawn on one canvas per pane rather
  // than as thousands of SVG nodes. Communities and stations stay SVG for
  // pointer, keyboard and screen-reader access.
  const renderers = {};
  const canvas = pane => (renderers[pane] ||= L.canvas({ pane, padding: 0.5 }));
  // Hidden layer groups are removed from the map so they are not redrawn on zoom.
  const groups = { roads: L.layerGroup(), transit: L.layerGroup(), landmarks: L.layerGroup() };

  function roadStyle(feature, casing, zoomBucket, dark) {
    const priority = roadPriority(feature.properties);
    const primary = priority >= 3;
    const inner =
      zoomBucket === 2 ? (primary ? 3.4 : 2.2) : zoomBucket === 1 ? (primary ? 2.2 : 1.5) : primary ? 1.6 : 0.9;
    return {
      color: casing
        ? dark
          ? '#15212c'
          : primary
            ? '#818b94'
            : '#9da5aa'
        : dark
          ? primary
            ? '#a2b2bf'
            : '#7f929f'
          : '#ffffff',
      weight: inner + (casing ? (zoomBucket === 2 ? 1.6 : 1.1) : 0),
      opacity: casing ? 0.9 : 1,
      lineCap: 'round',
      lineJoin: 'round',
    };
  }

  // Newly attached layers receive the current zoom/theme styling on the next update.
  function attached() {
    lastStyleBucket = null;
    update();
  }

  function setBasemap(basemap) {
    if (loaded.basemap || !features(basemap).length) return;
    loaded.basemap = true;
    const roadFeatures = features(basemap).filter(f => f.properties.kind === 'road');
    roadLabelGroups = groupRoadLabels(roadFeatures);
    waterFeatures = features(basemap)
      .filter(
        f =>
          f.properties.kind === 'water' &&
          f.properties.name &&
          !/facility|storm.?water|management|industrial|energy park|pond [0-9]/i.test(f.properties.name),
      )
      .sort((a, b) => waterPriority(b.properties.name) - waterPriority(a.properties.name));
    waterLayer = L.geoJSON(basemap, {
      filter: f => f.properties.kind === 'water',
      pane: 'water',
      renderer: canvas('water'),
      interactive: false,
      style: { color: '#75a7b5', weight: 0.85, fillColor: '#a5cad4', fillOpacity: 0.9 },
    }).addTo(map);
    for (const casing of [true, false]) {
      const layer = L.geoJSON(collection(roadFeatures), {
        pane: 'roads',
        renderer: canvas('roads'),
        interactive: false,
        style: feature => roadStyle(feature, casing, 0, isDarkTheme()),
      }).addTo(groups.roads);
      roads.push({ layer, casing });
    }
    attached();
  }

  function setRailways(data) {
    const tracks = features(data).filter(f => f.properties.kind === 'railway');
    if (loaded.railways || !tracks.length) return;
    loaded.railways = true;
    for (const casing of [true, false]) {
      const layer = L.geoJSON(collection(tracks), {
        pane: 'roads',
        renderer: canvas('roads'),
        interactive: false,
        style: {
          color: casing ? '#65716e' : '#f5f6ed',
          weight: casing ? 2.1 : 1.2,
          opacity: 0.85,
          dashArray: casing ? null : '7 5',
        },
      }).addTo(groups.roads);
      railways.push({ layer, casing });
    }
    attached();
  }

  function setLandmarks(geography, orientationLandmarks) {
    if (loaded.landmarks) return;
    loaded.landmarks = true;
    areaFeatures = features(geography).filter(f => ['airport', 'park', 'reserve'].includes(f.properties.kind));
    orientationFeatures = features(orientationLandmarks)
      .filter(f => f.properties.kind === 'orientation_landmark' && f.geometry?.type === 'Point' && f.properties.name)
      .sort((a, b) => (b.properties.priority || 0) - (a.properties.priority || 0));
    const parkLabelsByName = new Map();
    for (const feature of areaFeatures.filter(f => f.properties.kind === 'park' && f.properties.named !== false)) {
      const p = feature.properties;
      // A single descriptive park label, not depot/school/parcel names from the same site.
      const name = String(p.name || '')
        .split(';')
        .map(part => part.trim())
        .find(part => /\bpark\b|natural area|sanctuary|wetland|garden|ravine/i.test(part));
      if (!name) continue;
      const key = normalizeName(name);
      const existing = parkLabelsByName.get(key);
      if (!existing || (p.areaHa || 0) > (existing.feature.properties.areaHa || 0))
        parkLabelsByName.set(key, { feature, name, key, iconic: iconicParks.has(key) });
    }
    parkLabelCandidates = [...parkLabelsByName.values()].sort(
      (a, b) =>
        Number(b.iconic) - Number(a.iconic) || (b.feature.properties.areaHa || 0) - (a.feature.properties.areaHa || 0),
    );
    areasLayer = L.geoJSON(collection(areaFeatures), {
      pane: 'geography',
      renderer: canvas('geography'),
      interactive: false,
      style: feature => {
        const kind = feature.properties.kind;
        return kind === 'airport'
          ? { color: '#9585ad', weight: 0.8, opacity: 0.55, fillColor: '#c3b9da', fillOpacity: 0.42 }
          : kind === 'reserve'
            ? { color: '#af926b', weight: 1, dashArray: '5 4', opacity: 0.6, fillColor: '#ded0b7', fillOpacity: 0.35 }
            : { color: '#80a777', weight: 0.4, opacity: 0.4, fillColor: '#a5c898', fillOpacity: 0.42 };
      },
    }).addTo(groups.landmarks);
    attached();
  }

  function setTransit(operatingTransit, greenTransit) {
    if (loaded.transit) return;
    loaded.transit = true;
    const transitFeatures = [...features(operatingTransit), ...features(greenTransit)];
    const routes = transitFeatures.filter(f => f.properties.kind === 'transit_route');
    stations = transitFeatures.filter(f => f.properties.kind === 'transit_station' && f.geometry?.type === 'Point');
    // All casings are painted first so shared Red / Blue track retains both colours.
    for (const feature of routes) {
      const layer = L.geoJSON(feature, {
        pane: 'transit',
        renderer: canvas('transit'),
        interactive: false,
        style: { color: '#fffef7', weight: 4, opacity: 0.8 },
      }).addTo(groups.transit);
      routeCasings.push({
        layer,
        lineId: feature.properties.lineId,
        future: feature.properties.funding === 'unfunded',
      });
    }
    for (const lineId of ['red', 'blue', 'green']) {
      for (const feature of routes.filter(f => f.properties.lineId === lineId)) {
        const future = feature.properties.funding === 'unfunded';
        const layer = L.geoJSON(feature, {
          pane: 'transit',
          renderer: canvas('transit'),
          interactive: false,
          style: {
            color: future ? '#65a17b' : LINE_COLORS[lineId],
            weight: future ? 2.2 : lineId === 'red' ? 5.2 : 3.1,
            opacity: future ? 0.82 : 0.94,
            dashArray: future ? '3 6' : lineId === 'green' ? '7 6' : null,
            lineCap: 'round',
            lineJoin: 'round',
          },
        }).addTo(groups.transit);
        routeLayers.push({ layer, lineId, future });
      }
    }
    for (const feature of stations) {
      const p = feature.properties;
      const ids = p.lineIds || [];
      const shared = ids.includes('red') && ids.includes('blue');
      const color = p.funding === 'unfunded' ? '#65a17b' : LINE_COLORS[ids[0]] || LINE_COLORS.green;
      const future = p.status !== 'operating';
      const marker = L.circleMarker([feature.geometry.coordinates[1], feature.geometry.coordinates[0]], {
        pane: 'stations',
        className: 'transit-station',
        radius: shared ? 4.7 : 3.7,
        color: shared ? LINE_COLORS.blue : color,
        weight: 1.9,
        fillColor: shared ? '#efb3b6' : '#fffef8',
        fillOpacity: 1,
        dashArray: future ? '2 2' : null,
        bubblingMouseEvents: false,
      }).addTo(map);
      const open = ({ keyboard = false } = {}) => {
        onStationOpen?.();
        context.tooltip.close();
        const popup = L.popup({
          className: 'station-popup',
          maxWidth: 280,
          autoPan: true,
          autoPanPaddingTopLeft: [12, 48],
          autoPanPaddingBottomRight: [12, window.matchMedia('(max-width: 760px)').matches ? 145 : 24],
          closeButton: true,
          autoClose: true,
          closeOnClick: true,
        })
          .setLatLng(marker.getLatLng())
          .setContent(stationContent(p))
          .openOn(map);
        const box = popup.getElement();
        box?.querySelector('.leaflet-popup-close-button')?.setAttribute('aria-label', t('关闭站点信息'));
        const content = box?.querySelector('.leaflet-popup-content');
        if (!keyboard || !content) return;
        // Opened from the keyboard: focus goes into the popup, so its link and close
        // button are the next tab stops, and comes back to the station when it closes.
        content.setAttribute('tabindex', '-1');
        content.focus({ preventScroll: true });
        popup.once('remove', () => {
          const active = document.activeElement;
          if (!active || active === document.body || box.contains(active))
            marker.getElement()?.focus({ preventScroll: true });
        });
      };
      marker.on('click', () => open());
      // Keys are handled once for the whole pane (below); updateStations() decides the tab stop.
      const describe = () => {
        const element = marker.getElement();
        element?.setAttribute('data-station-id', p.id);
        element?.setAttribute('aria-label', stationLabel(p));
        element?.setAttribute('tabindex', '-1');
        element?.setAttribute('role', 'button');
      };
      marker.on('add', describe);
      describe();
      context.tooltip.bind(marker, {
        content: () => stationContent(p),
        anchor: () => marker.getLatLng(),
        offset: [0, -8],
      });
      stationLayers.push({ marker, shared, properties: p, open, shown: false });
    }
    attached();
  }

  const stationFor = event => {
    const id = event.target.closest?.('[data-station-id]')?.dataset.stationId;
    return stationLayers.find(entry => String(entry.properties.id) === id);
  };
  const stationsPane = map.getPane('stations');
  stationsPane.addEventListener('focusin', event => {
    const entry = stationFor(event);
    if (entry) focusStationId = entry.properties.id;
  });
  stationsPane.addEventListener('keydown', event => {
    const entry = stationFor(event);
    if (!entry) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      entry.open({ keyboard: true });
      return;
    }
    const direction = ARROW_DIRECTIONS[event.key];
    if (!direction) return;
    // Arrows move between stations instead of panning the map.
    event.preventDefault();
    event.stopPropagation();
    const point = station => map.latLngToContainerPoint(station.marker.getLatLng());
    const others = stationLayers.filter(station => station !== entry);
    const next = others[nearestInDirection(point(entry), others.map(point), direction)];
    if (!next) return;
    focusStationId = next.properties.id;
    map.panInside(next.marker.getLatLng(), { ...(getFocusPadding?.() || {}), animate: false });
    updateStations();
    next.marker.getElement()?.focus({ preventScroll: true });
  });

  /**
   * At overview scales, neighbouring downtown dots merge visually: reveal them
   * progressively instead of drawing a dense string of overlapping targets.
   * Exactly one visible station is the tab stop (the one last focused, if shown).
   */
  function updateStations() {
    const zoom = map.getZoom();
    const bounds = map.getBounds();
    const minGap = zoom < 11.5 ? 13 : zoom < 13 ? 8 : 0;
    const placed = [];
    // The station holding keyboard focus is placed first, so decluttering never hides it.
    const ordered = [...stationLayers].sort(
      (a, b) => Number(b.properties.id === focusStationId) - Number(a.properties.id === focusStationId),
    );
    for (const entry of ordered) {
      const point = map.latLngToContainerPoint(entry.marker.getLatLng());
      entry.shown =
        bounds.contains(entry.marker.getLatLng()) &&
        !placed.some(other => Math.hypot(other.x - point.x, other.y - point.y) < minGap);
      if (entry.shown) placed.push(point);
    }
    const stop =
      stationLayers.find(entry => entry.shown && entry.properties.id === focusStationId) ||
      stationLayers.find(entry => entry.shown);
    for (const entry of stationLayers) {
      const element = entry.marker.getElement();
      if (!element) continue;
      element.style.display = entry.shown ? '' : 'none';
      element.setAttribute('tabindex', entry === stop ? '0' : '-1');
      element.setAttribute('aria-label', stationLabel(entry.properties));
    }
  }

  function setVisible(next) {
    visible = { ...visible, ...next };
    for (const name of ['roads', 'roadLabels']) map.getPane(name).style.display = visible.roads ? '' : 'none';
    for (const name of ['transit', 'stations', 'stationLabels'])
      map.getPane(name).style.display = visible.transit ? '' : 'none';
    for (const name of ['geography', 'landmarkLabels'])
      map.getPane(name).style.display = visible.landmarks ? '' : 'none';
    for (const [name, group] of Object.entries(groups)) {
      if (visible[name] && !map.hasLayer(group)) group.addTo(map);
      else if (!visible[name] && map.hasLayer(group)) map.removeLayer(group);
    }
    if (!visible.transit) {
      context.tooltip.close();
      map.closePopup();
    }
  }

  let lastStyleBucket = null;
  function update() {
    if (!map._loaded) return;
    const zoom = map.getZoom();
    const bounds = map.getBounds();
    const size = map.getSize();
    const dark = isDarkTheme();
    // Match rem-based map fonts, including an enlarged browser/system text size.
    // Collision boxes use measured glyph widths instead of the old 9px estimate.
    const rootStyle = getComputedStyle(document.documentElement);
    const textScale = (parseFloat(rootStyle.fontSize) || 16) / 16;
    const family = getComputedStyle(map.getContainer()).fontFamily;
    const measureLabel = (text, size = 12, extra = 0) => {
      const fontSize = size * textScale;
      if (textMeasure) textMeasure.font = `500 ${fontSize}px ${family}`;
      return {
        width: Math.ceil((textMeasure?.measureText(text).width ?? text.length * fontSize * 0.62) + 4 + extra),
        height: Math.ceil(fontSize * 1.4),
      };
    };
    const zoomBucket = zoom < 11.5 ? 0 : zoom < 13 ? 1 : 2;
    const styleBucket = `${zoomBucket}:${dark}`;
    if (styleBucket !== lastStyleBucket) {
      lastStyleBucket = styleBucket;
      const detail = zoomBucket === 2;
      areasLayer?.setStyle(feature => {
        const kind = feature.properties.kind;
        return kind === 'airport'
          ? { color: dark ? '#77718c' : '#9585ad', fillColor: dark ? '#3d3c57' : '#c3b9da' }
          : kind === 'reserve'
            ? { color: dark ? '#81765d' : '#af926b', fillColor: dark ? '#484333' : '#ded0b7' }
            : { color: dark ? '#416850' : '#80a777', fillColor: dark ? '#27483a' : '#a5c898' };
      });
      waterLayer?.setStyle({
        color: dark ? '#648caa' : '#648fa9',
        weight: 0.9,
        fillColor: dark ? '#294d68' : '#acd2e3',
      });
      roads.forEach(({ layer, casing }) => layer.setStyle(feature => roadStyle(feature, casing, zoomBucket, dark)));
      railways.forEach(({ layer, casing }) =>
        layer.setStyle({
          color: casing ? (dark ? '#83918d' : '#65716e') : dark ? '#20343a' : '#f5f6ed',
          weight: casing ? (detail ? 1.6 : 1) : detail ? 0.9 : 0.6,
          opacity: detail ? 0.6 : 0.32,
        }),
      );
      const routeWeight = (lineId, future) =>
        future ? (detail ? 2.3 : 1.6) : lineId === 'red' ? (detail ? 5 : 3.4) : detail ? 3 : 2.1;
      routeCasings.forEach(({ layer, lineId, future }) =>
        layer.setStyle({
          color: dark ? '#14272e' : '#fffef7',
          weight: routeWeight(lineId, future) + (detail ? 1.8 : 1.2),
        }),
      );
      routeLayers.forEach(({ layer, lineId, future }) =>
        layer.setStyle({
          color: future
            ? dark
              ? '#668e70'
              : '#65a17b'
            : dark
              ? { red: '#ee7d87', blue: '#74b9e9', green: '#7bbf8c' }[lineId]
              : LINE_COLORS[lineId],
          weight: routeWeight(lineId, future),
        }),
      );
      stationLayers.forEach(({ marker, shared, properties }) => {
        marker.setRadius(detail ? (shared ? 4.7 : 3.8) : shared ? 3.1 : 2.4);
        const id = shared ? 'blue' : properties.lineIds?.[0] || 'green';
        marker.setStyle({
          color: dark ? { red: '#ee7d87', blue: '#74b9e9', green: '#7bbf8c' }[id] : LINE_COLORS[id],
          fillColor: shared ? (dark ? '#a25c67' : '#efb3b6') : dark ? '#20343a' : '#fffef8',
        });
      });
    }
    updateStations();
    roadLabels.clearLayers();
    waterLabels.clearLayers();
    stationLabels.clearLayers();
    landmarkLabels.clearLayers();
    labelBoxes.length = 0;
    labelBoxes.push(...(getLabelObstacles?.() || []));
    const reserveBox = box => {
      if (box.x < 8 || box.y < 8 || box.x + box.w > size.x - 8 || box.y + box.h > size.y - 8) return false;
      if (
        labelBoxes.some(
          a => box.x < a.x + a.w + 9 && box.x + box.w + 9 > a.x && box.y < a.y + a.h + 6 && box.y + box.h + 6 > a.y,
        )
      )
        return false;
      labelBoxes.push(box);
      return true;
    };
    // Geographic names use the portion currently on screen, not a fixed city-wide midpoint.
    // Reserve their boxes before community labels are placed by the main renderer.
    let watersShown = 0;
    const placedWaterNames = new Set();
    const waterLimit = zoom < 13 ? 2 : 4;
    for (const feature of waterFeatures) {
      const waterNameKey = normalizeName(feature.properties.name);
      if (placedWaterNames.has(waterNameKey)) continue;
      const priority = waterPriority(feature.properties.name);
      if (zoom < (priority === 4 ? 11 : priority === 3 ? 11.5 : 13) || watersShown >= waterLimit) continue;
      const text = displayMapName(feature.properties.name);
      const { width, height } = measureLabel(text);
      const pixel = visibleWaterAnchors(feature.geometry, project, size, width).find(point =>
        reserveBox({ x: point.x - width / 2, y: point.y - height / 2, w: width, h: height }),
      );
      if (!pixel) continue;
      watersShown++;
      placedWaterNames.add(waterNameKey);
      L.marker(map.containerPointToLatLng([pixel.x, pixel.y]), {
        pane: 'waterLabels',
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: 'water-label',
          html: `<span>${esc(text)}</span>`,
          iconSize: [width, height],
          iconAnchor: [width / 2, height / 2],
        }),
      }).addTo(waterLabels);
    }
    let placesShown = 0;
    const placedPlaceNames = [];
    const placeLimit = Math.min(6, Math.max(2, Math.floor((size.x * size.y) / 170000)));
    if (visible.landmarks)
      for (const feature of orientationFeatures) {
        const p = feature.properties;
        if (zoom < (p.minZoom || 12) || placesShown >= placeLimit) continue;
        const [lng, lat] = feature.geometry.coordinates;
        if (!bounds.contains([lat, lng])) continue;
        const pixel = project([lng, lat]);
        const { width, height } = measureLabel(p.name, 12, 10);
        if (!reserveBox({ x: pixel.x - 3, y: pixel.y - height / 2, w: width, h: height })) continue;
        placesShown++;
        placedPlaceNames.push(normalizeName(p.name));
        L.marker([lat, lng], {
          pane: 'landmarkLabels',
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: 'orientation-label',
            html: `<span>${esc(p.name)}</span>`,
            iconSize: [width, height],
            iconAnchor: [3, height / 2],
          }),
        }).addTo(landmarkLabels);
      }
    let parksShown = 0;
    const candidates = [
      ...areaFeatures
        .filter(f => f.properties.kind !== 'park')
        .map(feature => ({ feature, name: feature.properties.name, iconic: true })),
      ...parkLabelCandidates,
    ];
    if (visible.landmarks)
      for (const { feature, name, iconic } of candidates) {
        const p = feature.properties;
        if (p.kind === 'park') {
          const parkKey = normalizeName(name);
          if (
            placedPlaceNames.some(
              key =>
                key === parkKey ||
                (Math.min(key.length, parkKey.length) >= 10 && (key.startsWith(parkKey) || parkKey.startsWith(key))),
            )
          )
            continue;
          if (zoom < 11 || (zoom < 13 && (!iconic || parksShown >= 3))) continue;
          if (zoom >= 13 && !iconic && !(p.areaHa >= 20)) continue;
        }
        const coordinates = p.labelPoint || p.centroid;
        const point =
          Array.isArray(coordinates) && coordinates.length >= 2
            ? L.latLng(coordinates[1], coordinates[0])
            : L.geoJSON(feature).getBounds().getCenter();
        if (!bounds.contains(point)) continue;
        const pixel = map.latLngToContainerPoint(point);
        const text = p.kind === 'airport' ? 'YYC AIRPORT' : name;
        const { width, height } = measureLabel(text, 11);
        if (!reserveBox({ x: pixel.x - width / 2, y: pixel.y - height / 2, w: width, h: height })) continue;
        if (p.kind === 'park') parksShown++;
        L.marker(point, {
          pane: 'landmarkLabels',
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: `landmark-label ${p.kind}-label`,
            html: `<span>${esc(text)}</span>`,
            iconSize: [width, height],
            iconAnchor: [width / 2, height / 2],
          }),
        }).addTo(landmarkLabels);
      }
    let roadsShown = 0;
    const roadLimit = Math.min(
      zoom < 13 ? 10 : zoom < 14 ? 18 : 25,
      Math.max(3, Math.floor((size.x * size.y) / ((zoom < 13 ? 85000 : 60000) * textScale))),
    );
    if (visible.roads && zoom >= 12)
      for (const group of roadLabelGroups) {
        if (roadsShown >= roadLimit) break;
        if (zoom < 13 && group.priority < 2) continue;
        const { width, height } = measureLabel(group.name);
        const pixel = visibleLineAnchors(group.lines, project, size, width).find(point =>
          reserveBox({ x: point.x - width / 2, y: point.y - height / 2, w: width, h: height }),
        );
        if (!pixel) continue;
        roadsShown++;
        L.marker(map.containerPointToLatLng([pixel.x, pixel.y]), {
          pane: 'roadLabels',
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: 'road-label',
            html: `<span>${esc(group.name)}</span>`,
            iconSize: [width, height],
            iconAnchor: [width / 2, height / 2],
          }),
        }).addTo(roadLabels);
      }
    if (visible.transit && zoom >= 13)
      for (const feature of stations) {
        const [lng, lat] = feature.geometry.coordinates;
        if (!bounds.contains([lat, lng])) continue;
        const p = feature.properties;
        const point = map.latLngToContainerPoint([lat, lng]);
        const text = `${p.name}${p.status === 'operating' ? '' : currentLanguage() === 'en' ? ' · not in service' : ' · 未运营'}`;
        const { width, height } = measureLabel(text, 11);
        if (!reserveBox({ x: point.x + 7, y: point.y - height / 2, w: width, h: height })) continue;
        L.marker([lat, lng], {
          pane: 'stationLabels',
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: `station-label${p.status === 'operating' ? '' : ' future-station-label'}`,
            html: `<span>${esc(text)}</span>`,
            iconSize: [width, height],
            iconAnchor: [-7, height / 2],
          }),
        }).addTo(stationLabels);
      }
  }
  setVisible(visible);
  return { setVisible, update, labelBoxes, setBasemap, setRailways, setLandmarks, setTransit, loaded };
}
