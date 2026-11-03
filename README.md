# Calgary 社区观察 · Calgary Census Map

互动卡尔加里社区地图，在电脑和手机上都可切换两个视图：

- **社区构成**：一圈呈现一个社区中已勾选人口类别的构成，灰色为其余类别；可叠加蓝、黄、红收入底图。详情用条形图对照社区与全市占比。
- **分布对比**：按人口占比给社区着色。电脑并排显示最多三张同步地图，手机逐张切换；所有类别共用固定色阶，移动、缩放和社区选择同步。

族群通过可搜索的普通复选框选择，默认选择全市人数最多的五个可见少数族裔类别：南亚裔、华人、菲律宾裔、黑人和拉丁美洲裔。支持全部 13 个原始普查分类，移除了旧版“关注社区”快捷栏。搜索、社区链接、收入资料及来源说明仍可使用。

- 分享地图：<https://curtisatiwatt.github.io/calgary-census/>
- 源码：<https://github.com/curtisatiwatt/calgary-census>

使用 **Vite + 原生 JavaScript + Leaflet 1.9.4**，依赖版本由 `package-lock.json` 锁定。社区统计、边界和道路／水域底图随网站托管，不需要 API key、数据库或外部地图瓦片服务。

## 本地运行

使用 Node.js 22.12+ 或 24 LTS，在仓库目录执行：

```sh
npm ci
npm run dev
```

打开终端显示的 Vite 地址，默认 <http://localhost:5173>。修改源码后自动更新。

检查、构建与预览生产版本：

```sh
npm run check
npm run build
npm run preview
```

生产预览默认 <http://localhost:4173>。开发和生产预览都使用 Vite，运行项目只需 Node.js。`dist/` 是自动生成的构建结果，不能在里面修改源码。不要直接双击 HTML 文件。

Vite 使用相对资源路径，兼容 GitHub Pages 的 `/calgary-census/` 子目录。地址后加社区代码可直接定位，例如 <https://curtisatiwatt.github.io/calgary-census/#ASP>。

## GitHub Pages

仓库 **Settings → Pages → Build and deployment → Source** 应为 **GitHub Actions**。推送 `main` 后，工作流依次执行 `npm ci`、`npm run check`、`npm run build`，再将 `dist/` 发布到 Pages。也可手动运行 **Deploy Calgary map to GitHub Pages**。

源码、校验脚本及审计清单不会被当作网站页面发布。网站中的源码链接指向本仓库。

## 文件结构

| 文件 | 用途 |
| --- | --- |
| `index.html` | 页面结构与数据说明对话框 |
| `src/main.js` | Leaflet 地图、搜索、图层、详情及手机交互 |
| `src/data.js` | 加载本地数据，保留原有统计值及显示名次 |
| `src/map-utils.js` | 收入分档、搜索、格式化等纯函数 |
| `src/population-utils.js` | 人口占比、完整构成、共享色阶与环形图纯函数 |
| `src/map-tooltip.js` | 每张地图唯一的提示框，防止拖动时提示堆叠 |
| `src/styles.css` | 桌面及手机样式 |
| `public/data/communities.geojson` | 313 个区域边界、统计、原有参考说明和来源 |
| `public/data/basemap.geojson` | 官方主要道路和水域几何 |
| `public/data/metadata.json` | 年份、统计口径、全市值和数据来源 |
| `public/data/population-groups.json` | 206 个社区及全市的 13 类人口原始人数、原公布占比与分母 |
| `public/licenses/leaflet.txt` | Leaflet 许可证 |
| `tests/map-utils.test.js` | 分档、缺失值、比例面积、搜索及链接测试 |
| `scripts/validate-data.mjs` | 原数据指纹、覆盖、坐标、来源与显示点校验 |
| `scripts/validate-population-data.mjs` | 人口分类、来源、覆盖、取整差异和原华人人数一致性校验 |
| `scripts/extract-population-groups.py` | 从官方 PDF 文本重建人口快照 |
| `population-data-audit.json` | 人口表提取来源及一致性审计 |
| `data-integrity.json` | Vite 迁移前原始数据的 SHA-256、字节数及 Git 版本 |
| `data-audit.json`、`basemap-audit.json` | 原有来源与整理审计记录 |
| `.github/workflows/pages.yml` | 检查、构建和 GitHub Pages 部署 |

## 数据口径

