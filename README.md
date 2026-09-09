# DataLens：OEE SQLite 数据问答网站

一个使用严格 TypeScript 构建的本地 OEE 数据问答应用。浏览器中的每个会话对应一个持久化 Agent session；Agent 默认提供受限的 Skill 读取、只读 SQLite 查询、当前时间和严格隔离的 Python 代码解释器，Test OEE 等业务能力由 Skill 按会话加载。

## 项目结构

```text
src/
├── client/          # 浏览器端交互、渲染和接口解码
├── server/
│   ├── agent/       # Agent 会话与模型配置
│   ├── database/    # SQLite 只读查询
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
├── database/        # 数据库初始化、Schema 与 OEE 写入实现
└── session-to-html.ts  # 持久化会话排障 HTML 导出
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
   ├─ oee_dut_utilization
   ├─ oee_import_runs
   └─ oee_import_windows
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

每次导入都会获得任务 ID 和窗口 ID。命令结果、审计表和 JSON Lines 日志会共同记录：

- 请求的开始、结束日期。
- 响应实际包含的最小、最大日期。
- 接收、新增和替换删除的行数。
- 每日行数、缺失日期、越界日期和无法归属日期的行数。
- 当前数据库的最小日期、最大日期、总行数和日期数。
- 原始响应 SHA-256。

Availability 和 DUT 两个事实表都使用自增 `id` 作为主键。导入窗口在一个事务中处理：对于响应实际返回且位于预期范围内的日期，先删除该日期旧数据，再逐条保存本次响应，因此重复导入正常日期不会累积旧批次；同一响应内部的完全重复行仍会全部保留。解析、必填字段校验或数据库写入失败会回滚整个窗口。

响应缺少预期日期时不会删除该日期已有数据，窗口状态为 `completed_with_warnings`。DUT 的无日期、无效日期或越界日期行仍会保存并记录异常，但因为事实表不保存窗口 ID，这些异常行在重复导入时可能累积，必须结合 `data:status` 人工判断。

Availability 的 `tool_name`、`lot_id`、`final_state`、`step`、`date`、`time_span` 为非空字段，`shift` 允许为空。DUT 的 `machine_id`、`lot_id`、`in_qty`、`out_qty`、`test_stage`、`dut_num`、`step_id` 为非空字段，其他源字段允许为空且暂不校验。DUT 长字段直接保存在事实表中。

数据库保留两张事实表和两张导入审计表。`oee_import_runs` 记录一次命令任务，`oee_import_windows` 记录每个最多三天的下载/导入窗口及其状态。SQLite 因 `AUTOINCREMENT` 自动维护的 `sqlite_sequence` 不属于业务表。事实覆盖仍可直接查询：

```sql
SELECT MIN(substr(date, 1, 10)), MAX(substr(date, 1, 10)), COUNT(*)
FROM oee_availability;
```

## 数据命令

首次部署时显式创建数据库并执行 Schema。该命令也用于把旧数据库升级到当前 Schema 版本，可以安全重复运行且不会清空已有事实或审计数据：

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

根据审计状态同步到指定日期。命令会自动补齐失败、中断、未覆盖和新增日期，并刷新最近两天：

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

显式提供起始日期时，同步会在该范围内跳过已完成的历史窗口，只补缺口并保留最近两天刷新。单个窗口失败不会阻止其他窗口和另一个数据集继续执行；下次运行会自动重试失败或中断范围。

强制重新拉取并原子替换指定日期范围：

```bash
npm run data:reimport -- availability 2026-08-20 2026-08-30
npm run data:reimport -- dut_utilization 2026-08-20 2026-08-30
```

较长范围会自动拆成最多三天的窗口。重导成功会关闭相同逻辑日期上的旧异常建议，但不会自动清理无法按日期归属的 DUT 异常行。

查看状态：

```bash
npm run data:status
```

`data:status` 为每个数据集输出四组 JSON：`facts` 是事实日期范围、行数、缺口和无日期行数；`tracking` 是审计覆盖、连续完成日期、下一起始日期和最新任务；`issues` 是当前有效异常；`recommendations` 给出结构化的 `sync` 或 `reimport` 建议。

生产环境可定期执行 `data:sync`。正常完成返回 0，已提交但存在缺日/越界/无日期异常返回 2，硬失败返回 1，可由 cron、systemd timer 或调度平台分别告警。旧事实数据没有审计历史时会显示 `legacy_untracked`，应使用显式起始日期同步或 `data:reimport` 建立可信覆盖。

数据拉取、重试、导入和同步结果按上海自然日写入 `.data/logs/oee-data-YYYY-MM-DD.log`；网站服务日志写入 `.data/logs/sql_web-YYYY-MM-DD.log`。两类日志的时间戳均使用上海时区（`+08:00`），不会由应用自动删除。

服务日志使用 `serviceRunId` 串联一次进程生命周期，并记录配置、数据库、产物目录、代码解释器、Agent Store、HTTP 监听、信号和关闭阶段。每个 API 响应返回 `X-Request-Id`；网页错误也会展示该跟踪 ID。数据日志使用 `commandRunId`、`importRunId` 和 `windowId` 与审计表关联。日志不会写入鉴权头、密码、请求正文或原始数据行。

## 会话排障导出

将持久化 session 导出成可直接用浏览器打开的单文件 HTML：

```bash
# 使用完整 session ID
npm run session:html -- 01a07997-d9c6-71e7-8218-a3131cea47ed

