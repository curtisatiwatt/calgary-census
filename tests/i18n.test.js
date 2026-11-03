import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { translate, setLanguage, currentLanguage, t } from '../src/i18n.js';

const read = name => JSON.parse(readFileSync(new URL(`../public/data/${name}`, import.meta.url)));
const hasHan = value => /[\u3400-\u9fff]/u.test(value);

test('switching language preserves numeric content and returns original Chinese', () => {
  const source = '儿童占21%，高于全市18%。可考察同龄活动，再核验学校和通勤。';
  setLanguage('en');
  assert.equal(currentLanguage(), 'en');
  assert.match(t(source), /21%.*18%/);
  assert.equal(hasHan(t(source)), false);
  assert.equal(t('暂无数据'), 'No data');
  setLanguage('zh');
  assert.equal(t(source), source);
  assert.equal(t('theme.toDark'), '切换至夜间模式');
  assert.equal(translate('Panorama Hills', 'en'), 'Panorama Hills');
});

test('every published community reference and caveat has an English equivalent', () => {
  for (const feature of read('communities.geojson').features) {
    for (const field of ['note', 'caveat', 'sectorLabel', 'typeLabel']) {
      const source = feature.properties[field];
      if (!source) continue;
      const english = translate(source, 'en');
      assert.equal(hasHan(english), false, `${feature.properties.code}.${field}: ${english}`);
      assert.deepEqual(english.match(/\d+(?:\.\d+)?/g), source.match(/\d+(?:\.\d+)?/g), `${feature.properties.code}.${field} must retain numbers`);
    }
  }
});

test('all population groups and displayed transit explanations are translated', () => {
  for (const group of read('population-groups.json').groups) assert.equal(hasHan(translate(group.label, 'en')), false, group.id);
  for (const file of ['ctrain-operating.geojson', 'ctrain-green.geojson']) for (const feature of read(file).features) {
    for (const field of ['phaseLabel', 'locationNote', 'note']) {
      const value = feature.properties[field];
      if (value) assert.equal(hasHan(translate(value, 'en')), false, `${file}.${field}: ${value}`);
    }
  }
});

test('missing data and published zeros keep distinct translated meanings', () => {
  assert.equal(translate('0 人', 'en'), '0 people');
  assert.equal(translate('暂无数据', 'en'), 'No data');
  assert.equal(translate('暂无数据，不是 0%', 'en'), 'No data, not 0%');
  assert.equal(translate('无法载入 communities.geojson（404）', 'en'), 'Could not load communities.geojson (404)');
});
