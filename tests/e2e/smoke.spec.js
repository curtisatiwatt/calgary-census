import { test, expect } from '@playwright/test';

const HAN = /[一-鿿]/;

/** Load the map and fail the test on any page error or console error. */
async function openMap(page, hash = '') {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`./${hash ? `#${hash}` : ''}`);
  await expect(page.locator('#loading-overlay')).toBeHidden();
  await expect(page.locator('#composition-map path[data-community]')).toHaveCount(313);
  return errors;
}

/** Visible text and labels outside elements intentionally marked as Chinese. */
async function untranslatedText(page) {
  return page.evaluate(source => {
    const han = new RegExp(source);
    const found = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      if (!element || element.closest('script, style, noscript, [lang^="zh"], #language-preference')) continue;
      const values =
        node.nodeType === Node.TEXT_NODE
          ? [node.nodeValue]
          : ['aria-label', 'title', 'placeholder', 'alt'].map(name => node.getAttribute(name)).filter(Boolean);
      for (const value of values) if (han.test(value) || /\{\w+\}/.test(value)) found.push(value.trim().slice(0, 80));
    }
    return found;
  }, HAN.source);
}

// Every helper below drives the controls the way a person does (real pointer and
// keyboard input through locators), so a control that is hidden, covered by a
// panel or disabled fails the test instead of being clicked through script.

/** Phones keep the view tabs, filters and preferences in the menu; desktop shows them in the rail. */
async function openMenu(page, isMobile) {
  if (isMobile) await page.locator('#mobile-more').click();
}

async function switchView(page, isMobile, view) {
  await openMenu(page, isMobile);
  await page.locator(`#${view}-tab`).click();
  await expect(page.locator(`#${view}-view`)).toBeVisible();
}

async function setLayer(page, isMobile, layer, on) {
  await openMenu(page, isMobile);
  await page.locator('#layers-button').click();
  await page.locator(`#${layer}-toggle`).setChecked(on);
  await page.locator('#close-layers').click();
  await expect(page.locator('#layers-panel')).toBeHidden();
}

/** Change the language or appearance select (`language-preference` / `theme-preference`). */
async function setPreference(page, isMobile, id, value) {
  await openMenu(page, isMobile);
  await page.locator(`#${id}`).selectOption(value);
  if (isMobile) await page.locator('#close-mobile-more').click();
}

/** Select the five largest groups through the real controls on either layout. */
async function chooseTopFive(page, isMobile) {
  await openMenu(page, isMobile);
  await page.locator('#groups-button').click();
  await page.locator('#default-groups').click();
  await expect(page.locator('#group-count')).toHaveText('5');
  if (isMobile) await page.locator('#close-groups').click();
  else await page.keyboard.press('Escape');
  // Escape must work even while the desktop legend card (a non-modal dialog) is open.
  await expect(page.locator('#groups-panel')).toBeHidden();
}