- 收入为 **2021 年人口普查中的 2020 年税前私人住户收入中位数**，单位 CAD，非当前收入。全市中位数为 **$98,000**。“住户”包括单人、家庭和合住者，不只统计有孩子的家庭。
- 人口、类别人数、原公布比例、儿童比例及平均住户人数均保留市府社区档案的原始公布值。人口指私人住户居民，不包括集体住所居民。
- 新人口视图使用 Visible Minority（Racialized Population）的 13 个互斥分类，**不是国籍、出生地或可重复选择的祖籍分类**。Chinese 不等于中国国籍、中国出生或普通话使用者；“非可见少数族裔”包含原住民等人口，**不能标作白人或欧洲裔**。菲律宾裔与东南亚裔等原始分类分别呈现，不把上位分类与子类相加。
- **详情及分布图占比 = 类别人数 ÷ 同一人口表的私人住户人口**，显示一位小数，因此可能与旧版直接显示的整数百分比不同。原公布占比仍保存在 `publishedPct`，原始 GeoJSON 未改写。全市对照也用全市表的相同口径，不用社区加总替代。
- 普查人数经过取整，原表 13 类人数之和可能与表内人口分母存在差异。Highwood 的分类合计为 2,130、表中人口为 2,205，已核对 PDF 原页；原表未说明这一差额的具体原因，保留原值。环形图以同表人口为分母；分类合计不足时以点纹留白表示原表统计差额，不把差额并入未勾选人群。仅当分类合计超过分母时，圆环按分类合计归一化以闭合一圈，详情统计不作归一化。未勾选的类别合为灰色余项，**不代表数据缺失**。统计差额不是新增人口类别。缺失人口记录不显示环形图，并在分布图中使用灰色虚线。
- 313 个区域单元包含 223 个住宅类、43 个工业类、4 个主要公园、43 个余留分区。205 个有可用收入，206 个有华人人口数值；缺失保留 `null`，7 个明确公布的 0 保留 0。
- 全市华人人数为 **91,415（7%）**。社区取整数值之和为 91,300，不能替代全市公布值。
- 0–14 岁比例和平均私人住户人数采用档案的公布值，不以其他指标重算。收入显示名次沿用原版，并列金额的显示次序不代表统计差异。
- 整理时下载的边界与历史统计按社区代码／名称对应，未针对后续边界变化重新分配统计。Springbank、Bearspaw 等市外地区不在这套数据内。
- 选区说明为分析判断，不是学校排名、治安评分或官方建议。应按具体地址核验学校分配、住房成本与通勤。
- 数据快照整理日期：2026-11-03，不自动更新。2026 年联邦普查已完成采集，但截至此日期尚未发布结果；首批人口结果计划于 2027-02-10 发布，收入为 2027-07-14，民族文化为 2027-10-27。本图仍使用已发布的 2021 年资料。

## 数据完整性与视觉编码

此次 Vite 迁移将原版本 `71790d2d554c3c84e2bfbf95b5647ecfd25dbceb` 的两个 GeoJSON 原样移至 `public/data/`。几何、统计、显示名次、参考说明、缺失值、提示和来源链接均未改写。`npm run check` 对比固定 SHA-256 和字节数，并检查全部 313 个显示点位于各自边界内。

未来若主动更新数据，应重新核对官方资料、同步元数据和审计记录，并明确更新 `data-integrity.json` 的快照版本与指纹；不要仅为让检查通过而修改指纹。

收入档位保持原版：低于 60,000；60,000–79,999；80,000–97,999；98,000–124,999；125,000–149,999；150,000–199,999；200,000 及以上。缺失使用灰色和虚线边界。

环形图用于比较构成，圆的大小不表示人数。地图缩小时隐藏相互重叠的环形图，放大后显示更多；选中的社区优先显示。圆心是社区内的显示点，不是居民住址。鼠标点击只显示社区描边；键盘操作仍保留焦点提示。

分布图使用固定共享占比色阶，禁止针对每个类别分别拉伸颜色范围。较深的颜色表示较高占比，不是人数更多，也不表示收入、学校质量或治安更好。可在社区详情查看实际人数。

人口快照的重建需要先从[市府社区档案](https://www.calgary.ca/communities/profiles.html)取得 PDF，并以 `pdftotext -layout` 转为对应文件名的 `.txt`。将全部档案文本放在同一目录，执行：

```sh
python3 scripts/extract-population-groups.py --source-dir /absolute/path/to/profile-texts
npm run check
```

Python 仅用于维护人员重新提取数据；开发、构建及运行网站只需 Node.js。

## 来源与许可

- [City of Calgary 社区普查档案](https://www.calgary.ca/communities/profiles.html)
- [Community District Boundaries](https://data.calgary.ca/Base-Maps/Community-District-Boundaries/surr-xmvs)
- [Major Road Network](https://data.calgary.ca/Transportation-Transit/Major-Road-Network/tqjs-vnhy)
- [Cartographic Hydrology](https://data.calgary.ca/resource/47bt-eefd.geojson)
- [Statistics Canada · 2026 普查采集完成](https://www.statcan.gc.ca/en/about/statistical-announcements/2026-09-14-exceptional-participation-2026-census)
- [Statistics Canada · 2026 普查发布时间表](https://www.statcan.gc.ca/en/census/census-engagement/community-supporter/posters/encourage-completion)

Contains information licensed under the Open Government Licence – City of Calgary. Leaflet 许可证见 `public/licenses/leaflet.txt`。这些第三方许可不改变项目自有代码的权利归属。
