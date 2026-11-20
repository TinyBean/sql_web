# DataLens：OEE SQLite 数据问答网站

基于 TypeScript 和 Pi Agent，支持 OEE 数据问答、只读 SQL 查询、隔离 Python 计算、多看板、Excel 文件处理和邮件通知。

## 启动

需要 Node.js ≥ 22.19.0。Python 计算与 Excel 功能另需 Linux x86_64、系统 Python 3.12（含 venv）、bubblewrap 和 prlimit；沙箱不可用时仍可使用 SQL 问答。

```bash
npm install
cp .env.example .env
# 完成下方模型和账号看板配置后继续
npm run data:init
npm start
```

访问 [http://127.0.0.1:3000](http://127.0.0.1:3000)。后台启动：

```bash
npm run build && setsid -f node --enable-source-maps dist/src/server/main.js >> nohup.out 2>&1 < /dev/null
```

## 配置与登录

Web、数据命令、每日任务和会话导出都优先读取项目 `.env`。进程环境变量只能补充文件中缺少的配置项，两处均缺时使用该项的默认值。文件中显式留空的值按该项的空值规则处理。此顺序也适用于 OEE API 地址、凭据和每日分析参数。配置中的相对路径以项目根目录为基准。完整配置见 [.env.example](.env.example)。

Web 和每日分析只从项目 `.env` 读取模型。数据初始化、数据同步和每日任务的 `--dry-run` 可在缺少 `.env` 或模型时运行。

首次启动前：

1. 在项目 `.env` 中设置 `SQL_WEB_PROVIDER`、`SQL_WEB_MODEL`。
2. 在 `.data/agent/models.json` 或 `models-store.json` 中声明模型，凭据放在 `.data/agent/auth.json`；服务不读取用户主目录的 Pi 配置。
3. 创建 `.data/user-dashboards.json`，例如：

```json
{
  "defaultDashboards": ["default"],
  "users": {
    "3000100562": ["analysis", "default"]
  }
}
```

`default` 为综合看板，`analysis` 为分析看板。列表顺序决定标签顺序，未单独配置的账号使用默认列表；修改后重启，仅影响新会话。

使用工号或短域账号登录，密码不保存。登录有效期为 8 小时，服务重启后需重新登录。HTTPS 部署设置 `SQL_WEB_AUTH_COOKIE_SECURE=true`；域验证地址使用 `SQL_WEB_DOMAIN_VERIFY_URL` 配置。

会话及文件按账号保存；共享历史只读，继续对话时复制为个人会话。打开首页或点击“新建会话”会预览当前账号的看板，首次发送问题或上传 Excel 时才创建个人会话，并保存创建时的看板快照。已有会话保留原快照；以前留下的个人空会话也可在历史列表中删除。域登录不限制共享 OEE 数据的查询范围。

## Python 环境

Python 计算与 Excel 共用项目虚拟环境。在项目根目录创建环境并在线安装依赖：

```bash
/usr/bin/python3 -m venv .venv
.venv/bin/python -m pip --disable-pip-version-check --no-cache-dir install \
  --only-binary=:all: --require-hashes \
  -r requirements.txt
```

`requirements.txt` 统一固定 NumPy、SciPy、openpyxl 及其依赖的版本和 wheel 哈希，适用于 Python 3.12 / Linux x86_64。若系统缺少 venv，先安装对应的 `python3.12-venv` 系统包。

网页服务与每日分析默认使用 `.venv/bin/python`，无需激活环境；自定义环境通过 `SQL_WEB_PYTHON_PATH` 指定其 `bin/python`，相对路径以项目根目录为基准。沙箱只读挂载虚拟环境，继续隔离项目数据和网络。安装或更新依赖后重启服务，Agent 不自动安装。旧部署需移除指向系统 Python 的配置；原 `.data/xlsx-python` 不再使用，可在迁移验证后删除。

## Excel 导出与编辑

在网页聊天中要求导出查询结果，或点击上传图标选择普通 `.xlsx` 后描述修改需求，例如：“把数据页 A2 改成文本 0007，B2:B20 显示为百分比”。修改保留原文件并提供新版本下载。

上传和下载文件最多 8 MiB；支持读取、单元格修改、批量填充及常用格式。已有公式保留但不重算，需在 Excel 中重新计算；不支持宏、加密、旧版 `.xls` 或图表等复杂对象。工具参数与详细限制见 [Excel 参考](src/server/skills/xlsx/references/reference.md)。

## 数据同步与定时更新

`data:init` 用于建库或升级结构，不清空已有数据。同步前需初始化数据库；空表首次同步必须提供起始日期：

```bash
# 日期依次为截止业务日、起始业务日，按需替换
npm run data:sync -- all 2026-09-14 2026-09-01
# 后续同步；all 可替换为 availability 或 dut_utilization
npm run data:sync -- all 2026-09-14

# 每日任务：同步目标日、更新看板并按配置发送通知
npm run daily:update -- --dry-run
npm run daily:update
npm run daily:update -- --through-date 2026-09-14

# 安装上海时间每日 09:00 的 cron 任务
npm run schedule:install -- --dry-run
npm run schedule:install
```

业务日为上海时间 08:30 至次日 08:30。每日任务默认处理最近已结束的业务日，不自动补历史缺日；补数使用 `data:sync`。`--dry-run` 仅显示计划。

定时安装要求主机时区为 `Asia/Shanghai`、`cron.service` 已运行。任务共用文件锁，重叠执行会跳过；停机遗漏需手动补数。退出码：`0` 正常、`2` 有警告、`1` 失败。详情见 [数据导入](src/server/skills/test-oee-calculator/references/import-audit.md) 和 [每日运行](src/server/skills/test-oee-calculator/references/daily-dashboard.md)。

## 邮件通知（可选）

在 `.env` 中配置 SMTP 主机、发件地址和显示名，重启后生效：

```dotenv
SQL_WEB_SMTP_HOST=10.71.68.150
SQL_WEB_SMTP_PORT=25
SQL_WEB_MAIL_FROM_ADDRESS='"JV OEE Agent"@sdsscn.com'
SQL_WEB_MAIL_FROM_NAME=JV OEE Agent
```

保留发件地址外层单引号。SMTP 使用无需认证的中继，支持 STARTTLS；未配置时聊天邮件工具关闭。聊天仅在用户明确要求且收件人、内容明确时发送邮件。

每日通知另需创建 `.data/notifications.json`：

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

收件配置每次发送前读取，缺失或关闭时跳过。日改善分析可用且发布成功后发送邮件，同日重跑也会再次发送；邮件失败不回滚看板、不自动重试。

## 文字问答接口

`POST /chat/compeletion` 保留此拼写，无需登录，每次请求独立，不保存到网页历史：

```bash
curl http://127.0.0.1:3000/chat/compeletion \
  -H 'Content-Type: application/json' \
  -d '{"text":"昨天的 MT Effective OEE 是多少？"}'
# {"text":"完整回答内容"}
```

`text` 最多 4000 字符，接口等待完整回答后返回 JSON，不支持看板修改或 Excel 文件处理。其余业务 API 需要登录；健康检查公开。

## 开发与排障

```bash
npm run dev                      # 开发
npm run check                    # 类型检查
npm test                         # 构建并测试
npm run session:html -- latest    # 导出最近会话用于排障
```

日志位于 `.data/logs/`，每日分析产物位于 `.data/daily-analysis/<runId>/`；错误可通过请求 ID 追踪。会话 HTML 默认导出至 `.data/session-exports/`，包含查询和工具数据，按敏感信息保管。

前端位于 `src/client/` 和 `public/`；后端的 Agent、工具、看板及业务 Skill 位于 `src/server/`；运维命令位于 `scripts/`，测试位于 `tests/`。

- [OEE Skill](src/server/skills/test-oee-calculator/SKILL.md)
- [业务公式与筛选规则](src/server/skills/test-oee-calculator/references/business-rules.md)
- [数据库结构](src/server/skills/test-oee-calculator/references/database.md)
- [看板字段映射](src/server/skills/test-oee-calculator/references/dashboard.md)
