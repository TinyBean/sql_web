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

默认看板包含 13 张卡片：MT/ST 的 Effective OEE 与 Test OEE 概览、周/月/季趋势、极值明细、机台 TOP10，以及日/周/月/季改善清单。缺数据保持 NULL，不补零；快照缺失或无效时显示等待更新的空模板。

新会话锁定创建时的默认看板，后续每日发布不会自动刷新已有会话；对话可修改当前会话的卡片，重置恢复其初始版本。每次模型请求都会注入当前会话看板。

计算结果统一在展示时四舍五入：整数保持原样，小数补足两位（例如 `1.2 → 1.20`、`1.235 → 1.24`）。看板、图表、排名摘要和每日邮件共用格式化规则，聊天、API 回答与分析报告使用相同的 Agent 展示指引。计算、排序和证据保留原始精度；历史聊天与归档保持原文。看板 `format.precision` 字段保留兼容，展示以统一规则为准。

聊天 Agent 可委派 1–3 项独立子任务；每日分析固定并行调查日、周、月、季，再汇总并校验证据。OEE 专属工具通过读取 Skill 按会话启用，公式和筛选规则由 Skill 统一维护。

后台一次性问答使用 `POST /chat/compeletion`（路径保留此拼写）：

```bash
curl http://127.0.0.1:3000/chat/compeletion \
  -H 'Content-Type: application/json' \
  -d '{"text":"昨天的 MT Effective OEE 是多少？"}'
# {"text":"完整回答内容"}
```

`text` 必须是非空字符串，最多 4000 字符，请求体最多 64 KiB。接口等待完整回答后返回 JSON，不使用流式响应。每次调用创建独立的内存会话，使用与主页面相同的模型、基础提示词、Skill 和工具，并从当前默认看板初始化；不继承网页聊天历史，也不进入网页会话列表。返回前销毁会话并删除临时产物，客户端断开或服务关闭时取消运行并清理资源。模型失败、回答为空或输出被截断时返回错误，格式为 `{"error":"错误信息","requestId":"…"}`；响应头同时提供 `X-Request-Id`，运行日志照常保留。

临时 Agent 额外收到接口交流提醒：直接在 `text` 中回答，可以读取看板作为数据来源，不修改看板，也不引导调用方查看网页看板或访问临时产物。

新增看板在 `src/server/dashboard/index.ts` 注册 `DashboardDefinition`，提供 `id`、`loadInitial()` 和可选 `update(context)`；各看板独立计算并原子发布快照。

## 邮件通知

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