# 使用 JSONL 路径并指定输出文件
npm run session:html -- .data/sessions/example.jsonl /tmp/session.html

# 导出最近修改的 session
npm run session:html -- latest
```

未指定输出路径时，文件写入 `.data/session-exports/<session-file>.html`。脚本默认从 `SQL_WEB_SESSION_DIR` 查找 ID；也可以使用 `--session-dir <directory>` 指定其他目录。导出过程只读取原 JSONL 快照，不会迁移或改写 session。

HTML 默认为完整诊断视图，可切换分支、搜索条目，并展示持久化 header、消息、thinking、工具参数及原始结果、usage、错误、模型切换、压缩/分支记录、自定义条目和代码解释器图片；也可以切换为简化的对话视图。页面的 CSS、JavaScript、Markdown 渲染器、清理器和图片都内嵌在文件中，不依赖正在运行的网站或网络资源。

该导出是排障资料，不是脱敏的分享页面。文件可能包含用户问题、内部 thinking、SQL、查询结果、Python 代码、本机路径和生成图片；默认以仅当前用户可读写的权限创建，仍应按敏感数据保管。

## 表结构

数据库中的四张用户表：

- `oee_availability`：Availability 原始事实数据，自增 `id` 主键加七个源字段。
- `oee_dut_utilization`：DUT 原始事实数据，自增 `id` 主键加 37 个源字段（包括长位图字段）。
- `oee_import_runs`：导入命令任务、参数、生命周期状态、窗口汇总和首个错误。
- `oee_import_windows`：数据集窗口、请求/预期日期、下载与导入状态、行数、哈希和异常详情。

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
| `SQL_WEB_ARTIFACT_DIR` | `.data/artifacts` | 会话级数据快照及历史会话产物目录 |
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
- `execute_sql` 默认直接返回最多 200 行；需要 Python 计算、统计或绘图时，使用可选 `save_as` 将最多 100,000 行、32 MiB 的完整结果保存为会话级冻结快照，同时只返回元数据和最多 20 行预览。后续通过逻辑名称引用快照，不经过模型搬运完整结果。
- `get_current_time` 返回服务器当前的 UTC 时间、本地时间和时区。
- `test-oee-calculator` 被加载后，当前会话才会注册 SQL 表达式、LOT 校验、MT/ST 分类和 Availability 状态分类工具；这些工具不连接数据库。数据库派生的比率与乘积必须在同一条 SQL 或可信的 `code_interpreter` 调用中完成，纯比率计算器仅保留为规则测试基准。
- 新增 Skill 必须沿用同一目录约定：根目录只放 `SKILL.md` 等元数据，直接执行的脚本放入 `scripts/`，静态资源和代码放入 `assets/`，按需读取的说明文档放入 `references/`。Catalog 只从 `assets/tools.js` 或 `assets/tools.ts` 加载 Skill 专有工具，不兼容根目录 `tools.*`。
- Skill 专有工具使用 `<skill_namespace>__<local_tool_name>` 命名。Catalog 不接收或持有数据库连接；启动时只扫描元数据并调用无参工具工厂进行校验，不会把专有工具注册到全局或暴露给新会话。需要数据的业务 Skill 自主管理只读连接。
- `code_interpreter` 接收 `code`、可选的 `snapshot` 逻辑名称和可选 `user_input`，不接收或执行 SQL。传入快照时，服务端把该会话的完整冻结数据只读挂载为 `input_data.database`，并提供 `snapshot_rows` 作为 `list[dict]` 行对象列表；每行可用 `row["列名"]` 访问，无需也不应再与 `columns` 做 `zip`。`input_data` 同时支持属性和方括号访问。未传快照时 `input_data.database` 为 `None`、`snapshot_rows` 为空，可执行不依赖数据库的纯 Python。`user_input` 单独出现在 `input_data.user`，只用于用户明确提供的参数。快照查询达到 100,000 行或 32 MiB 上限时不会保存，不允许基于截断数据生成结论。
  Python 必须且只能调用一次 `emit_result(...)`；可提交 JSON 值或结构化关键字字段，运行时会补充缺失的 `summary`，并把字符串 `notes` 规范化为数组。结构化结果上限为 64 KiB。`print()` 仅作为调试日志，不能替代 `emit_result`；工具结果同时包含查询行数、字节数、截断状态和用户输入标记。
  每张 Matplotlib/Pillow 图片必须通过 `emit_image(value, reference_name)` 显式提交；名称应具体表达图片含义，归一化后不超过 50 个字符。空格和标点会统一转成小写连字符格式，例如 `2026 OEE / Top 10` 变为 `2026-oee-top-10`；纯数字、纯符号或空名称会被拒绝。未显式提交的 Matplotlib 图不会输出。
  图片使用不含工具调用 UUID 的短引用，例如 `![oee-ranking](/__datalens_generated_image__/ci-oee-ranking)`；同一会话重名时才追加 `-2`、`-3`。图片解析、流式展示和会话恢复只接受这种语义 ID。
  最终正文落库前会复核所有 Markdown 图片；无效地址优先按 Markdown 图片说明与当前回合 `ChatImage.alt` 的精确唯一对应关系修复。重复说明不猜测，也不参与数量兜底；其他唯一候选继续自动纠正，仍有歧义时触发至多一次不可见的模型重写。服务端保留无法确认或重复的原始引用，前端只渲染当前消息缓存中精确匹配且首次出现的图片 ID。
  Matplotlib 已预配置简体中文字体，普通中文标题和坐标文字无需手动指定字体。`matplotlib_chinese_font(...)` 与 `chinese_font(...)` 是沙箱预注入的全局函数而非 Python 模块，不得导入；需要显式字体对象时直接调用，例如 Matplotlib 使用 `fontproperties=matplotlib_chinese_font(12, bold=True)`，Pillow 使用 `font=chinese_font(20, bold=True)`。
- Python 使用 bubblewrap、seccomp 和 prlimit 隔离：无法访问数据库、项目目录、其他会话产物或网络，并限制执行时间、内存、进程和输出大小。
- 数据快照使用简短的规范逻辑名称，并在服务端映射到不可见的内部 UUID 文件；同名快照只在新查询完整成功后原子替换。快照可在同一会话的后续计算、绘图和恢复后继续使用，并随会话删除。
- 基础 system prompt 不包含业务数据库结构或字段含义；这些上下文由 `test-oee-calculator` 的 `references/database.md` 按需提供，数据内容仍必须通过查询工具获取。
- Agent 递归扫描 `src/server/skills` 并按 Pi 标准格式注入 Skill 名称、描述和入口路径；完整 `SKILL.md` 只在 Agent 根据任务按需读取时进入当前会话上下文。`/skill:<name>` 不会被解析为显式 Skill 调用。
- 通用 `read` 只能读取扫描到的 Skill 目录，拒绝目录穿越、Skill 外文件和符号链接逃逸。成功读取准确的 `SKILL.md` 后，专有工具才在该会话及当前分支内激活；其他会话不受影响。
- 代码沙箱只会只读挂载服务端按当前会话和逻辑名称解析的数据快照，以及独立的用户输入 JSON；不接受模型指定的 SQL、宿主路径、artifact URI 或数据正文。
- 日志不记录用户问题正文、工具参数、查询结果或模型回答正文。

应用仍是本地部署形态，不包含用户登录和租户隔离。正式开放给多用户前，应增加鉴权、限流和独立审计。
