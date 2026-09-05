# DataLens：OEE SQLite 数据问答网站

一个使用严格 TypeScript 构建的本地 OEE 数据问答应用。浏览器中的每个会话对应一个持久化 Agent session；Agent 默认提供受限的 Skill 读取、只读 SQLite 查询、当前时间和严格隔离的 Python 代码解释器，Test OEE 等业务能力由 Skill 按会话加载。

## 项目结构

```text
src/
├── client/          # 浏览器端交互、渲染和接口解码
├── server/
│   ├── agent/       # Agent 会话与模型配置
│   ├── data/        # SQLite 只读查询
│   ├── skills/      # 业务技能、规则参考与技能脚本
│   │   └── test-oee-calculator/
│   │       ├── assets/      # 工具定义、计算器与数据库辅助代码
│   │       ├── references/  # 按需读取的数据库结构与业务规则
│   │       └── scripts/     # 可直接执行的 CLI
│   ├── tool/        # Agent 具体工具、产物与代码解释器
│   ├── config.ts    # 环境与运行配置
│   ├── http-server.ts
│   ├── logger.ts
│   └── main.ts      # 服务端入口
└── shared/          # 浏览器端与服务端共享的数据契约
tests/
├── client/          # 浏览器端测试
├── scripts/         # 数据库初始化与数据命令测试
└── server/          # 服务端只读行为测试
public/              # HTML、样式及生成的浏览器脚本
scripts/
└── database/        # 数据库初始化、Schema 与 OEE 写入实现
```

## 数据链路

```text
OEE HTTP API / 本地 JSON
          │
          ▼
   OeeDataStore
   ├─ 流式下载与解析
   ├─ 必填字段校验
   └─ API 原始行逐条追加
          │
          ▼
   .data/database/oee.sqlite
   ├─ oee_availability
   └─ oee_dut_utilization
          │
          ▼
       Agent 问答
```

OEE API 默认地址：

- `R_OEE_MT_TOP_AVAILABILITY_2W`
- `R_OEE_MT_TOP_DUT_UTILIZATION_2W`

参数使用 `pSTARTDAY=YYYYMMDD&pENDDAY=YYYYMMDD`。开始和结束日期均包含在查询范围内，单次 API 拉取最多 3 个自然日。`data:sync` 会自动将更长范围拆成最多 3 天的串行请求。如果 API 要求 HTTP Basic 鉴权，在 `.env` 中同时配置 `API_USER` 和 `API_PWD`；鉴权信息只会通过请求头发送，不会写入 URL 或日志。

DUT 接口返回的 UTC `DATE` 比请求业务日期早一天；增量同步规划会应用这一固定偏移，但事实表始终保存接口返回的原始 `DATE`，不会改写或裁剪记录。

## 数据完整性

每次导入的命令结果和 JSON Lines 日志会包含：

- 请求的开始、结束日期。
- 响应实际包含的最小、最大日期。
- 接收和新增行数。
- 当前数据库的最小日期、最大日期、总行数和日期数。
- 原始响应 SHA-256。

Availability 和 DUT 两个事实表都使用自增 `id` 作为主键。API 返回的每一行都会独立写入，即使所有源字段完全相同也不会比对、合并或删除；因此重复拉取同一窗口会再次保存原始行。Availability 的 `tool_name`、`lot_id`、`final_state`、`step`、`date`、`time_span` 为非空字段，`shift` 允许为空。DUT 的 `machine_id`、`lot_id`、`in_qty`、`out_qty`、`test_stage`、`dut_num`、`step_id` 为非空字段，其他源字段允许为空且暂不校验。DUT 长字段直接保存在事实表中。

数据库只保留两张用户表。SQLite 因 `AUTOINCREMENT` 自动维护的内部表 `sqlite_sequence` 不属于业务表。覆盖状态由 `data:status` 直接扫描事实表计算，也可以直接查询：

