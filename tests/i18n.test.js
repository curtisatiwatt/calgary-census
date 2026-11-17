import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { translate, setLanguage, currentLanguage, t, translationConflicts, MESSAGES } from '../src/i18n.js';
import '../src/mobile-ui.js';
import '../src/desktop-ui.js';
import '../src/community-sheet.js';

const read = name => JSON.parse(readFileSync(new URL(`../public/data/${name}`, import.meta.url)));
const hasHan = value => /[\u3400-\u9fff]/u.test(value);

test('keyed sentences render in the current language with their values', () => {
  const values = { population: '21,000', income: '$118,000' };
  setLanguage('en');
  assert.equal(currentLanguage(), 'en');
  assert.equal(t('detail.summary', values), 'Population 21,000 · Income $118,000');
  assert.equal(t('暂无数据'), 'No data');
  setLanguage('zh');
  assert.equal(t('detail.summary', values), '人口 21,000 · 家庭收入 $118,000');
  assert.equal(translate('Panorama Hills', 'en'), 'Panorama Hills');
});

test('every keyed message has Chinese and English text with the same placeholders', () => {
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const [key, message] of Object.entries(MESSAGES)) {
    assert.ok(message.zh && message.en, `${key}: missing a language`);
    assert.deepEqual(placeholders(message.en), placeholders(message.zh), `${key}: placeholders differ`);
    assert.equal(hasHan(message.en), false, `${key}: English text contains Chinese`);
  }
});

test('every static page string and displayed metadata field has English text', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '');
  const strings = new Set();
  // Text between tags, and the attributes the page translates.
  for (const [, text] of html.matchAll(/>([^<>]+)</g)) if (hasHan(text)) strings.add(text);
  for (const [, , value] of html.matchAll(/\s(aria-label|placeholder|title|alt|content|data-mobile-text)="([^"]*)"/g))
    if (hasHan(value)) strings.add(value);
  // Chinese-only spans marked lang="zh-CN" (e.g. the language option) are intentionally untranslated.
  for (const [, text] of html.matchAll(/lang="zh-CN"[^>]*>([^<]+)</g)) strings.delete(text);
  const metadata = read('metadata.json');
  for (const field of [
    'incomeDefinition',
    'latestCensusNote',
    'boundaryNote',
    'populationGroupsDefinition',
    'populationDefinition',
    'childrenDefinition',
    'householdSizeDefinition',
  ]) {
    assert.ok(metadata[field], `metadata.json is missing ${field}`);
    strings.add(metadata[field]);
  }
  for (const source of metadata.sources) strings.add(source.label);
  const missing = [...strings].filter(text => hasHan(translate(text, 'en')));
  assert.deepEqual(missing, []);
});

test('every published community label and caveat has an English equivalent', () => {
  for (const feature of read('communities.geojson').features) {
    for (const field of ['caveat', 'sectorLabel', 'typeLabel']) {
      const source = feature.properties[field];
      if (!source) continue;
      const english = translate(source, 'en');
      assert.equal(hasHan(english), false, `${feature.properties.code}.${field}: ${english}`);
      assert.deepEqual(
        english.match(/\d+(?:\.\d+)?/g),
        source.match(/\d+(?:\.\d+)?/g),
        `${feature.properties.code}.${field} must retain numbers`,
      );
    }
  }
});

test('all population groups and displayed transit explanations are translated', () => {
  for (const group of read('population-groups.json').groups)
    assert.equal(hasHan(translate(group.label, 'en')), false, group.id);
  for (const file of ['ctrain-operating.geojson', 'ctrain-green.geojson'])
    for (const feature of read(file).features) {
      for (const field of ['phaseLabel', 'locationNote', 'note']) {
        const value = feature.properties[field];
        if (value) assert.equal(hasHan(translate(value, 'en')), false, `${file}.${field}: ${value}`);
      }
    }
});

test('missing data and published zeros keep distinct translated meanings', () => {
  setLanguage('en');
  assert.equal(t('unit.people', { count: 0 }), '0 people');
  assert.equal(
    t('error.load', { path: 'communities.geojson', status: 404 }),
    'Could not load communities.geojson (404)',
  );
  setLanguage('zh');
  assert.equal(translate('暂无数据', 'en'), 'No data');
  assert.equal(translate('暂无数据，不是 0%', 'en'), 'No data, not 0%');
});

test('modules never register conflicting English text for the same source string', () => {
  assert.deepEqual(translationConflicts, []);
});