test('the census map loads in English with no errors or untranslated text', async ({ page }) => {
  const errors = await openMap(page);
  await expect(page.locator('#search')).toHaveAttribute('placeholder', 'Search Calgary communities');
  expect(await untranslatedText(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('optional layers load on demand', async ({ page, isMobile }) => {
  const requested = [];
  page.on('request', request => requested.push(new URL(request.url()).pathname.split('/').pop()));
  await openMap(page);
  await expect.poll(() => requested.includes('basemap.geojson')).toBe(true);
  expect(requested).not.toContain('ctrain-operating.geojson');
  expect(requested).not.toContain('geographic-context.geojson');
  await setLayer(page, isMobile, 'transit', true);
  await expect(page.locator('[data-station-id]').first()).toBeAttached();
  expect(requested).toContain('ctrain-operating.geojson');
});

test('a layer that fails to load is named in a readable warning until it is switched off', async ({
  page,
  isMobile,
}) => {
  await page.route('**/ctrain-operating.geojson', route => route.fulfill({ status: 404, body: 'missing' }));
  // The 404 is logged by the browser, so this test does not use openMap's error check.
  await page.goto('./#?groups=chinese&layers=transit');
  await expect(page.locator('#loading-overlay')).toBeHidden();
  const warning = page.locator('#map-warning');
  await expect(warning).toHaveText('CTrain lines & stations could not load. Community statistics are still available.');
  // Nothing (the legend card in particular) lies on top of the message.
  const covered = await warning.evaluate(node => {
    const box = node.getBoundingClientRect();
    let hidden = 0;
    for (let x = box.left + 8; x < box.right - 8; x += 16)
      if (document.elementFromPoint(x, box.top + box.height / 2) !== node) hidden++;
    return hidden;
  });
  expect(covered).toBe(0);
  await setLayer(page, isMobile, 'transit', false);
  await expect(warning).toBeHidden();
});

test('search selects a community and records it in the URL', async ({ page }) => {
  await openMap(page);
  await page.locator('#search').fill('aspen');
  await page.locator('#search').press('Enter');
  await expect(page.locator('#community-name')).toHaveText('Aspen Woods');
  await expect(page).toHaveURL(/#ASP$/);
});

test('the search list tracks its active option and closes when focus leaves', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard navigation is a desktop interaction');
  await openMap(page);
  const search = page.locator('#search');
  await search.fill('a');
  await search.press('ArrowDown');
  await search.press('ArrowDown');
  await expect(search).toHaveAttribute('aria-activedescendant', 'search-option-1');
  // Typing rebuilds the list: the previously active option no longer exists.
  await search.pressSequentially('s');
  await expect(search).not.toHaveAttribute('aria-activedescendant', /.+/);
  await expect(page.locator('.search-result[aria-selected="true"]')).toHaveCount(0);
  // A mouse click on a result still works (focus stays in the box while it is pressed).
  await page.locator('.search-result').first().click();
  await expect(page.locator('#search-results')).toBeHidden();
  await expect(page).toHaveURL(/#[A-Z0-9]+$/);
  // Tabbing away closes the list; options are reached with the arrow keys, not Tab.
  await search.fill('park');
  await expect(page.locator('.search-result').first()).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator('#search-results')).toBeHidden();
  await expect(search).toHaveAttribute('aria-expanded', 'false');
});

test('groups, compare view and URL state work together', async ({ page, isMobile }) => {
  await openMap(page, 'ASP');
  await chooseTopFive(page, isMobile);
  await switchView(page, isMobile, 'distribution');
  await expect(page.locator('#comparison-map path[data-community]')).toHaveCount(313);
  // The single comparison map spans the whole viewport on both layouts.
  const mapBox = await page.locator('#comparison-map').boundingBox();
  expect(mapBox.width).toBe(page.viewportSize().width);
  await expect(page.locator('#comparison-page')).toHaveText('1 / 5');
  await expect(page.locator('#comparison-select option:checked')).toHaveText('South Asian');
  await page.locator('#next-groups').click();
  await expect(page.locator('#comparison-page')).toHaveText('2 / 5');
  await expect(page.locator('#comparison-select option:checked')).toHaveText('Chinese');
  await expect(page).toHaveURL(/view=compare/);
  await expect(page).toHaveURL(/compare=chinese/);
  expect(await untranslatedText(page)).toEqual([]);

  // The same link restores the view in a fresh page.
  const url = page.url();
  const copy = await page.context().newPage();
  await copy.goto(url);
  await expect(copy.locator('#comparison-select option:checked')).toHaveText('Chinese');
  await expect(copy.locator('#community-name')).toHaveText('Aspen Woods');
});

test('both views share one camera, also when the comparison map is shown again', async ({ page, isMobile }) => {
  await openMap(page, '?groups=chinese');
  // Create the comparison map at the city view, then go back and zoom to a community.
  await switchView(page, isMobile, 'distribution');
  await switchView(page, isMobile, 'composition');
  await page.locator('#search').fill('beltline');
  await page.locator('#search').press('Enter');
  await expect(page).toHaveURL(/#BLN/);
  const place = () => page.locator('.map-view:not([hidden]) path[data-community="BLN"]').boundingBox();
  const zoomed = await place();
  expect(zoomed.width).toBeGreaterThan(100);
  // Leaflet rounds each map's origin to whole pixels, so allow a pixel either way.
  const drift = async () => {
    const box = await place();
    return box
      ? Math.abs(box.x - zoomed.x) + Math.abs(box.y - zoomed.y) + Math.abs(box.width - zoomed.width)
      : Infinity;
  };
  await switchView(page, isMobile, 'distribution');
  await expect.poll(drift).toBeLessThan(4);
  await switchView(page, isMobile, 'composition');
  await expect.poll(drift).toBeLessThan(4);
});

test('links keep every layer toggle, and a link without a community deselects', async ({ page }) => {
  await openMap(page, 'ASP?groups=chinese&hide=roads,labels');
  await expect(page.locator('#roads-toggle')).not.toBeChecked();
  await expect(page.locator('#labels-toggle')).not.toBeChecked();
  await expect(page).toHaveURL(/#ASP\?groups=chinese&hide=roads,labels$/);
  const outline = page.locator('#composition-map .community-selected-outline');
  await expect(outline).not.toHaveCount(0);

  // A bare #CODE keeps the rest of the view, and the address is completed again.
  await page.evaluate(() => {
    location.hash = '#ASP';
  });
  await expect(page).toHaveURL(/#ASP\?groups=chinese&hide=roads,labels$/);
  await expect(page.locator('#roads-toggle')).not.toBeChecked();

  // Editing the address to a link with no community code restores "nothing selected".
  await page.evaluate(() => {
    location.hash = '#?groups=chinese';
  });
  await expect(outline).toHaveCount(0);
  await expect(page.locator('#roads-toggle')).toBeChecked();
  await expect(page).toHaveURL(/#\?groups=chinese$/);
});

test('switching language updates the interface and returns cleanly', async ({ page, isMobile }) => {
  await openMap(page, 'ASP');
  await setPreference(page, isMobile, 'language-preference', 'zh');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('#search')).toHaveAttribute('placeholder', '搜索 Calgary 社区');
  await setPreference(page, isMobile, 'language-preference', 'en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#language-preference')).toHaveValue('en');
  expect(await untranslatedText(page)).toEqual([]);
});

test('no-data areas are hatched, names pick a readable ink and the legend shows the drawn colours', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openMap(page, '?view=compare&groups=not_visible_minority');
  const map = page.locator('#comparison-map');
  // 107 of the 313 areas publish no population table.
  await expect(map.locator('path[data-community][fill="url(#no-data-hatch)"]')).toHaveCount(107);
  // Most of the city is in the brightest dark-theme step, where names switch to dark ink.
  await expect(map.locator('.community-label.ink-dark').first()).toBeAttached();
  await expect(map.locator('.community-label.ink-light').first()).toBeAttached();
  const { drawn, legend, inks } = await page.evaluate(() => {
    const rgb = value =>
      value
        .match(/\d+(\.\d+)?/g)
        .slice(0, 3)
        .map(Number);
    const container = document.getElementById('comparison-map');
    const ground = rgb(getComputedStyle(container).backgroundColor);
    const drawn = new Set();
    for (const path of container.querySelectorAll('path[data-community]')) {
      if (path.getAttribute('fill').startsWith('url')) continue;
      const opacity = Number(path.getAttribute('fill-opacity'));
      const fill = rgb(getComputedStyle(path).fill);
      drawn.add(fill.map((value, i) => Math.round(value * opacity + ground[i] * (1 - opacity))).join(','));
    }
    const legend = [...document.querySelectorAll('#population-legend .population-bin-labels > span')].map(swatch =>
      rgb(getComputedStyle(swatch, '::before').backgroundColor).join(','),
    );
    const inks = [...container.querySelectorAll('.community-label')].map(label => ({
      dark: label.classList.contains('ink-dark'),
      color: rgb(getComputedStyle(label).color).join(','),
    }));
    return { drawn: [...drawn], legend, inks };
  });
  expect(legend).toHaveLength(6);
  expect(drawn.length).toBeGreaterThan(1);
  for (const color of drawn) expect(legend).toContain(color);
  for (const ink of inks) expect(ink.color).toBe(ink.dark ? '23,26,29' : '245,247,250');
});

test('switching theme restyles the basemap straight away', async ({ page, isMobile }) => {
  await openMap(page);
  // Mean brightness of the road canvas: white roads in the light theme, grey-blue in the dark one.
  const roadBrightness = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('#composition-map .leaflet-roads-pane canvas');
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let sum = 0;
      let count = 0;
      for (let i = 0; i < data.length; i += 4)
        if (data[i + 3] > 200) {
          sum += data[i] + data[i + 1] + data[i + 2];
          count++;
        }
      return count ? sum / count / 3 : 0;
    });
  await expect.poll(roadBrightness).toBeGreaterThan(200);
  await setPreference(page, isMobile, 'theme-preference', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(roadBrightness).toBeLessThan(180);
});

test('communities are reachable from the keyboard', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard navigation is a desktop interaction');
  await openMap(page);
  const stop = page.locator('#composition-map path[data-community][tabindex="0"]');
  await expect(stop).toHaveCount(1);
  await stop.focus();
  await page.keyboard.press('ArrowRight');
  const focused = await page.evaluate(() => document.activeElement.dataset.community);
  expect(focused).toBeTruthy();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#${focused}$`));
  await expect(stop).toHaveCount(1);
});

test('tabbing to a community that was panned away brings it back into view', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard navigation is a desktop interaction');
  await openMap(page, 'DNC');
  await page.locator('#desktop-details-toggle').click();
  // Drag the selected community far outside the window.
  for (let i = 0; i < 2; i++) {
    await page.mouse.move(900, 500);
    await page.mouse.down();
    await page.mouse.move(250, 120, { steps: 5 });
    await page.mouse.up();
  }
  const stop = page.locator('#composition-map path[data-community="DNC"]');
  await expect(stop).not.toBeInViewport();
  await page.locator('#composition-map').focus();
  await page.keyboard.press('Tab');
  await expect(stop).toBeFocused();
  await expect(stop).toBeInViewport();
  // Its tooltip, opened by the same focus, is still there after the map moved.
  await expect(page.locator('.community-tooltip')).toBeVisible();
});

test('the comparison map keeps a single tab stop while moving between communities', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard navigation is a desktop interaction');
  await openMap(page, '?view=compare&groups=chinese');
  const stop = page.locator('#comparison-map path[data-community][tabindex="0"]');
  await expect(stop).toHaveCount(1);
  await stop.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect(stop).toHaveCount(1);
  await expect(stop).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(stop).toHaveCount(1);
});

test('CTrain stations share one tab stop and are reached with arrow keys', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard navigation is a desktop interaction');
  await openMap(page, '?layers=transit');
  const stop = page.locator('#composition-map [data-station-id][tabindex="0"]');
  await expect(stop).toHaveCount(1);
  // Tab from the community stop lands on the single station stop, then leaves the map.
  await page.locator('#composition-map path[data-community][tabindex="0"]').focus();
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => document.activeElement.dataset.stationId);
  expect(first).toBeTruthy();
  await page.keyboard.press('ArrowDown');
  const second = await page.evaluate(() => document.activeElement.dataset.stationId);
  expect(second).toBeTruthy();
  expect(second).not.toBe(first);
  await expect(stop).toHaveCount(1);
  await expect(stop).toBeFocused();
  await page.keyboard.press('Enter');
  const popup = page.locator('.station-popup');
  await expect(popup).toBeVisible();
  // Focus moves into the popup: its source link and close button are the next stops.
  await expect(popup.locator('.leaflet-popup-content')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(popup.locator('a.station-source')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(popup.locator('.leaflet-popup-close-button')).toBeFocused();
  await expect(popup.locator('.leaflet-popup-close-button')).toHaveAttribute('aria-label', 'Close station details');
  // Escape closes it and returns focus to the station it belongs to.
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  await expect(stop).toBeFocused();
  expect(await page.evaluate(() => document.activeElement.dataset.stationId)).toBe(second);
});

test('keyboard focus is not lost when a control hides or disables itself', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard navigation is a desktop interaction');
  await openMap(page, '?groups=south_asian,chinese');
  // Collapsing the legend and reopening it from the keyboard.
  await page.locator('#close-mobile-legend').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#mobile-legend-button')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#close-mobile-legend')).toBeFocused();
  // Choosing a search result keeps focus in the search box.
  await page.locator('#search').fill('aspen');
  await page.locator('#search').press('Enter');
  await expect(page.locator('#community-name')).toHaveText('Aspen Woods');
  await expect(page.locator('#search')).toBeFocused();
  // The switcher arrow that reaches the last group disables itself.
  await page.locator('#distribution-tab').click();
  await page.locator('#next-groups').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#next-groups')).toBeDisabled();
  await expect(page.locator('#previous-groups')).toBeFocused();
});

