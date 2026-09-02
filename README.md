# DataLens：OEE SQLite 数据问答网站

一个使用严格 TypeScript 构建的本地 OEE 数据问答应用。浏览器中的每个会话对应一个持久化 Agent session；Agent 只能调用受限的只读 SQLite 查询和当前时间工具。

## 数据链路

```text
OEE HTTP API / 本地 JSON
          │
          ▼
   OeeDataStore
   ├─ 流式下载与解析
   ├─ 请求日期和响应日期审计
   ├─ 业务主键去重与幂等更新
   ├─ 缺失/部分响应记录
   └─ 月度汇总刷新
          │
          ▼
   .data/oee.sqlite
   ├─ OEE 事实表
   ├─ DUT 大字段 Payload 表
   ├─ 月度汇总表
   └─ 导入批次、覆盖范围和缺口
          │
          ▼
       Agent 问答
```

OEE API 默认地址：

- `R_OEE_MT_TOP_AVAILABILITY_2W`
- `R_OEE_MT_TOP_DUT_UTILIZATION_2W`

参数使用 `pSTARTDAY=YYYYMMDD&pENDDAY=YYYYMMDD`。单次自动拉取最多 14 天，避免超出接口窗口。

## 数据完整性

每次导入都会记录：

- 请求的开始、结束日期。
- 响应实际包含的最小、最大日期。
- 接收、新增、更新、未变化和响应内重复行数。
- 请求窗口内完全缺失的日期。
- 重复拉取时，响应行数低于数据库已有行数的日期。
- 响应中超出请求窗口的日期。
- 单条记录中结束时间早于开始时间等字段级质量问题。
- 当前数据库的最小日期、最大日期、总行数和日期数。
- 原始响应 SHA-256。

事实表使用稳定业务字段生成 `record_key`。重叠窗口再次导入不会制造重复记录；相同业务记录内容发生变化时会更新。`oee_data_gaps` 保存未解决缺口，后续 `data:sync` 会优先补拉缺口，并额外重拉最近两天以接收迟到或修正数据。

数据库状态可以直接查询：

```sql
SELECT * FROM oee_data_status;

SELECT *
FROM oee_data_gaps
WHERE status = 'open'
ORDER BY dataset, data_date;
```

## 数据命令

导入已经下载的 JSON：

```bash
npm run data:import -- availability .data/availability.json 2026-08-20 2026-08-30
npm run data:import -- dut_utilization .data/dut.json 2026-08-20 2026-08-30
```

直接拉取并导入一个窗口：

```bash
npm run data:pull -- availability 2026-08-20 2026-08-30
npm run data:pull -- dut_utilization 2026-08-20 2026-08-30
```

根据数据库覆盖范围、未解决缺口和两天重叠窗口同步到指定日期：

```bash
npm run data:sync -- all 2026-09-02
```

空数据库首次同步需要提供起始日期：

```bash
npm run data:sync -- all 2026-09-02 2026-08-20
```

查看状态：

```bash
npm run data:status
```

生产环境可定期执行 `data:sync`。命令失败时返回非零退出码，可以由 cron、systemd timer 或调度平台告警。

数据拉取、重试、导入和同步结果以 JSON Lines 格式持续追加到 `.data/logs/oee-data.log`，该文件不按日期滚动。网站服务日志与数据日志分开，按本地自然日写入 `.data/logs/sql_web-YYYY-MM-DD.log`。

## 表结构

主要查询表：

- `oee_availability`：Availability 事实数据。
- `oee_dut_utilization`：DUT 统计事实数据。
- `oee_dut_payload`：不参与常规统计的长位图字段。
- `oee_availability_monthly_stats`：Availability 月度汇总。
- `oee_dut_monthly_stats`：DUT 月度汇总。

数据治理表：

- `oee_ingestion_runs`：每次文件导入或 API 拉取批次。
- `oee_ingestion_run_days`：每个请求日期的行数和质量状态。
- `oee_data_gaps`：需要补拉或人工确认的日期。
- `oee_record_issues`：需要修复或人工接受的记录级质量问题。
- `oee_dataset_state`：当前数据库覆盖范围。
- `oee_data_status`：面向 Agent 的覆盖状态视图。

## 启动

环境要求：Node.js 22.19 或更高版本。

```bash
npm install
cp .env.example .env
npm start
```

打开 <http://127.0.0.1:3000>。

开发和验证：

```bash
npm run dev
npm run check
npm test
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP 监听地址 |
| `PORT` | `3000` | HTTP 端口 |
| `SQL_WEB_DB_PATH` | `.data/oee.sqlite` | SQLite 文件位置 |
| `SQL_WEB_SESSION_DIR` | `.data/sessions` | Agent session 目录 |
| `OEE_API_BASE_URL` | 内部 OEE 地址 | 数据拉取根地址 |
| `SQL_WEB_PROVIDER` | 必填 | 模型提供方 |
| `SQL_WEB_MODEL` | 必填 | 模型 ID |

服务只从项目内 `.data/agent/` 加载模型配置和凭据，不读取用户主目录中的全局 Pi 配置。

## 安全边界

- `execute_sql` 使用只读 SQLite 连接，只接受一条返回结果集的查询，单次最多返回 200 行。
- `get_current_time` 返回服务器当前的 UTC 时间、本地时间和时区。
- 创建 Agent 会话时会把当前表和视图的 SQLite DDL 注入 system prompt；数据内容仍必须通过查询工具获取。
- Agent 不加载项目工具、技能或上下文文件。
- 日志不记录用户问题正文、工具参数、查询结果或模型回答正文。

应用仍是本地部署形态，不包含用户登录和租户隔离。正式开放给多用户前，应增加鉴权、限流和独立审计。
