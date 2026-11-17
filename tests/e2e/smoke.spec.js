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

/** Select the five largest groups through the real controls on either layout. */
async function chooseTopFive(page, isMobile) {
  if (isMobile) {
    await page.locator('#mobile-more').click();
    await page.locator('#groups-button').click();
  } else {
    await page.locator('#groups-button').click();
  }
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

test('optional layers load on demand', async ({ page }) => {
  const requested = [];
  page.on('request', request => requested.push(new URL(request.url()).pathname.split('/').pop()));
  await openMap(page);
  await expect.poll(() => requested.includes('basemap.geojson')).toBe(true);
  expect(requested).not.toContain('ctrain-operating.geojson');
  expect(requested).not.toContain('geographic-context.geojson');
  await page.evaluate(() => document.getElementById('transit-toggle').click());
  await expect(page.locator('[data-station-id]').first()).toBeAttached();
  expect(requested).toContain('ctrain-operating.geojson');
});

test('search selects a community and records it in the URL', async ({ page }) => {
  await openMap(page);
  await page.locator('#search').fill('aspen');
  await page.locator('#search').press('Enter');
  await expect(page.locator('#community-name')).toHaveText('Aspen Woods');
  await expect(page).toHaveURL(/#ASP$/);
});

test('groups, compare view and URL state work together', async ({ page, isMobile }) => {
  await openMap(page, 'ASP');
  await chooseTopFive(page, isMobile);
  await page.evaluate(() => document.getElementById('distribution-tab').click());
  await expect(page.locator('#comparison-map path[data-community]')).toHaveCount(313);
  // The single comparison map spans the whole viewport on both layouts.
  const mapBox = await page.locator('#comparison-map').boundingBox();
  expect(mapBox.width).toBe(page.viewportSize().width);
  await expect(page.locator('#comparison-page')).toHaveText('1 / 5');
  await page.evaluate(() => document.getElementById('next-groups').click());
  await expect(page.locator('#comparison-page')).toHaveText('2 / 5');
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

test('links keep every layer toggle, and a link without a community deselects', async ({ page }) => {
  await openMap(page, 'ASP?groups=chinese&hide=roads,labels');
  await expect(page.locator('#roads-toggle')).not.toBeChecked();
  await expect(page.locator('#labels-toggle')).not.toBeChecked();
  await expect(page).toHaveURL(/#ASP\?groups=chinese&hide=roads,labels$/);
  const outline = page.locator('#composition-map .community-selected-outline');
  await expect(outline).not.toHaveCount(0);

  // Editing the address to a link with no community code restores "nothing selected".
  await page.evaluate(() => {
    location.hash = '#?groups=chinese';
  });
  await expect(outline).toHaveCount(0);
  await expect(page.locator('#roads-toggle')).toBeChecked();
  await expect(page).toHaveURL(/#\?groups=chinese$/);
});

test('switching language updates the interface and returns cleanly', async ({ page }) => {
  await openMap(page, 'ASP');
  const select = page.locator('#language-preference');
  await page.evaluate(() => {
    const s = document.getElementById('language-preference');
    s.value = 'zh';
    s.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('#search')).toHaveAttribute('placeholder', '搜索 Calgary 社区');
  await page.evaluate(() => {
    const s = document.getElementById('language-preference');
    s.value = 'en';
    s.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(select).toHaveValue('en');
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

test('switching theme restyles the basemap straight away', async ({ page }) => {
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
  await page.evaluate(() => {
    const select = document.getElementById('theme-preference');
    select.value = 'dark';
    select.dispatchEvent(new Event('change'));
  });
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

test('the mobile details sheet opens for a linked community', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the bottom sheet only exists on small screens');
  await openMap(page, 'ASP');
  await expect(page.locator('.sidebar')).toHaveAttribute('data-sheet-snap', 'half');
  await expect(page.locator('#community-name')).toHaveText('Aspen Woods');
});