test('keyboard shortcuts keep working while the desktop legend card is open', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard shortcuts are a desktop interaction');
  await openMap(page);
  await chooseTopFive(page, isMobile);
  await expect(page.locator('#mobile-legend-dialog')).toBeVisible();
  await page.keyboard.press('/');
  await expect(page.locator('#search')).toBeFocused();
});

test('nothing is highlighted until a community is chosen, and closing the details deselects', async ({
  page,
  isMobile,
}) => {
  await openMap(page);
  await chooseTopFive(page, isMobile);
  const outline = page.locator('#composition-map .community-selected-outline');
  await expect(page.locator('.population-donut').first()).toBeAttached();
  await expect(page.locator('.selected-donut')).toHaveCount(0);
  await expect(page.locator('.focus-label')).toHaveCount(0);
  await expect(outline).toHaveCount(0);

  await page.locator('#search').fill('aspen');
  await page.locator('#search').press('Enter');
  await expect(outline).not.toHaveCount(0);
  await expect(page).toHaveURL(/#ASP\?/);

  await page.locator(isMobile ? '#mobile-sheet-close' : '#desktop-detail-close').click();
  await expect(outline).toHaveCount(0);
  await expect(page.locator('.selected-donut')).toHaveCount(0);
  await expect(page).not.toHaveURL(/ASP/);
  if (isMobile) await expect(page.locator('.sidebar')).toHaveAttribute('data-sheet-snap', 'closed');
  else await expect(page.locator('#desktop-details-toggle')).toBeDisabled();
});

test('ring segments follow the legend order, whatever order the groups were ticked in', async ({ page, isMobile }) => {
  await openMap(page);
  await openMenu(page, isMobile);
  await page.locator('#groups-button').click();
  for (const id of ['filipino', 'chinese', 'south_asian']) await page.locator(`#group-${id}`).check();
  await page.locator('#close-groups').click();
  const ringColours = () =>
    page
      .locator('.population-donut svg')
      .first()
      .evaluate(svg => [...svg.querySelectorAll('circle[stroke]')].slice(0, 3).map(c => c.getAttribute('stroke')));
  // South Asian, Chinese, Filipino: the order of the legend and of a reloaded link.
  const expected = ['#518a7b', '#c29b4d', '#5c8eac'];
  await expect.poll(ringColours).toEqual(expected);
  await page.reload();
  await expect(page.locator('#loading-overlay')).toBeHidden();
  await expect.poll(ringColours).toEqual(expected);
});

test('a chosen community is framed clear of the desktop legend card', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the persistent legend card is a desktop feature');
  await page.setViewportSize({ width: 1024, height: 768 });
  await openMap(page, '?groups=south_asian,chinese,black,filipino,latin_american&income=1&layers=transit');
  const legend = page.locator('#mobile-legend-dialog');
  await expect(legend).toBeVisible();
  for (const name of ['aspen woods', 'beltline', 'cranston']) {
    await page.locator('#search').fill(name);
    await page.locator('#search').press('Enter');
    // Its ring and its name are drawn, which they are not when the card covers them.
    await expect(page.locator('.selected-donut')).toHaveCount(1);
    await expect(page.locator('.focus-label')).toHaveCount(1);
    const card = await legend.boundingBox();
    const ring = await page.locator('.selected-donut').boundingBox();
    const centre = { x: ring.x + ring.width / 2, y: ring.y + ring.height / 2 };
    expect(centre.x > card.x + card.width || centre.y < card.y).toBe(true);
  }
});