```sql
SELECT MIN(substr(date, 1, 10)), MAX(substr(date, 1, 10)), COUNT(*)
FROM oee_availability;
```

## 数据命令

首次部署时显式创建数据库并执行 Schema。该命令可以安全重复运行，不会清空已有数据：

```bash
npm run data:init
```

其余数据命令只打开已经初始化的数据库；数据库不存在或未初始化时会直接失败。

导入已经下载的 JSON：

```bash
npm run data:import -- availability .data/availability.json 2026-08-20 2026-08-30
npm run data:import -- dut_utilization .data/dut.json 2026-08-20 2026-08-30
```

直接拉取并导入一个窗口：

```bash
npm run data:pull -- availability 2026-08-20 2026-08-22
npm run data:pull -- dut_utilization 2026-08-20 2026-08-22
```

根据事实表的最大日期和两天重叠窗口增量同步到指定日期：

```bash
npm run data:sync -- all 2026-09-02
```

空数据库首次同步或现有数据库历史回填时，提供明确的起始日期：

```bash
npm run data:sync -- all 2026-09-02 2026-08-20
```

例如，在保留现有数据的前提下回填 2026 年 1 月 1 日至 9 月 2 日的两个数据集：

```bash
npm run data:sync -- all 2026-09-02 2026-01-01
```

显式提供起始日期时，同步会完整拉取从起始日期到结束日期的所有窗口。数据库不保存导入批次或逐日进度，因此中途失败后原样重试会再次追加先前已完成窗口的原始行；如需避免重拉，应把起始日期调整到失败窗口。所有重复响应行仍会保留。

查看状态：

```bash
npm run data:status
```

生产环境可定期执行 `data:sync`。命令失败时返回非零退出码，可以由 cron、systemd timer 或调度平台告警。
同步完成后运行 `npm run data:status` 检查两个数据集的最小日期、最大日期、总行数和不同日期数。

数据拉取、重试、导入和同步结果以 JSON Lines 格式持续追加到 `.data/logs/oee-data.log`，该文件不按日期滚动。网站服务日志与数据日志分开，按上海自然日写入 `.data/logs/sql_web-YYYY-MM-DD.log`；两类日志的时间戳均使用上海时区（`+08:00`）。

## 表结构

数据库中的两张用户表：

- `oee_availability`：Availability 原始事实数据，自增 `id` 主键加七个源字段。
- `oee_dut_utilization`：DUT 原始事实数据，自增 `id` 主键加 37 个源字段（包括长位图字段）。

## 启动

环境要求：Node.js 22.19 或更高版本，以及 Linux x86_64 上的 Python 3.12、bubblewrap、prlimit、NumPy、SciPy、Matplotlib 和 Pillow。代码解释器依赖自检失败时网站仍可启动，Skill catalog、SQL 和当前时间工具仍然可用。

