import { addTranslations, currentLanguage, t } from './i18n.js';

addTranslations({
  '更多': 'More', '地图设置': 'Map settings', '关闭设置': 'Close settings',
  '图例': 'Legend', '关闭图例': 'Close legend', '查看详情': 'Details', '收起': 'Collapse',
  '全屏查看地图': 'Show full map', '语言': 'Language', '外观': 'Appearance',
});

const $ = id => document.getElementById(id);
let activeUI;

/** Insets describe the floating mobile UI, without changing the map's viewport. */
export function getMobileMapInsets() {
  return activeUI?.insets() || { top: 0, right: 0, bottom: 0, left: 0 };
}

export function initMobileUI({ onLayoutChange = () => {} } = {}) {
  const media = matchMedia('(max-width: 760px)');
  const sidebar = document.querySelector('.sidebar');
  const header = document.querySelector('.app-header');
  const viewbar = document.querySelector('.viewbar');
  const controls = document.querySelector('.view-controls');
  const pager = document.querySelector('.comparison-pager');
  const more = $('mobile-more-dialog');
  const legend = $('mobile-legend-dialog');
  const filters = $('mobile-filter-dialog');
  const portals = new Map();
  const city = document.querySelector('.brand strong').textContent.match(/Calgary|Edmonton/)?.[0] || '';
  const originalSearchPlaceholder = $('search').getAttribute('placeholder');
  let measured = { top: 0, right: 0, bottom: 0, left: 0 };
  let scheduled = 0;
  let moved = false;

  function move(node, destination) {
    if (!node || !destination) return;
    if (!portals.has(node)) {
      const marker = document.createComment('mobile control origin');
      node.before(marker);
      portals.set(node, marker);
    }
    destination.append(node);
  }
  function restore() {
    for (const [node, marker] of portals) marker.after(node);
  }
  function closeDialog(dialog) { if (dialog.open) dialog.close(); }
  function closeFilters() {
    if (!$('groups-panel').hidden) $('close-groups').click();
    if (!$('layers-panel').hidden) $('close-layers').click();
    closeDialog(filters);
  }
  function closeTransient() {
    closeDialog(more); closeDialog(legend); closeFilters();
  }
  function openDialog(dialog) {
    closeTransient();
    if (!dialog.open) dialog.showModal();
    $('mobile-more').setAttribute('aria-expanded', String(more.open));
    $('mobile-legend-button').setAttribute('aria-expanded', String(legend.open));
  }
  function syncFilterDialog() {
    if (!media.matches) return;
    const panel = !$('groups-panel').hidden ? $('groups-panel') : !$('layers-panel').hidden ? $('layers-panel') : null;
    if (!panel) return closeDialog(filters);
    closeDialog(more); closeDialog(legend);
    filters.setAttribute('aria-label', panel.getAttribute('aria-label') || '');
    if (!filters.open) {
      filters.showModal();
      (panel.id === 'groups-panel' ? $('close-groups') : $('close-layers')).focus({ preventScroll: true });
    }
  }
  function readInsets() {
    if (!media.matches) return { top: 0, right: 0, bottom: 0, left: 0 };
    const focused = document.body.classList.contains('map-focus');
    const top = focused ? 12 : Math.ceil(header.getBoundingClientRect().bottom + 8 + viewbar.getBoundingClientRect().height) + 10;
    const bottom = focused ? 0 : Math.ceil(sidebar.getBoundingClientRect().height);
    return { top, bottom: bottom + 14, left: 12, right: 12 };
  }
  function measure() {
    scheduled = 0;
    const focused = document.body.classList.contains('map-focus');
    if (!media.matches) {
      measured = { top: 0, right: 0, bottom: 0, left: 0 };
      return;
    }
    document.body.classList.toggle('mobile-extra-large', parseFloat(getComputedStyle(document.documentElement).fontSize) >= 28);
    const headerBottom = focused ? 0 : Math.ceil(header.getBoundingClientRect().bottom);
    document.documentElement.style.setProperty('--mobile-header-bottom', `${headerBottom}px`);
    const next = readInsets();
    const top = next.top;
    const bottom = next.bottom - 14;
    document.documentElement.style.setProperty('--mobile-ui-top', `${top}px`);
    document.documentElement.style.setProperty('--mobile-sheet-height', `${bottom}px`);
    if (Object.keys(next).some(key => next[key] !== measured[key])) {
      measured = next;
      onLayoutChange(next);
    }
  }
  function scheduleMeasure() {
    if (!scheduled) scheduled = requestAnimationFrame(measure);
  }
  function refresh() {
    const mobile = media.matches;
    const focused = document.body.classList.contains('map-focus');
    const comparing = document.querySelector('.map-workspace').classList.contains('comparing');
    document.body.classList.toggle('mobile-map-ui', mobile);
    document.body.classList.toggle('mobile-comparing', mobile && comparing);
    if (mobile && !moved) {
      moved = true;
      move(pager, controls);
      move($('income-control'), $('mobile-income-slot'));
      move($('groups-panel'), filters);
      move($('layers-panel'), filters);
      move($('language-toggle'), $('mobile-language-slot'));
      move($('theme-toggle'), $('mobile-theme-slot'));
      move($('method-button'), $('mobile-settings-content'));
      move($('composition-key'), $('mobile-composition-legend'));
      move($('income-legend'), $('mobile-composition-legend'));
      move($('transit-legend'), $('mobile-composition-legend'));
      move($('population-legend'), $('mobile-distribution-legend'));
    } else if (!mobile && moved) {
      closeTransient(); restore(); moved = false;
      $('search').placeholder = t(originalSearchPlaceholder);
    }
    if (mobile) {
      $('search').placeholder = currentLanguage() === 'en' ? `Search ${city}` : `搜索 ${city} 社区`;
      $('mobile-composition-legend').hidden = comparing;
      $('mobile-distribution-legend').hidden = !comparing;
      pager.hidden = !comparing;
    } else pager.hidden = false;
    for (const node of document.querySelectorAll('[data-mobile-text]')) node.textContent = t(node.dataset.mobileText);
    const binColors = [...$('population-ramp').children].map(node => node.style.background);
    document.querySelectorAll('.population-bin-labels>span').forEach((node, index) => node.style.setProperty('--bin-color', binColors[index] || '#ddd'));
    $('mobile-more').setAttribute('aria-label', t('地图设置'));
    $('mobile-more').setAttribute('aria-expanded', String(more.open));
    $('mobile-legend-button').setAttribute('aria-expanded', String(legend.open));
    $('mobile-detail-label').textContent = t(sidebar.classList.contains('collapsed') ? '查看详情' : '收起');
    $('mobile-detail-handle').setAttribute('aria-label', `${t(sidebar.classList.contains('collapsed') ? '查看详情' : '收起')} · ${$('community-name').textContent}`);
    syncFilterDialog();
    scheduleMeasure();
  }

  $('mobile-more').addEventListener('click', () => openDialog(more));
  $('mobile-legend-button').addEventListener('click', () => openDialog(legend));
  $('close-mobile-more').addEventListener('click', () => closeDialog(more));
  $('close-mobile-legend').addEventListener('click', () => closeDialog(legend));
  $('mobile-full-map').addEventListener('click', () => { closeDialog(more); $('focus-map').click(); });
  $('method-button').addEventListener('click', () => closeDialog(more), true);
  for (const dialog of [more, legend, filters]) {
    dialog.addEventListener('close', () => {
      if (dialog === filters) closeFilters();
      refresh();
    });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) {
        if (dialog === filters) closeFilters(); else closeDialog(dialog);
      }
    });
  }
  filters.addEventListener('cancel', event => { event.preventDefault(); closeFilters(); });
  const layoutObserver = new ResizeObserver(scheduleMeasure);
  for (const node of [header, viewbar, sidebar]) layoutObserver.observe(node);
  const stateObserver = new MutationObserver(refresh);
  stateObserver.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
  stateObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  stateObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  stateObserver.observe(document.querySelector('.map-workspace'), { attributes: true, attributeFilter: ['class'] });
  for (const panel of [$('groups-panel'), $('layers-panel')]) stateObserver.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  media.addEventListener('change', refresh);
  activeUI = { insets: readInsets };
  refresh();
  return { refresh, closeTransient };
}
