import assert from 'node:assert/strict';
import fs from 'node:fs';
import {colorFor,bubbleRadius,INCOME_BINS,searchFeatures} from './dist/map-utils.mjs';
const data=JSON.parse(fs.readFileSync('./dist/communities.geojson','utf8'));
assert.equal(data.features.length,313);assert.equal(new Set(data.features.map(f=>f.properties.code)).size,313);
assert.equal(data.features.filter(f=>f.properties.income!==null).length,205);
assert.equal(data.features.filter(f=>f.properties.chineseCount!==null).length,206);
assert.equal(colorFor(null),'#d6dcd9');assert.equal(colorFor(44000),INCOME_BINS[0].color);assert.equal(colorFor(98000),INCOME_BINS[3].color);assert.equal(colorFor(432000),INCOME_BINS[6].color);
assert.equal(bubbleRadius(null,'count'),0);assert.equal(bubbleRadius(0,'count'),0);assert.ok(Math.abs(bubbleRadius(2000,'count')**2/bubbleRadius(500,'count')**2-4)<1e-10);
assert.equal(searchFeatures(data.features,'aspen woods')[0].properties.code,'ASP');assert.equal(searchFeatures(data.features,'AUB')[0].properties.code,'AUB');
for(const f of data.features){const p=f.properties;assert.ok(p.name&&p.code&&p.note);assert.ok(p.centroid[0]<-113&&p.centroid[0]>-115&&p.centroid[1]>50&&p.centroid[1]<52);if(p.income!==null)assert.ok(p.income>0&&p.sourceUrl);if(p.chineseCount!==null)assert.ok(p.chineseCount>=0&&p.chinesePct>=0&&p.chinesePct<=1);}
console.log('PASS: 313 unique regions; income and Chinese coverage; missing vs zero; scale boundaries; area-proportional circles; search; source links.');
