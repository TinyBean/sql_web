# DataLens：SQLite 数据库问答网站

一个使用严格 TypeScript 构建、可直接本地运行的数据库问答 MVP。浏览器中的每个会话都直接对应一个 `pi-coding-agent` 持久化 session；Agent 不加载 Pi 的原生工具、项目扩展、技能或上下文文件，只能调用两个数据库工具。

## 已实现

- 前端会话与 Pi `sessionId` 一一对应，刷新或重启服务后可恢复历史。
- 流式展示回答、数据库工具执行状态，并支持停止当前回答。
- 严格的工具 allowlist：`query_database` 与 `execute_database`。
- `query_database` 使用 SQLite 只读连接，结果最多返回 200 行。
- `execute_database` 只接受单条 `INSERT`、`UPDATE`、`DELETE` 或 `REPLACE`，并使用事务。
- 自动创建 SQLite 演示库，包含客户、商品、订单、订单明细以及一个明细视图。
- 记录 Agent 会话、轮次、工具调用、重试和服务生命周期日志，并按天滚动。
- 响应式 Web UI、Schema 查看器、示例业务问题和持久会话列表。

## 模块设计

```text
Browser session id (= Pi sessionId)
              │
              ▼
       AgentSessionStore
       ├─ Pi SessionManager ── .data/sessions/*.jsonl
       ├─ Pi ModelRuntime ──── .data/agent/
       └─ exact tool allowlist
              │
       ┌──────┴────────┐
       ▼               ▼
 query_database   execute_database
  (read-only)      (controlled write)
       └──────┬────────┘
              ▼
       .data/demo.sqlite
```

HTTP 层只调用 `AgentSessionStore` 和 `DemoDatabase` 的小接口，不需要理解 Pi 的会话文件格式或 SQLite 的安全约束。

运行日志使用 JSON Lines 格式写入 `.data/logs/sql-web-YYYY-MM-DD.log`。文件名按服务器本地日期计算，跨过午夜后自动写入下一天的文件，无需重启服务。Agent 日志包含 session ID、轮次、工具名、耗时、重试和错误信息；为避免把业务数据扩散到日志中，不记录用户问题正文、工具参数、查询结果或模型回答正文。

## TypeScript 结构

```text
src/                 Node.js 后端源码
client/              浏览器端源码
client/api-contracts.ts  HTTP 与 SSE 运行时解码器
shared/contracts.ts  HTTP、会话和 SSE 共享类型
test/                TypeScript 测试
public/              HTML、CSS 和生成的浏览器 JavaScript
dist/                编译后的后端与测试
```

服务端和客户端使用独立的 `tsconfig`：服务端采用 `NodeNext`，客户端只加载 DOM 类型。公共配置启用了 `strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`noPropertyAccessFromIndexSignature` 与 `erasableSyntaxOnly` 等严格检查。

源码中的相对导入统一使用 `.ts` 后缀；TypeScript 通过 `rewriteRelativeImportExtensions` 在构建时改写为运行时需要的 `.js`。因此 `dist/`、`public/generated/`、HTML 脚本地址和 `package.json` 启动命令中出现 `.js` 属于编译产物，不是 JavaScript 源码残留。

浏览器不会直接相信 `fetch` 或 SSE 返回值。`client/api-contracts.ts` 从 `unknown` 开始逐字段验证完整响应，后端响应对象同时使用共享类型进行 `satisfies` 校验，避免仅靠泛型断言掩盖协议漂移。浏览器产物生成到 `public/generated/`，`dist/` 与生成文件均不纳入版本控制。

## 环境要求

- Node.js 22.19 或更高版本（使用内置 `node:sqlite`）
- `.data/agent/` 中已准备好 Pi 模型目录与模型凭据

当前项目固定使用 `@earendil-works/pi-coding-agent@0.84.4`。服务仅从项目内的 `.data/agent/` 加载 Pi 配置，不读取用户主目录下的全局 Pi 配置：

- `.data/agent/models-store.json`：Pi 缓存的模型目录。
- `.data/agent/models.json`：可选的自定义模型或覆盖配置。
- `.data/agent/auth.json`：模型凭据；也可以使用对应提供方的 API Key 环境变量。

`models-store.json` 与 `models.json` 至少要存在一个。模型选择不读取 Pi 默认值，而是由项目根目录 `.env` 中的 `SQL_WEB_PROVIDER` 和 `SQL_WEB_MODEL` 明确指定。

## 启动

```bash
npm install
cp .env.example .env
npm start
```

`npm start` 会先进行完整 TypeScript 构建，再运行 `dist/src/server.js`。打开 <http://127.0.0.1:3000>。

开发模式：

```bash
npm run dev
```

开发命令会同时监听后端和客户端 TypeScript；也可以单独运行 `npm run dev:server` 或 `npm run dev:client`。

测试、类型检查与单独构建：

```bash
npm test
npm run check
npm run build
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP 监听地址 |
| `PORT` | `3000` | HTTP 端口 |
| `SQL_WEB_DB_PATH` | `.data/demo.sqlite` | SQLite 文件位置 |
| `SQL_WEB_SESSION_DIR` | `.data/sessions` | Pi session 文件目录 |
| `SQL_WEB_PROVIDER` | 必填 | `.env` 中指定的模型提供方 |
| `SQL_WEB_MODEL` | 必填 | `.env` 中指定的模型 ID |

启动时会自动读取项目根目录的 `.env`，缺少文件或任一模型字段都会直接报错。所选的 `provider/model` 必须能由 `.data/agent/models-store.json` 或 `.data/agent/models.json` 解析。例如：

```bash
SQL_WEB_PROVIDER=zai
SQL_WEB_MODEL=glm-5.3-flash
```

## 演示数据

数据库启动时执行 [`sql/schema.sql`](sql/schema.sql) 和 [`sql/seed.sql`](sql/seed.sql)。种子数据使用固定主键与 `INSERT OR IGNORE`，所以服务重启不会覆盖 Agent 或用户后续做出的数据修改。

可尝试：

- “哪个城市的客户贡献收入最高？请排除已取消订单。”
- “统计每个商品分类的销量和销售额。”
- “列出库存低于 20 的商品。”
- “按月统计 2025 年非取消订单的数量和收入趋势。”

## 安全边界

这是本地 MVP，不包含登录、租户隔离、审计审批或生产级限流。虽然 Agent 工具已经隔离，写工具仍会直接修改演示库；上线前应增加用户鉴权、数据库账号级权限、写操作确认/审批、审计日志与独立数据库沙箱。
