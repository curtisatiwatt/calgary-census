async function readJson(path) {
  const response = await fetch(`${import.meta.env.BASE_URL}data/${path}`);
  if (!response.ok) throw new Error(`无法载入 ${path}（${response.status}）`);
  return response.json();
}

/** Census data the first paint needs: boundaries, statistics and their metadata. */
export async function loadCoreData() {
  const [metadata, communities, populationData] = await Promise.all([
    readJson('metadata.json'),
    readJson('communities.geojson'),
    readJson('population-groups.json'),
  ]);
  if (communities.type !== 'FeatureCollection' || !communities.features?.length) {
    throw new Error('社区边界数据格式不完整');
  }
  if (populationData.schemaVersion !== 1 || !populationData.groups?.length || !populationData.communities) {
    throw new Error('社区人口分类数据格式不完整');
  }
  const features = communities.features.map(feature => {
    const p = feature.properties;
    if (!p.name || p.code === undefined || !Array.isArray(p.centroid)) {
      throw new Error('社区身份或显示坐标缺失');
    }
    return { ...feature, properties: { ...p, code: String(p.code) } };
  });
  return { metadata, features, populationData };
}

/** Optional context layers, fetched after first paint or when switched on. */
const LAYER_FILES = {
  basemap: ['basemap.geojson'],
  railways: ['railways.geojson'],
  transit: ['ctrain-operating.geojson', 'ctrain-green.geojson'],
  landmarks: ['geographic-context.geojson', 'orientation-landmarks.geojson'],
};
const fileRequests = new Map();
function readOnce(path) {
  if (!fileRequests.has(path)) {
    const request = readJson(path);
    fileRequests.set(path, request);
    // A failed optional file may be retried later.
    request.catch(() => fileRequests.delete(path));
  }
  return fileRequests.get(path);
}
export function loadLayerData(name) {
  return Promise.all(LAYER_FILES[name].map(readOnce));
}