test('on a narrow desktop window the legend and the switcher stay clear of other controls', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'this is about the desktop layout at tablet width');
  await page.setViewportSize({ width: 768, height: 900 });
  const overlap = async (first, second) => {
    const a = await page.locator(first).boundingBox();
    const b = await page.locator(second).boundingBox();
    const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return x > 0 && y > 0;
  };
  // Details drawer, wide menu and a full legend at once: the tightest case.
  await openMap(page, 'ASP?groups=south_asian,chinese,black,filipino,latin_american&income=1&layers=transit');
  await page.locator('#desktop-menu-toggle').click();
  await expect(page.locator('body')).toHaveClass(/desktop-menu-expanded/);
  await expect(page.locator('#close-mobile-legend')).toBeInViewport({ ratio: 1 });
  expect(await overlap('#mobile-legend-dialog', '.map-tools')).toBe(false);
  await page.locator('#fit-city').click();

  await page.locator('#distribution-tab').click();
  await expect(page.locator('.comparison-pager')).toBeVisible();
  expect(await overlap('.search-wrap', '.comparison-pager')).toBe(false);
  await expect(page.locator('#next-groups')).toBeInViewport({ ratio: 1 });
  await page.locator('#next-groups').click();
  await expect(page.locator('#comparison-select option:checked')).toHaveText('Chinese');
});

