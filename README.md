# DataLens：OEE SQLite 数据问答网站

基于 TypeScript 和 Pi Agent 的本地 OEE 数据问答应用，支持只读 SQLite 查询、持久化会话、隔离 Python 计算、看板更新和邮件通知。

## 启动

需要 Node.js ≥ 22.19.0。Python 计算另需 Linux x86_64、Python 3.12、bubblewrap、prlimit、NumPy 和 SciPy；沙箱自检失败时，网站与 SQL 查询仍可使用。

```bash
npm install
cp .env.example .env
# 填写模型配置，并准备 .data/agent/ 中的模型定义和凭据
npm run data:init
npm start
```

后台启动（输出追加至 `nohup.out`）：

```bash
npm run build && setsid -f node --enable-source-maps dist/src/server/main.js >> nohup.out 2>&1 < /dev/null
```

访问 [http://127.0.0.1:3000](http://127.0.0.1:3000)。开发使用 `npm run dev`，检查与测试使用 `npm run check`、`npm test`。

## 域账号登录与个人会话

网页使用工号或短域账号登录，例如 `3000100562`。服务端将账号和密码以表单 POST 提交到内网 `DomainAccountVerify` 接口，5 秒超时，不自动重试。密码仅用于当次验证，不保存；当前使用内网 HTTP 接口。

登录 Cookie 为 HttpOnly、SameSite=Lax，有效期固定 8 小时，登录状态保存在服务端内存中；服务重启后需要重新登录，聊天和看板仍然保留。网站使用 HTTPS 时设置 `SQL_WEB_AUTH_COOKIE_SECURE=true`，当前 HTTP 部署保持 `false`。域验证地址可通过 `SQL_WEB_DOMAIN_VERIFY_URL` 覆盖。

账号看板配置默认读取 `.data/user-dashboards.json`，可由 `SQL_WEB_USER_DASHBOARDS_PATH` 覆盖；修改后重启服务生效。该文件随 `.data` 保存在本机，不提交到 Git；首次部署时在该路径创建文件，内容如下：

```json
{
  "defaultDashboards": ["default"],
  "users": {
    "3000100562": ["analysis", "default"]
  }
}
```

列表顺序就是标签顺序，第一个看板默认选中；每个账号的列表必须非空且无重复，配置只绑定已经注册的看板。可使用上方 JSON 示例作为初始配置。兼容旧 `defaultDashboard` 单值字段和用户映射中的字符串，不能同时配置新旧默认字段。综合看板使用 `default` ID，显示为「OEE综合看板」；分析看板使用 `analysis` ID，显示为「OEE分析看板」。账号配置直接使用 `analysis`，不再接受 `overview` ID。现有账号绑定不会由代码自动扩充。

所有验证成功的域账号都可登录，未单独配置的账号使用 `defaultDashboards` 列表。`analysis` 由独立模板按卡片 ID 复用最新默认快照的日、周改善表和昨日 MT/ST 最佳、最差各 10 台的四张机台改善表，共 6 张卡片；综合看板保留全部 15 张卡片；每日任务在默认看板发布后刷新校验，无需重复计算或 Agent 分析。配置引用的看板必须已注册，未知 ID 会使启动失败。

每个新会话绑定当前登录账号，并立即保存全部绑定看板的初始快照。文件名自动包含账号水印，例如 `3000100562__2026-10-19T08-00-00-000Z__<会话ID>.jsonl`，文件内另记录归属。只有所有者能看到、继续、编辑或删除私有会话；同一账号在不同浏览器登录可看到相同历史。配置只决定新会话的看板列表，已有会话保留创建时的列表、标题、快照与后续编辑。同一会话的多个看板共享聊天，标签切换不创建新会话；刷新页面默认选中第一个标签。

原有未绑定会话显示为“共享历史”，所有登录账号都能只读查看。继续对话会先自动复制为当前账号的私有会话，保留对话、看板基线及产物；源会话不改名、不认领、不删除，副本也不受当前账号初始看板配置覆盖。带私有标记但归属损坏的文件不会作为共享历史展示。

登录接口为 `POST /api/auth/login`，JSON 请求体为 `{"account":"工号","password":"域密码"}`；`GET /api/auth/me` 返回账号、有序 `dashboardIds` 和过期时间，`POST /api/auth/logout`（JSON `{}`）注销当前登录。业务 API 需携带登录 Cookie；健康检查和 `/chat/compeletion` 保持公开。通过 `POST /api/sessions/:id/fork`（JSON `{}`）可复制共享历史。

网页 Agent、子 Agent 和匿名问答只允许读取共享每日分析、每日任务日志、已发布默认快照及当前会话产物；原始聊天文件、导出、备份、凭据、网站日志和其他会话产物不向 Agent 开放。域账号不限制共享 OEE 数据查询范围。

模型必须在项目的 `.data/agent/models.json` 或 `models-store.json` 中声明，凭据使用 `.data/agent/auth.json`；服务不读取用户主目录的全局 Pi 配置。

## 配置

配置示例见 [.env.example](.env.example)。网站读取项目 `.env`，模型选择必须来自该文件；数据命令优先使用进程环境变量，其次读取 `.env`。相对存储路径以项目根目录为基准。

| 配置 | 默认值 / 用途 |
| --- | --- |
| `SQL_WEB_PROVIDER`、`SQL_WEB_MODEL` | 必填，模型提供方与 ID |
| `HOST`、`PORT` | `127.0.0.1`、`3000` |
| `SQL_WEB_DB_PATH` | `.data/database/oee.sqlite` |
| `SQL_WEB_SESSION_DIR` | `.data/sessions` |
| `SQL_WEB_ARTIFACT_DIR` | `.data/artifacts` |
| `SQL_WEB_DEFAULT_DASHBOARD_PATH` | `.data/default-dashboard.json`；网站与每日任务须使用同一路径 |
| `OEE_API_BASE_URL` | 内部 OEE API 根地址，可按部署覆盖 |
| `API_USER`、`API_PWD` | 可选 HTTP Basic 凭据，须同时配置 |
| `SQL_WEB_DAILY_ANALYSIS_TIMEOUT_MS` | `600000`，每日分析时限（毫秒） |
| `SQL_WEB_DAILY_ANALYSIS_CONTEXT_WINDOW` | `262144`，另受模型上限约束 |
| `SQL_WEB_DAILY_ANALYSIS_MAX_OUTPUT_TOKENS` | `32768`，另受模型与上下文四分之一上限约束 |

Python 可执行路径通过 `SQL_WEB_PYTHON_PATH`、`SQL_WEB_BWRAP_PATH`、`SQL_WEB_PRLIMIT_PATH` 覆盖，默认分别为 `/usr/bin/python3`、`/usr/bin/bwrap`、`/usr/bin/prlimit`。邮件配置见下文。

## 数据同步与每日更新

`data:init` 用于首次建库或升级 Schema，可重复执行，不清空已有数据。`data:sync` 只打开已初始化的数据库：

```bash
# 首次导入或历史补数：截止业务日、起始业务日
npm run data:sync -- all 2026-09-14 2026-09-01
# 后续同步：按审计记录补齐，并刷新最近两天
npm run data:sync -- all 2026-09-14
# 单表同步：availability 或 dut_utilization
npm run data:sync -- availability 2026-09-14
```

空表首次同步必须提供起始日期。导入完整解析、校验后按业务日事务替换；目标日缺失或已有班次覆盖退化时保留该日旧数据，并记录警告和审计。

每日任务同步数据、更新已注册看板，并按配置发送通知：

```bash
npm run daily:update -- --dry-run
npm run daily:update
npm run daily:update -- --through-date 2026-09-14
```

业务日为上海时间当天 08:30 至次日 08:30。每日任务在 08:30 后默认处理昨天，之前处理前天；显式截止日也必须已经结束。

每日任务只处理目标业务日，不刷新已成功提交日期，也不自动补历史缺日。Availability 请求目标日 D；DUT 请求 D 至 D+2，仅写入 DATE=D。历史补数使用 `data:sync`。`--dry-run` 仅显示配置与请求计划，不访问 API，也不创建锁、日志或数据库。

安装上海时间每日 09:00 的 cron 任务：

```bash
npm run schedule:install -- --dry-run
npm run schedule:install
crontab -l
```

安装要求主机时区为 `Asia/Shanghai`、`cron.service` 已运行；重复安装保留其他 crontab 条目。手动与定时任务共用 `flock` 锁，重叠执行会跳过。停机期间遗漏的日期需手动补数。

数据同步与每日任务退出码：`0` 正常、`2` 有警告、`1` 硬失败。同步硬失败时跳过全部看板；单个看板失败保留其旧快照并继续其他看板。分析失败时可发布最新基础指标，并标记改善分析不可用。

## 看板与 Agent

默认看板包含 15 张卡片：MT/ST 的 Effective OEE 与 Test OEE 概览、周/月/季趋势、极值明细、机台 TOP10、日/周改善清单，以及昨日 MT 最佳、MT 最差、ST 最佳、ST 最差各 10 台的四张机台改善表。月、季改善分析不再运行，相关趋势和极值保留。缺数据保持 NULL，不补零；快照缺失或无效时显示等待更新的空模板。

四张机台表按类型、排名、平台/机台、TEST OEE、Availability、Performance (DUT-On)、Performance (Test Time)、Yield、主损失状态与短板、改善措施与责任人共 10 列展示。平台号与机台号同列显示，例如 `T5773/ADH001`；缺少映射时显示“平台待维护/机台号”，原始机台编号保留用于排名和证据引用。已有发布快照在读取时补齐平台标签，不改写原文件。排名与五项百分数指标由程序计算，采用目标业务日的单机台口径；最佳降序、最差升序，按未舍入值排序，并列按机台号。NULL 不参与，零值参与，不足 10 台展示实际数量，两榜独立选取、允许重叠。主损失为同日同机台同类型最大的非运行状态损失，短板为最低子项（并列全部显示）。Agent 逐台提出动作、验证指标及建议责任职能，最佳机台也分析短板，有证据时补充经验推广。

机台建议按冻结数据的日期、类型、机台及原始行校验；建议失败时仍保留该机台的排名、指标与短板。有效日周报告会保存检查点，后续机台修正失败或超时不会阻断已有日周结果及原日表邮件。旧 13 卡默认发布快照可在读取时转换为新布局，保留原指标和日周改善表，新增四表等待下次每日任务；读取不改写原文件或历史会话。

校验失败提醒列明榜单、不可用建议数量、平台/机台及具体原因（日期、类型、机台引用不匹配，重复、缺少措施或责任职能等），对应行同时说明原因；分析超时和运行失败单独标明，已通过的建议继续展示。看板的分析异常提醒位于表格上方并默认展开，普通说明仍折叠。每日命令结果及 `daily.analysis.warning` 日志保留相同的详细原因，质量记录包含中止类型与原因；机台异常不单独改变原日表邮件。

日周与机台校验及统一反馈集中在 `validation.ts`：`validation` 含 `status`（`valid` / `needs_repair` / `unavailable`）、`issues`、`has_more`，无法完成时补充 `reason`。每个错误含 `code`、原始候选的 JSON Pointer `path`、`expected`、`actual`、`message`、`hint`，按范围附加周期、MT/ST、榜单、机台及条目下标等定位。子任务预检、主 Agent 提交反馈、每日结果及质量记录使用同一结构；日周与机台保留各自修正流程。看板和日志从结构化错误生成说明，日志不再读取看板提醒文案。

局部修正参数无效时也返回统一字段反馈；分析子进程因无法降级的校验错误退出时，具体 issues 仍会传回每日结果及运行记录。

新会话锁定创建时按账号配置选择的全部看板，后续每日发布不会自动刷新已有会话。已有会话读取时会为四张机台改善表补齐“平台/机台”展示，综合与分析看板使用相同规则；仅调整展示字段，保留原指标、建议、日期、revision、卡片顺序和布局，读取不改写快照文件。各看板独立维护卡片、初始基线和 revision，同名卡片不会跨看板联动；重置仅恢复目标看板的初始版本。快照文档使用版本 2，旧单看板快照在读取时保持原文件，首次由 Agent 修改时才转换；旧私有会话继续使用原看板 ID，不受新配置覆盖。

前端通过页面顶部固定栏中的标签切换看板，各会话的每个看板独立记住本次页面使用中的滚动位置，切换回来时恢复；首次打开的看板从顶部开始。看板通过 Agent 对话修改。每次模型请求注入 `dashboards` 和 `activeDashboardId`；后者固定为发送问题时选中的看板，回答期间切换标签不改变默认目标。后台看板更新不会抢占当前标签。

Agent 保留两个工具：`get_dashboard({dashboard_ids?, include_data?})` 默认返回全部看板和卡片摘要，指定 `include_data: true` 可返回完整卡片数据；`update_dashboard({dashboard_id, action, base_revision, ...})` 每次修改一个绑定看板，跨看板修改连续调用。upsert 直接接收 `data: {columns: string[], rows: object[]}`、`widget` 和 `date_range`，data 支持原生对象及 JSON 字符串，旧 snapshot 参数已移除。看板更新只校验展示结构、列映射和数值类型，不读取或校验查询快照；data 最多 2000 行、2 MiB，单个看板仍受 2 MiB 文件限制。dataAsOf 为本次 upsert 的服务器时间。

指标计算仍采用 SQL 优先：通过 `execute_sql.save_as` 或业务工具保存完整快照，需要二次计算时使用 `code_interpreter(snapshot)` 复用快照。仅当预览包含全部结果时可直接构造展示 data；预览截断时先从完整快照提取，或通过 SQL 聚合、筛选并保存完整可见的新结果。展示数据保持数值精度和 null；同一快照的计算结果可提交到多个看板，修改始终使用目标看板的 revision。

网页 HTTP 接口统一使用多看板结构，服务端与前端需同步发布：登录和会话摘要返回 `dashboardIds`，完整会话返回 `dashboards: [{id, title, state}]`，不再返回旧单值字段。`POST /api/sessions/:id/messages` 的请求为 `{"message":"问题","dashboardId":"analysis"}`；SSE `dashboard_update` 同样携带 `dashboardId`。目标必须属于该会话，而不是只存在于当前账号的新配置中。匿名 `/chat/compeletion` 的文字问答格式保持不变。

计算结果统一在展示时四舍五入：整数保持原样，小数补足两位（例如 `1.2 → 1.20`、`1.235 → 1.24`）。看板、图表、排名摘要和每日邮件共用格式化规则，聊天、API 回答与分析报告使用相同的 Agent 展示指引。计算、排序和证据保留原始精度；历史聊天与归档保持原文。看板 `format.precision` 字段保留兼容，展示以统一规则为准。

聊天 Agent 可委派 1–3 项独立子任务；每日分析固定并行调查日、周、昨日 MT 机台和昨日 ST 机台，再汇总并校验证据。OEE 专属工具通过读取 Skill 按会话启用，公式和筛选规则由 Skill 统一维护。

每日分析在汇总前使用发布校验规则预检各子任务候选，将具体错误和可复用的证据反馈给主 Agent。`measure_loss` 的局部排序仅供调查；`machine_evidence_ids` 必须引用 `rank_machines` 标准排名，工具返回的 `source` 和 `report_usage` 说明引用用途。逐组修正中，已修好的组不消耗失败修正额度；最多允许三次失败修正，重复错误、修正时限和总工具额度仍会触发止损。

后台一次性问答使用 `POST /chat/compeletion`（路径保留此拼写）：

```bash
curl http://127.0.0.1:3000/chat/compeletion \
  -H 'Content-Type: application/json' \
  -d '{"text":"昨天的 MT Effective OEE 是多少？"}'
# {"text":"完整回答内容"}
```

`text` 必须是非空字符串，最多 4000 字符，请求体最多 64 KiB。接口等待完整回答后返回 JSON，不使用流式响应。每次调用创建独立的内存会话，使用与主页面相同的模型、基础提示词、Skill 和工具，并从当前默认看板初始化；不继承网页聊天历史，也不进入网页会话列表。返回前销毁会话并删除临时产物，客户端断开或服务关闭时取消运行并清理资源。模型失败、回答为空或输出被截断时返回错误，格式为 `{"error":"错误信息","requestId":"…"}`；响应头同时提供 `X-Request-Id`，运行日志照常保留。

临时 Agent 额外收到接口交流提醒：直接在 `text` 中回答，可以读取看板作为数据来源，不修改看板，也不引导调用方查看网页看板或访问临时产物。

各看板位于 `src/server/dashboard/<看板 ID>/`，在公共入口 `src/server/dashboard/index.ts` 注册 `DashboardDefinition`，提供 `id`、可选显示名 `title`、`loadInitial()` 和可选 `update(context)`。公共层负责注册、账号映射、通用快照存储，以及供看板按需引用的邮件发送和通知路由。

```text
src/server/dashboard/
├── email.ts                 # SMTP 发送、收件路由及通知结果
├── default/
│   ├── index.ts             # 看板定义、快照读写、日邮件内容生成
│   ├── template.ts          # 卡片数量、类型、顺序及静态展示配置
│   ├── calculate/
│   │   ├── index.ts         # 指标计算、分析占位卡及业务数值汇总
│   │   └── periods.ts       # 业务周期与日期计算
│   └── analysis/
│       ├── index.ts         # 运行配置、子进程调度、超时与运行统计
│       ├── agent.ts         # 日周/机台主子 Agent 提示词、任务、工具、证据及汇总
│       ├── validation.ts    # 日周/机台结构、统一反馈、校验、修正、降级及提醒
│       └── worker.ts        # IPC 子进程入口
└── analysis/
    ├── index.ts
    ├── template.ts
    └── calculate/index.ts   # 按模板 ID 投影默认快照
```

`calculate/index.ts` 提供 `calculateDefaultDashboard()`，在调用方的只读事务内完成计算并按 ID 填回模板。Agent 在基础指标交给父进程后加载，计算与分析使用同一只读事务，成功后原子发布快照。看板入口可引用公共 `email.ts` 的通知分发器，提供信息类型和邮件内容生成函数；未配置发送规则时跳过发送。

`analysis/` 引用默认看板资源，按自身模板顺序读取指定卡片并返回独立副本，已注册每日更新入口，在 `default` 之后执行。更新复用本次发布的默认快照，校验日、周及四张机台分析卡片并记录状态，不另存快照或启用分析模块；默认看板本次未发布时明确跳过，不将同日旧快照视为更新成功。网站加载时，默认快照缺失或无效仍展示六张等待更新的分析卡片。

## 邮件通知

邮件发送与收件路由统一位于 `src/server/dashboard/email.ts`；各看板按需引用，聊天的 `send_email` 工具也复用同一发送实现。

在 `.env` 中同时配置 SMTP 主机、固定发件地址和显示名称即可启用邮件；默认端口为 25，使用无需认证的中继，支持服务器提供的 STARTTLS。

```dotenv
SQL_WEB_SMTP_HOST=10.71.68.150
SQL_WEB_SMTP_PORT=25
SQL_WEB_MAIL_FROM_ADDRESS='"JV OEE Agent"@sdsscn.com'
SQL_WEB_MAIL_FROM_NAME=JV OEE Agent
```

发件地址外层单引号用于保留内部双引号。网站修改配置后需重启；未配置时邮件工具关闭。聊天 Agent 仅在用户明确要求发送且收件邮箱、内容明确时使用 `send_email`。

每日邮件收件人保存在不纳入 Git 的 `.data/notifications.json`，例如：

```json
{
  "groups": {
    "oee-improvement": ["recipient@example.com"]
  },
  "routes": {
    "daily-improvement": {
      "enabled": true,
      "groups": ["oee-improvement"],
      "to": []
    }
  }
}
```

群组与 `to` 合并去重后限 1–50 人，配置每次发送前重新读取。文件缺失、规则缺失或关闭时跳过发送。

仅当默认看板分析成功或证据降级、且发布成功时发送日改善表。每次成功运行都会发送，同日手动重跑也会再次发送。邮件异常不回滚看板，不自动重试；SMTP 接受不代表实际送达，结果未知时先核实收件情况。

## 排障与目录

```bash
npm run session:html -- latest
npm run session:html -- <session-id>
npm run session:html -- .data/sessions/example.jsonl /tmp/session.html
```

默认导出至 `.data/session-exports/`，只读取会话，不改写原文件。HTML 包含问题、工具参数、查询结果等诊断内容，应按敏感数据保管。

| 目录 | 内容 |
| --- | --- |
| `src/client/`、`public/` | 浏览器交互、页面与样式 |
| `src/server/agent/`、`src/server/tool/` | Agent 会话与工具 |
| `src/server/database/`、`src/server/dashboard/` | 只读查询、看板计算与分析 |
| `src/server/skills/` | 业务 Skill、参考文档和脚本 |
| `src/shared/`、`tests/` | 共享契约与测试 |
| `scripts/` | 建库、同步、调度与会话导出 |
| `.data/logs/` | 网站、数据同步和每日任务日志，按上海日期命名 |
| `.data/daily-analysis/<runId>/` | 分析报告、冻结证据、事件与运行指标 |

网页错误及 API 响应提供请求跟踪 ID。每日命令结果按 `dashboards` 中的 `dashboardId` 查看发布、分析和通知状态；详细产物说明见下方运行文档。

## 安全边界与参考

SQL 工具仅允许只读查询。Python 使用 bubblewrap、seccomp 和 prlimit 隔离，不能访问数据库、项目目录或网络，只接收会话冻结快照并返回结构化结果。Skill 读取受目录限制，网站会话额外可读取项目 `.data` 中的普通文本；每日分析按周期隔离证据。

应用为本地部署形态，尚无用户登录和租户隔离；向多用户开放前需增加鉴权、限流和独立审计。

- [OEE Skill 入口](src/server/skills/test-oee-calculator/SKILL.md)
- [业务公式与筛选规则](src/server/skills/test-oee-calculator/references/business-rules.md)
- [数据库结构](src/server/skills/test-oee-calculator/references/database.md)
- [看板字段映射](src/server/skills/test-oee-calculator/references/dashboard.md)
- [数据导入与完整性审计](src/server/skills/test-oee-calculator/references/import-audit.md)
- [每日运行、产物与归档查询](src/server/skills/test-oee-calculator/references/daily-dashboard.md)
