# Excel 本地参考

本文件描述项目已实现的工具契约，不需要在线查询 openpyxl、Excel 或上游 Skill 文档。业务口径和字段查阅 Test OEE Skill 的本地参考，工作簿生成由固定脚本执行。

## 数据来源与引用

1. 用 `execute_sql.save_as` 或 OEE 业务工具取得完整的当前会话快照。传给导出工具的是返回的逻辑名称，不是磁盘路径、查询预览或手写数据。
2. 新查询的业务日期、MT/ST 筛选、指标口径取自查询条件及本地业务规则；现有快照只能用于其实际覆盖的范围。
3. `description` 仅写明已经核实的业务范围和口径，例如“业务日 2026-11-12，MT/ST 池化 OEE，来源：本地 OEE 查询结果”。不要将导出时间当成业务数据更新时间。
4. 不检索外部报表、金融资料或公开网站来补齐 OEE 数据。缺失值保持空白，缺少业务规则时明确说明并请求用户提供资料。

## 工具参数

`xlsx__export` 接收：

| 参数 | 含义 |
| --- | --- |
| `snapshot` | 必填；当前会话完整快照的逻辑名称 |
| `filename` | 可选；下载文件名，服务端清理不适用字符并补 `.xlsx` |
| `title` | 可选；“说明”页的报告标题 |
| `description` | 可选；已核实的业务范围、日期、筛选与口径 |
| `columns` | 可选；指定导出列和顺序，不传则导出快照全部列 |
| `columns[].key` | 快照中真实存在且不重复的字段名 |
| `columns[].title` | 可选；显示列名，不传则使用字段名 |
| `columns[].format` | 可选；见下表，默认 `auto` |

| 格式 | 原始值示例 | Excel 显示 |
| --- | --- | --- |
| `auto` / `number` | 数字 `12` / `1.23456` | `12` / `1.23`；原始数值不变 |
| `text` | 字符串 `0007` / `2026-11-12` | 原文本；编号前导零和日期保留 |
| `ratio` | 数字 `0.1234` | `12.34%` |
| `percent` | 数字 `12.34` | `12.34%` |

格式只影响显示；不要先四舍五入再导出。`ratio` 与 `percent` 依据本地查询的量纲选择：OEE 明细通常是比率，`_percent` 列和排名数值已乘 100。数值格式不能用于文本列。

以下仅为参数形状示例，快照名称和字段必须替换为实际工具返回值：

```json
{
  "snapshot": "oee-export",
  "filename": "OEE查询结果.xlsx",
  "title": "机台OEE查询结果",
  "columns": [
    { "key": "machine", "title": "机台", "format": "text" },
    { "key": "oee", "title": "OEE", "format": "ratio" }
  ]
}
```

成功返回 `file_id`、`filename`、`byte_count`、`row_count` 和 `download_url`。下载地址是本项目的站内接口，通过浏览器访问；回答使用 `[下载文件名](download_url)`，无需请求外部文件托管服务。

## 本地故障处理

| 工具反馈 | 处理 |
| --- | --- |
| 当前会话不存在快照 | 使用当前会话已有的正确名称，或重新查询并保存；不能引用其他会话文件 |
| 字段不存在、重复或格式不匹配 | 核对完整快照的字段及类型，修正 `columns` |
| 空结果 | 文件仍包含表头，回答明确说明无数据 |
| 快照截断或文件/资源超限 | 说明限制，请用户缩小业务范围；不静默裁剪数据 |
| 本地依赖 openpyxl 不可用 | 提示部署人员按项目 README 用随附离线包安装并重启；Agent 不执行安装或联网获取依赖 |
| 匿名接口、子任务或每日分析调用 | 由持久化网页主会话完成导出 |
| 文件已删除或下载无权限 | 确认当前账号与会话；需要重新生成时使用当前会话中的数据 |

查询导出和新写入值不产生公式，不执行 LibreOffice，也不读取或安装 pandas、markitdown。具体样式和文件完整性检查由工具负责，Agent 无需查询第三方 API 文档。


## 读取与修改工具

- `xlsx__list_files {}`：返回当前会话文件清单，含原文件/导出/修改版本类型、下载地址、来源文件 ID 和修改摘要。不能访问其他会话。
- `xlsx__inspect {"file_id":"工具返回的 ID"}`：工作表名称、尺寸、合并区域预览和公式数量。尺寸可能含格式化空白单元格，不等于业务数据行数。
- `xlsx__inspect {"file_id":"工具返回的 ID","sheet":"数据","range":"A1:C10"}`：查看指定区域，最多 200 个单元格；公式单元格 `type=f` 的 `value` 是表达式，不是计算结果。长文本标记 `truncated=true`，不能把截断预览回写为完整原值。
- `xlsx__edit`：以下示例只表示参数形状，必须先读取并核对实际文件和区域。

```json
{
  "file_id": "工具返回的 ID",
  "filename": "修改后的报表.xlsx",
  "operations": [
    { "type": "set", "sheet": "数据", "range": "A2:B2", "values": [["0007", 0.1234]] },
    { "type": "fill", "sheet": "数据", "range": "C2:C10", "value": "已核对" },
    { "type": "format", "sheet": "数据", "range": "B2:B10", "style": { "number_format": "ratio", "bold": true, "fill_color": "E8F0FE", "column_width": 20 } }
  ]
}
```

`set.values` 的行列数必须与区域完全一致。`null` 清空单元格，布尔值保留为布尔值；编号/日期以文本写入。字符串 `=SUM(A1:A3)` 也是文本。明确要求覆盖已有公式时会在摘要记录数量。合并单元格只能向左上角写值。修改受保护工作表会报错，不绕过保护。

格式参数：`number_format` 可用 `general`、`text`、`integer`、`decimal`、`ratio`、`percent`；`bold`、`italic`、`wrap_text` 为布尔值；`font_size` 为 1–72；`font_color`、`fill_color` 为六位 RGB 色值；`alignment` 为 `left`、`center`、`right`；`column_width` 为 1–100；`row_height` 为 1–200。列宽/行高作用于相关整列/整行。

修改返回 `file_id`、`filename`、`byte_count`、`download_url`、`parent_file_id`、`summary`、修改数量和具体区域。仅成功后提供链接，回答使用人类可读的摘要。原文件字节保持不变，每次修改独立生成副本；失败、超时、取消或输出超限不发布副本。

已有公式不重算，修改后公式缓存失效；需要 Excel 重新计算才能获得更新结果。宏、加密、外部数据连接、图形/图表、透视表、嵌入对象和不可保留的扩展不在支持范围；收到相关错误时请用户提供普通 xlsx 副本，不转用任意 Python 或联网转换服务。