test('a hover tooltip near the top of the map opens where it can be read', async ({ page, isMobile }) => {
  test.skip(isMobile, 'tooltips are a pointer-hover feature');
  await page.setViewportSize({ width: 1280, height: 620 });
  await openMap(page, '?groups=south_asian,chinese,black,filipino,latin_american');
  // Livingston is at the northern edge of the city view: a tooltip above it would leave the window.
  await page.locator('#composition-map path[data-community="LIV"]').hover();
  const tooltip = page.locator('.community-tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('Livingston');
  await expect(tooltip).toBeInViewport({ ratio: 1 });
  await expect(tooltip).toHaveClass(/leaflet-tooltip-bottom/);
});

test('desktop keeps a legend card; mobile opens it on demand', async ({ page, isMobile }) => {
  await openMap(page);
  await chooseTopFive(page, isMobile);
  const legend = page.locator('#mobile-legend-dialog');
  if (isMobile) {
    await expect(legend).toBeHidden();
    await page.locator('#mobile-legend-button').click();
    await expect(legend).toBeVisible();
    expect(await legend.evaluate(dialog => dialog.matches(':modal'))).toBe(true);
  } else {
    await expect(legend).toBeVisible();
    expect(await legend.evaluate(dialog => dialog.matches(':modal'))).toBe(false);
    await expect(page.locator('#mobile-legend-button')).toBeHidden();
  }
});

test('a community tapped low on a phone stays visible above the details sheet', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the bottom sheet only exists on small screens');
  await openMap(page);
  // Cranston sits in the lower half of the city view, where the half-height sheet opens.
  const community = page.locator('#composition-map path[data-community="CRA"]');
  const before = await community.boundingBox();
  await page.touchscreen.tap(before.x + before.width / 2, before.y + before.height / 2);
  await expect(page.locator('.sidebar')).toHaveAttribute('data-sheet-snap', 'half');
  await expect(page).toHaveURL(/#CRA$/);
  const sheetTop = (await page.locator('.sidebar').boundingBox()).y;
  expect(before.y + before.height / 2).toBeGreaterThan(sheetTop);
  await expect
    .poll(async () => {
      const box = await community.boundingBox();
      return box.y + box.height / 2;
    })
    .toBeLessThan(sheetTop);
});

test('search results show above the fully expanded details sheet on a phone', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the bottom sheet only exists on small screens');
  await openMap(page, 'ASP');
  await page.locator('#mobile-detail-handle').click();
  await expect(page.locator('.sidebar')).toHaveAttribute('data-sheet-snap', 'full');
  await page.locator('#search').fill('saddle ridge');
  // A real tap: it fails if the sheet covers the result.
  await page.locator('.search-result').first().click();
  await expect(page.locator('#community-name')).toHaveText('Saddle Ridge');
});

test('the mobile details sheet opens for a linked community', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the bottom sheet only exists on small screens');
  await openMap(page, 'ASP');
  await expect(page.locator('.sidebar')).toHaveAttribute('data-sheet-snap', 'half');
  await expect(page.locator('#community-name')).toHaveText('Aspen Woods');
});