```bash
npm install
cp .env.example .env
npm run data:init
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
| `SQL_WEB_DB_PATH` | `.data/database/oee.sqlite` | SQLite 文件位置 |
| `SQL_WEB_SESSION_DIR` | `.data/sessions` | Agent session 目录 |
| `SQL_WEB_ARTIFACT_DIR` | `.data/artifacts` | 会话级 SQL JSON 产物目录 |
| `SQL_WEB_PYTHON_PATH` | `/usr/bin/python3` | 代码解释器使用的 Python |
| `SQL_WEB_BWRAP_PATH` | `/usr/bin/bwrap` | bubblewrap 可执行文件 |
| `SQL_WEB_PRLIMIT_PATH` | `/usr/bin/prlimit` | 资源限制工具 |
| `OEE_API_BASE_URL` | 内部 OEE 地址 | 数据拉取根地址 |
| `API_USER` | 未配置 | OEE API HTTP Basic 用户名，必须与 `API_PWD` 同时配置 |
| `API_PWD` | 未配置 | OEE API HTTP Basic 密码，必须与 `API_USER` 同时配置 |
| `SQL_WEB_PROVIDER` | 必填 | 模型提供方 |
| `SQL_WEB_MODEL` | 必填 | 模型 ID |

服务只从项目内 `.data/agent/` 加载模型配置和凭据，不读取用户主目录中的全局 Pi 配置。

## 安全边界

- `execute_sql` 会先审查传入 SQL，只接受一条返回结果集的查询，并使用只读 SQLite 连接；写入、DDL 和修改状态的 `PRAGMA` 会被拒绝。
- 默认 `output_format="inline"` 直接返回最多 200 行。`output_format="json_file"` 会流式写入最多 100,000 行或 32 MiB 的 JSON，并返回当前会话专属的 `artifact://` 地址。
- `get_current_time` 返回服务器当前的 UTC 时间、本地时间和时区。
- `test-oee-calculator` 被加载后，当前会话才会注册 `test_oee_calculator__calculate_test_oee` 和 `test_oee_calculator__classify_test_oee_record`；计算器、数据库连接辅助模块和工具定义位于 Skill 的 `assets/`，可执行 CLI 位于 `scripts/`，数据库结构、字段含义和业务规则位于 `references/`。计算工具每次执行都建立独立的只读连接并在结束时关闭，分类工具不连接数据库。
- 新增 Skill 必须沿用同一目录约定：根目录只放 `SKILL.md` 等元数据，直接执行的脚本放入 `scripts/`，静态资源和代码放入 `assets/`，按需读取的说明文档放入 `references/`。Catalog 只从 `assets/tools.js` 或 `assets/tools.ts` 加载 Skill 专有工具，不兼容根目录 `tools.*`。
- Skill 专有工具使用 `<skill_namespace>__<local_tool_name>` 命名。Catalog 不接收或持有数据库连接；启动时只扫描元数据并调用无参工具工厂进行校验，不会把专有工具注册到全局或暴露给新会话。需要数据的业务 Skill 自主管理只读连接。
- `code_interpreter.input_json` 接受内联 JSON 或同一会话的 `artifact://` 地址。输入在 Python 中为 `input_data`；文本通过 `print()` 返回，Matplotlib/Pillow 图片通过 `emit_image()` 返回。Matplotlib 会优先使用系统的 `Noto Sans CJK SC` 简体中文字体，显式字体可通过 `matplotlib_chinese_font(size, bold=True)` 获取；Pillow 可通过 `chinese_font(size)` 或 `chinese_font(size, bold=True)` 获取常规/粗体字体。
- Python 使用 bubblewrap、seccomp 和 prlimit 隔离：无法访问数据库、项目目录、其他会话产物或网络，并限制执行时间、内存、进程和输出大小。
- SQL JSON 文件随会话跨轮次、跨重启保留，删除会话时同步删除；文件不通过 HTTP 提供下载。
- 基础 system prompt 不包含业务数据库结构或字段含义；这些上下文由 `test-oee-calculator` 的 `references/database.md` 按需提供，数据内容仍必须通过查询工具获取。
- Agent 递归扫描 `src/server/skills` 并按 Pi 标准格式注入 Skill 名称、描述和入口路径；完整 `SKILL.md` 只在 Agent 根据任务按需读取时进入当前会话上下文。`/skill:<name>` 不会被解析为显式 Skill 调用。
- 通用 `read` 只能读取扫描到的 Skill 目录，拒绝目录穿越、Skill 外文件和符号链接逃逸。成功读取准确的 `SKILL.md` 后，专有工具才在该会话及当前分支内激活；其他会话不受影响。
- 代码沙箱只会挂载显式传入的单个 JSON 文件。
- 日志不记录用户问题正文、工具参数、查询结果或模型回答正文。

应用仍是本地部署形态，不包含用户登录和租户隔离。正式开放给多用户前，应增加鉴权、限流和独立审计。
