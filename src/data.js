async function readJson(path) {
  const response = await fetch(`${import.meta.env.BASE_URL}data/${path}`);
  if (!response.ok) throw new Error(`无法载入 ${path}（${response.status}）`);
  return response.json();
}

export async function loadData() {
  const [metadata, communities, populationData, basemap] = await Promise.all([
    readJson('metadata.json'),
    readJson('communities.geojson'),
    readJson('population-groups.json'),
    readJson('basemap.geojson').catch(() => null),
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
  return { metadata, features, populationData, basemap };
}
