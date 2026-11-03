# Calgary 社区观察 · Calgary Census Map

互动卡尔加里社区地图：收入底色从蓝到黄到红，华人人口用面积成比例的圆表示；支持人数／占比切换、社区搜索、桌面悬停及手机点击详情。

- 目标源码仓库：<https://github.com/curtisatiwatt/calgary-census>
- GitHub Pages 发布成功后的默认地址：<https://curtisatiwatt.github.io/calgary-census/>

纯 HTML、CSS、JavaScript，使用内置 Leaflet 1.9.4。无需 API key、数据库、构建工具或外部地图瓦片服务。数据和道路／水域底图随站点一起托管。

## 本地运行

在仓库根目录执行：

```sh
python3 -m http.server 8000 --directory dist
```

打开 <http://localhost:8000>。需要 HTTP 服务，请不要直接双击 HTML 文件。检查代码与数据可执行：

```sh
node --check dist/app.js
node check.mjs
```

所有资源路径均为相对路径，支持 GitHub Pages 的 `/calgary-census/` 子目录。链接末尾可加社区代码，例如 `#ASP` 直接定位 Aspen Woods。

## GitHub Pages 发布

1. 将项目内容推送到目标仓库的 `main` 分支。
2. 在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
3. 在 **Actions** 中运行 **Deploy Calgary map to GitHub Pages**，或再次推送到 `main`。工作流会检查数据，再发布 `dist/`。
4. 工作流成功后，使用 Pages 页面显示的地址访问与分享。无需给访客提供 GitHub 或 ChatGPT 账号。

自动部署配置在 `.github/workflows/pages.yml`。之后更新 `main` 会重新发布。仓库中的说明、校验脚本和审计文件不会被放入网页发布目录。

## 文件结构

| 文件 | 用途 |
| --- | --- |
| `dist/index.html` | 页面与数据说明 |
| `dist/styles.css` | 桌面及手机样式 |
| `dist/app.js` | 地图、图层、搜索与详情交互 |
| `dist/map-utils.mjs` | 收入分档、圆面积换算、搜索等 |
| `dist/communities.geojson` | 313 个区域边界、统计、参考说明与来源链接 |
| `dist/basemap.geojson` | 官方主要道路与水域几何 |
| `dist/vendor/` | Leaflet 及其许可证 |
| `check.mjs` | 数据覆盖、缺失值、比例及搜索检查 |
| `data-audit.json`、`basemap-audit.json` | 数据来源及整理方法 |
| `.github/workflows/pages.yml` | GitHub Pages 自动部署 |

## 数据口径

- 收入为 **2021 年人口普查中的 2020 年税前私人住户收入中位数**，单位 CAD，非当前收入。全市中位数为 $98,000。
- 人口、Chinese 类别人数／比例、儿童比例及平均住户人数为公布的 2021 年统计；公布比例未重新计算。
- Chinese 是普查人口类别，不等于中国国籍、中国出生或普通话使用者。人口只包含私人住户居民。
- 313 个官方区域单元中，205 个有可用收入、206 个有华人人口数值。缺失为 `null`，不当作 0；公布的 0 保留取整与小样本提示。
- 全市华人人数为 91,415（7%）。社区取整数值之和不应替代全市公布值。
- 边界与历史统计按社区代码／名称对应，未针对之后的边界变化重新分配统计。
- 参考说明为分析判断，不是学校排名、治安评分或官方选区建议。公开版不包含个人住址、就学经历或工作地点说明。
- 整理日期：2026-11-03。数据为随项目附带的快照，不会自动更新。

## 视觉编码

收入档位：低于 60,000；60,000–79,999；80,000–97,999；98,000–124,999；125,000–149,999；150,000–199,999；200,000 及以上。缺失使用灰色与虚线边界。

圆的**面积**与华人人数或公布占比成正比。圆心是社区内用于显示的代表点，不是居民住址。手机端统一缩小圆与图例，保持比例关系。

## 来源与第三方许可证

- [City of Calgary 社区普查档案](https://www.calgary.ca/communities/profiles.html)
- [Community District Boundaries](https://data.calgary.ca/Base-Maps/Community-District-Boundaries/surr-xmvs)
- [Major Road Network](https://data.calgary.ca/Transportation-Transit/Major-Road-Network/tqjs-vnhy)
- [Cartographic Hydrology](https://data.calgary.ca/resource/47bt-eefd.geojson)
- GitHub Pages 配置参考：[官方文档](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

Contains information licensed under the Open Government Licence – City of Calgary. Leaflet 许可证见 `dist/vendor/LEAFLET-LICENSE.txt`。这些第三方许可不改变项目自有代码的权利归属。
