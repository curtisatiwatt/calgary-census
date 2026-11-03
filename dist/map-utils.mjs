export const CITY_INCOME=98000;
export const INCOME_BINS=[
 {max:60000,color:'#3979b5',label:'低于 $60,000'},
 {max:80000,color:'#82b8d6',label:'$60,000–79,999'},
 {max:98000,color:'#d8e5cb',label:'$80,000–97,999'},
 {max:125000,color:'#f1d66f',label:'$98,000–124,999'},
 {max:150000,color:'#efaa5a',label:'$125,000–149,999'},
 {max:200000,color:'#db714d',label:'$150,000–199,999'},
 {max:Infinity,color:'#b83f42',label:'$200,000 及以上'}
];
export const SHORTLIST=['ASP','WSP','SPH','EPK','RID','AUB'];
export const isNumber=v=>typeof v==='number'&&Number.isFinite(v);
export const colorFor=v=>isNumber(v)?INCOME_BINS.find(b=>v<b.max).color:'#d6dcd9';
export const money=v=>isNumber(v)?'$'+v.toLocaleString('en-CA'):'暂无数据';
export const number=v=>isNumber(v)?v.toLocaleString('en-CA'):'暂无数据';
export const percent=v=>isNumber(v)?Math.round(v*100)+'%':'暂无数据';
export const normal=s=>String(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g,'');
export function bubbleRadius(value,mode,zoom=10.5){if(!isNumber(value)||value<=0)return 0;const max=mode==='count'?6665:.47;const base=mode==='count'?23:22;return Math.sqrt(value/max)*base;}
export function searchFeatures(features,query){const q=normal(query);if(!q)return [];return features.map(f=>{const p=f.properties;const name=normal(p.name);return{f,score:name===q?0:name.startsWith(q)?1:name.includes(q)?2:normal(p.code)===q?3:99};}).filter(x=>x.score<99).sort((a,b)=>a.score-b.score||a.f.properties.name.localeCompare(b.f.properties.name)).slice(0,12).map(x=>x.f);}
export function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
