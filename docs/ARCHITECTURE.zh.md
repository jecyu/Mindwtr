# Mindwtr 架构总览（中文）

> 本文是 [docs/ARCHITECTURE.md](./ARCHITECTURE.md)（英文，高层概览）的**中文详细版**，补上了「落到 `file:line`」的实现细节与新人容易踩的坑。
> 建议先读英文版建立整体印象，再用本文查具体机制。
>
> 配套：[ADR 索引](./adr/README.md) · [钉钉待办同步方案](./requirements/钉钉待办同步/钉钉待办同步-设计文档.md)

**怎么读**：第一部分是业务概念（GTD、实体、状态机、视图），第二部分是技术机制（存储、同步、导入、平台）。如果你只是要读懂某个具体方案，直接跳到对应章节。

---

# 第一部分：术语与业务流程

## 1. 一句话定位

Mindwtr 是一个**本地优先（local-first）的 GTD 待办应用**：数据存在你自己的设备上，离线可用，同步是可选的。它用一套共享的 TypeScript 核心（`@mindwtr/core`）驱动桌面、移动、Web、以及 AI 工具接入。

## 2. 核心实体与层级

### 2.1 容器层级

```
Area（领域，如"工作"）
 └─ Project（项目，如"上线 X 功能"）
     └─ Section（章节，项目内的分组）
         └─ Task（任务）

Task 也可以直接挂 Area（无项目时），或什么都不挂（Inbox 收集箱）
Person（人）是独立实体，用于 Waiting For 视图按人筛选
```

定义位置：`packages/core/src/types.ts`

| 实体 | 行号 | 关键字段 | 关系 |
|---|---|---|---|
| `Task` | `:229-276` | 见 §2.2 | 属于 0..1 个 Project / Section / Area |
| `Project` | `:83-108` | `status`(active/someday/waiting/archived)、`areaId`、`isSequential`、`cancelledAt`、`reviewAt` | 属于 0..1 个 Area |
| `Section` | `:110-124` | `projectId`（必填）、`order` | 必属于 1 个 Project |
| `Area` | `:126-137` | `name`、`color`、`icon`、`order` | 顶层容器 |
| `Person` | `:139-149` | `name`、`note`、`referenceLink` | 独立 |

**⚠️ 没有 `parentTaskId`**：任务层级靠 `projectId/sectionId` + `checklist[]` 表达（`types.ts:245`），不是父子任务树。

### 2.2 `Task` 关键字段

| 字段 | 行号 | 语义 |
|---|---|---|
| `id` / `title` | `:230-231` | 主键 / 标题 |
| `status` | `:232` | GTD 主状态机，见 §3 |
| `projectId` / `sectionId` / `areaId` | `:250-253` | 容器。**`projectId` 存在时 `areaId` 会被强制清空**（`task-status.ts:174`） |
| `viewSectionIds` | `:252` | 视图内分组（someday/waiting/focus），**不是 `sectionId`** |
| `completedAt` | `:260` | 完成时间 |
| `cancelledAt` | `:261` | 取消事件时间。**必须带时区**（`task-status.ts:26-53`） |
| `deletedAt` | `:270` | 软删除（进 Trash） |
| `purgedAt` | `:271` | 永久清除，保留 tombstone 供同步 |
| `rev` / `revBy` | `:266-267` | **单调修订号 / 发起设备 id**，同步冲突解决的核心，见 §9 |
| `createdAt` / `updatedAt` | `:268-269` | 时间戳 |
| `order` / `boardOrder` / `focusOrder` | `:272-275` | 三种排序上下文，**状态变更会清空 `boardOrder`**（`store-helpers.ts:294-303`） |

### 2.3 `AppData` 与 `AppSettings`

```ts
// types.ts:602-609
interface AppData {
  tasks: Task[]; projects: Project[]; sections: Section[];
  areas: Area[]; people?: Person[]; settings: AppSettings;
}
```

`AppSettings`（`:546-600`）按组划分：`gtd`（GTD 行为参数）、`appearance`、`features`（功能开关）、`calendar`、`ai`、`network`、`window`、`deviceId` 等。

> **`deviceId` 很重要**：它是 `revBy` 的取值来源。`ensureDeviceId`（`store-helpers.ts:45`）保证它存在。

---

## 3. 任务状态机

### 3.1 七个状态

定义：`task-status.ts:9`（`TASK_STATUS_VALUES`），排序权重 `:11-19`

| 状态 | 权重 | GTD 角色 |
|---|---|---|
| `inbox` | 0 | **未澄清的捕获队列**，新建任务的默认状态（`store-tasks.ts:536`） |
| `next` | 1 | 下一步行动。带未来 `startTime` 的 next 是 tickler，在 Next 视图被延后隐藏 |
| `waiting` | 2 | 等待他人（Waiting For） |
| `someday` | 3 | 将来/也许 |
| `reference` | 4 | 参考资料，**非可行动**。进入此状态会清空所有排程/优先级字段（`store-helpers.ts:60-76`） |
| `done` | 5 | 完成 |
| `archived` | 6 | 归档。**兼作取消态**：`archived` + 合法 `cancelledAt` = 取消 |

### 3.2 关键谓词（写代码时优先用这些，不要自己判 `status ===`）

| 函数 | 行号 | 语义 |
|---|---|---|
| `isTaskFinished` | `task-status.ts:61` | `done \|\| archived` |
| `isTaskCancelled` | `:67` | `archived` **且** `cancelledAt` 合法 |
| `isTaskCompleted` | `:78` | `(done \|\| archived) && !isTaskCancelled` —— **取消是终态但不算完成数据** |
| `isTaskActionable` | `:90` | 排除 `done`/`archived`/`reference` |

### 3.3 状态流转约束（在写路径，不在类型系统里）

集中定义在 `packages/core/src/store-helpers.ts`：

**`normalizeTaskUpdate`（`:181-310`）** —— 纯函数，store 与 cloud REST 共用（注释称之为 "single write path"）

| 规则 | 行号 |
|---|---|
| `cancelledAt` 合法且未显式给 `status` → 自动 `archived` | `:191-198` |
| `status !== 'archived'` → 清空 `cancelledAt` | `:199-207` |
| **star ↔ status 不变量**：给 `inbox` 加星 → 提升为 `next`；把已加星任务降为 `inbox` → 摘星 | `:245-285` |
| 给 `inbox` 设 `startTime` → 提升为 `next` | `:262-267` |
| 状态变更 → 清空 `boardOrder` | `:294-303` |

**`applyTaskUpdates`（`:78-172`）** —— 实际合并

| 流转 | 行号 | 效果 |
|---|---|---|
| → `done` | `:108-124` | 设 `completedAt`、清 `cancelledAt`、摘星；**生成下一个循环实例** |
| → `archived` | `:125-135` | 有 `cancelledAt` → `completedAt = undefined`（取消）；否则保留/补 `completedAt` |
| 终结态 → 非终结态 | `:136-143` | 清 `completedAt` + `cancelledAt`（复活） |
| → `reference` | `:161-166` | 清空所有排程/优先级 |

> **纠偏**：仓库里**不存在**「`inbox` 必须无 `projectId`」的硬约束。反例：`process-inbox-model.ts:1330` 显式创建 `{ status: 'inbox', projectId }`。`inbox` 的语义是"未澄清"，不是"无项目"。

---

## 4. 视图如何筛选任务

### 4.1 视图路由

入口：`apps/desktop/src/App.tsx:1233-1284` 的 `renderView()`。多数列表视图复用同一个 `ListView`，只传不同的 `statusFilter`。

| 视图 | 决定显示的核心条件 | 位置 |
|---|---|---|
| Inbox | `status === 'inbox'` + `isTaskVisibleInInbox`（**刻意忽略 area 筛选**） | `App.tsx:1240`、`ListView.tsx:294` |
| Next Actions | `status === 'next'` + 顺序项目只显示首个未完成 + 未来 start 延后隐藏 | `App.tsx:1246`、`ListView.tsx:570-602` |
| Projects | 项目工作区内：`projectId === project.id && !deletedAt && status !== 'reference'` | `App.tsx:1272`、`ProjectWorkspace.tsx:389` |
| Contexts | `activeTasks` + `status !== 'archived'` + context/tag token 筛选 | `ContextsView.tsx:176-184` |
| Waiting For | `status === 'waiting'` + 可选按人（`getWaitingPerson`） | `App.tsx:1250`、`ListView.tsx:584` |
| Someday | `status === 'someday'` | `menu-views-model.ts:252` |
| Reference | `status === 'reference'` + 可选包含归档项目 | `ListView.tsx:562` |
| Calendar | `isSchedulableCalendarTask`（= `!deletedAt && isTaskActionable`） | `calendar-day-items.ts:43` |
| Board | 5 列 `['inbox','next','waiting','someday','done']` | `BoardView.tsx:65` |
| Review | 排除 `reference`；inbox 走 `isTaskVisibleInInbox`，其余走 `isTaskVisibleInArea` | `ReviewView.tsx:134` |
| Done / Archive | `selectArchivedTasks`：`status === 'archived' && !deletedAt` | `archive-view-model.ts:48` |
| Trash | **读 `_allTasks`**：`deletedAt && !purgedAt` | `TrashView.tsx:71` |

### 4.2 筛选逻辑的单一真源

| 文件 | 职责 |
|---|---|
| `packages/core/src/area-filter.ts` | **区域筛选单一真源**。`isTaskVisibleInArea`(`:164`) 是所有列表的基础可见性（`!deletedAt && isTaskInActiveProject && area 匹配`）；`isTaskVisibleInInbox`(`:177`) 是 Inbox 专用（跳过 area） |
| `packages/core/src/task-query.ts` | **查询契约单一真源**。`taskMatchesQuery`(`:21`) 内存版；`buildTaskWhere`(`:40`) SQL 版。所有读取面（core / SQLite / mobile / MCP / cloud REST）都从 `TaskQueryOptions` 派生 |
| `packages/core/src/view-sections.ts` | 视图内分组（`viewSectionIds`） |
| `packages/core/src/menu-views-model.ts` | 共享视图模型（Waiting / Someday / 状态列表） |
| `packages/core/src/project-utils.ts` | `isTaskInActiveProject`(`:143`)：`projectId` 为空 → true；项目不存在 → true（宽容） |

---

## 5. 一次写入的生命周期

### 5.1 新建任务

```
UI（QuickAddModal / ListView）
 └─ executeCaptureTransaction(input, actions)          capture.ts:397
      ├─ planCaptureTask()  解析标题/日期/token
      ├─ actions.addProject()  必要时先建项目
      └─ actions.addTask() → addTasks([...])           store-tasks.ts:430 / :453
           ├─ 校验 captureId（UUID）与 cancelledAt 时区
           ├─ resolveCaptureStatusForStart()           store-helpers.ts:387  (inbox+startTime → next)
           ├─ 构造 Task（默认 status: 'inbox'）         store-tasks.ts:536
           └─ set(...) + persist() → debouncedSave
```

**幂等性**由 `captureId` 保证：`addTasks` 里 `knownTaskIds.has(item.captureId)` 直接返回已存在 id（`store-tasks.ts:502-505`）。

### 5.2 完成任务

```
UI
 └─ moveTask(id, 'done')                                store-tasks.ts:1510
      └─ updateTask(id, { status: 'done' })             store-tasks.ts:663
           ├─ prepareTaskUpdatesForStore()              store-tasks.ts:374
           │    ├─ normalizeTaskUpdate()                store-helpers.ts:181
           │    └─ buildTaskContainerMovePatch()        task-container-rules.ts:217
           └─ applyTaskUpdates(oldTask, patch, now)     store-helpers.ts:78
                └─ → completedAt=now, 生成下个循环实例
```

**取消**走另一条路：`cancelTask`(`store-tasks.ts:956`) = `updateTask(id, { status:'archived', cancelledAt })`，然后**显式 `await flushPendingSave()`**（`:978`）——取消是终态决策，必须立刻落库。

### 5.3 三个关键机制各解决什么问题

| 机制 | 位置 | 解决的问题 |
|---|---|---|
| `flushPendingSave` | `store.ts:467-581` | **写合并与崩溃安全**。`debouncedSave` 只入队，65ms 后合并 flush；`flushPendingSave` 取队列中版本号最大的快照落盘，失败指数退避重试 |
| `executeCaptureTransaction` | `capture.ts:397-438` | **多步写入的原子语义**。捕获可能要先建项目再建任务，此函数统一失败码，避免各 UI 面各自手写而漏掉回滚 |
| `runAfterStoreWriteLock` | `data-transfer-transaction.ts:38-41` | **整文档写入与普通编辑的互斥**。导入/恢复/同步会「读全文档 → 替换全文档」，这期间普通编辑必须等待，否则会被覆盖丢失 |

---

# 第二部分：技术架构

## 6. Monorepo 布局

Bun workspace（`package.json:5-8`：`apps/*` + `packages/*`）

| 路径 | 包名 | 职责 |
|---|---|---|
| `packages/core` | `@mindwtr/core` | **共享领域模型**：Zustand store、quick-add 解析、重复规则、同步/合并算法、存储适配器接口、i18n、导入导出 |
| `apps/desktop` | `mindwtr` | Tauri v2 + React 桌面壳 |
| `apps/mobile` | `mobile` | Expo / React Native 移动壳 |
| `apps/cloud` | `mindwtr-cloud` | 自托管同步服务端 + REST API |
| `apps/mcp-server` | `mindwtr-mcp` | 把 Mindwtr 暴露为 MCP server |
| `apps/android-native` | — | Android 原生侧构建产物/脚本（非 JS workspace） |

**设计原则**（`docs/ARCHITECTURE.md:3`）：core 独占数据模型与同步规则，四个壳层保持薄。

### 运行入口

| 命令 | 实际执行 | 用途 |
|---|---|---|
| `bun run desktop:web` | `vite` | **只跑渲染层**（浏览器 5173），秒级启动 |
| `bun run desktop:dev` | `bunx tauri dev` | 完整桌面 App（含 Rust，首次需编译） |
| `bun run mobile:start` / `mobile:android:dev` | `expo start` / prebuild + run | 移动端 |
| `bun run --filter mindwtr-cloud dev` | `bun run src/server.ts` | 自托管服务端 |
| `bun run mindwtr:cli -- <cmd>` | `scripts/mindwtr-cli.ts` | CLI 子命令操作数据 |

---

## 7. core 的分层

| 层 | 代表文件 | 职责 |
|---|---|---|
| 类型 | `types.ts` | 实体与设置类型 |
| 状态 | `store.ts`（工厂与持久化引擎）、`store-types.ts`（接口）、`store-tasks.ts`、`store-settings.ts`、`store-projects.ts` | Zustand store |
| 纯函数 | `store-helpers.ts`、`task-status.ts`、`area-filter.ts`、`task-query.ts` | 无副作用的规则层 |
| 存储 | `storage.ts`（适配器接口）、`sqlite-adapter.ts` | 持久化抽象 |
| 同步 | `sync.ts`、`sync-revision.ts`、`sync-tombstones.ts`、`sync-backend-io.ts` | 合并与后端 |
| 导入 | `import-apply.ts`、`import-runner.ts`、各 `*-import.ts` | 第三方数据导入 |
| 平台无关 | `i18n/`、`uuid.ts`、`date.ts` | 工具 |

### Zustand store 的约定

- **读**：`useTaskStore` selector，或语义化 hook（`useTaskById` `store.ts:751`、`getDerivedState()`）
- **写**：**只能调 store action**，不直接 `setState`。所有写动作经 `wrapStoreWriteActions`(`store.ts:666`) 包上 `runAfterStoreWriteLock`
- **`_allTasks` vs `tasks`**：`tasks` 是 `_allTasks` 去掉 `deletedAt` 和 `archived` 的**投影**。写动作必须写 `_allTasks`（直接写 `tasks` 在 development 下抛 `TaskStore invariant violated`，`store.ts:293`）。**Trash 与 Archive 必须读 `_allTasks`**
- **`mutateTasks`**（`store-tasks.ts:284-331`）是批量写入的统一入口，统一负责 `ensureDeviceId`、`updatedAt`、**`rev: nextRevision(task.rev)` + `revBy`**、落盘

---

## 8. 数据持久化

### 8.1 核心原则：SQLite 是主存储，JSON 是同步快照桥

ADR 依据：[0009-sqlite-json-sync-bridge](./adr/0009-sqlite-json-sync-bridge.md)、[0004-sqlite-wal-fts5](./adr/0004-sqlite-wal-fts5.md)

| 文件 | 角色 |
|---|---|
| `mindwtr.db` | **主存储（本地唯一真相）**，WAL + FTS5 |
| `data.json` | **同步/备份快照**（传输格式，非运行时本地真相） |
| `config.toml` / `secrets.toml` | 配置与密钥，**不参与同步** |

> **⚠️ 常见误区**：运行时读的是 **SQLite**，不是 `data.json`。`data.json` 只在首次迁移、兜底、备份时读。

### 8.2 存储适配器

接口：`packages/core/src/storage.ts:28-37`
```ts
interface StorageAdapter {
    getData(): Promise<AppData>;
    saveData(data: AppData): Promise<AppData | void>;
    saveTask?: (task, snapshot?) => Promise<void>;
    queryTasks?: (options) => Promise<Task[]>;
    searchAll?: (query) => Promise<SearchResults>;
}
```

注册：`setStorageAdapter`（`store.ts:36`）—— **必须在用 store 之前调用**（装配点 `apps/desktop/src/main.tsx:98`）。

| 端 | 实现 |
|---|---|
| 桌面（Tauri） | `apps/desktop/src/lib/storage-adapter.ts:307-500` → `invoke('get_data')` / `invoke('save_data', {data, baselineEntities})` |
| 桌面（浏览器） | `storage-adapter-web.ts` |
| 移动 | `apps/mobile/lib/storage-adapter.ts`（op-sqlite 主路径） |

### 8.3 Rust 侧与行级 CAS

| 命令 | 位置 | 行为 |
|---|---|---|
| `get_data` | `storage.rs:3934` | 冷启动读；SQLite 无数据且 `data.json` 存在时**一次性**迁移；之后以 SQLite 为准 |
| `save_data` | `storage.rs:3999` | `mode=merge`（默认）按行合并；`mode=exact` 整表替换（restore/import 用） |

**行级 CAS**（`storage.rs:3005-3074`）：
- `baseline_matches`：只有调用方观测到的那一行**仍是当前 canonical** 时才允许替换/删除
- 替换守卫：`entity_revision(target) >= entity_revision(canonical)` 才接受 —— **CAS 永不授权把 rev 回退**（`:3035-3042`）
- 无 baseline 时退化为逐行 LWW：排序键 `rev` → `updatedAt` → `revBy` → 内容签名（`:2975-2987`）

> **⚠️ `save_data` 普通路径不会自动 bump `rev`** —— 传入行的 `rev` 原样保留。这是很多同步问题的根因（见 §9.4）。

---

## 9. 同步机制

### 9.1 条目级合并，不是整文件覆盖

`mergeEntitiesWithStats`（`sync.ts:360-796`）：按 `id` 建 map，对并集逐条裁决。入口 `mergeAppDataWithStats`(`:846`)。

### 9.2 裁决顺序（**这是理解一切同步行为的关键**）

| 顺序 | 条件 | 行号 | 逻辑 |
|---|---|---|---|
| 1 | 一方删、一方活 | `:606-631` | 走 `resolveDeleteVsLiveWinner`（ADR 0007） |
| 2 | `revDiff !== 0` | `:633-634` | **`rev` 高者胜** |
| 3 | `updatedAt` 不同 | `:635-636` | **时间晚者胜** |
| 4 | 两侧 `revBy` 都非空且不同 | `:639-640` | **`revBy` 字典序大者胜** |
| 5 | 否则 | `:642` | 内容签名（保证两端收敛） |

**`revBy` 只在两侧都非空时参与**（`:637-639` 注释：避免"部分元数据静默获胜"）。

### 9.3 tombstone 如何防止删除被复活

| 机制 | 位置 |
|---|---|
| 删/活冲突专用裁决；`|diff| <= DELETE_VS_LIVE_AMBIGUOUS_WINDOW_MS` 时：有 rev 且不等 → rev 高者胜；否则**有 rev 时活者胜**，legacy 无 rev 时删除者胜 | `sync.ts:552-604` |
| 过期清理：`DEFAULT_TOMBSTONE_RETENTION_DAYS = 90` | `sync-tombstones.ts:6`、`purgeExpiredTombstones`(`:123`) |

### 9.4 修订号机制

`packages/core/src/sync-revision.ts`

| 项 | 值 |
|---|---|
| 上限 | `MAX_SYNC_REVISION = 2_147_483_647`（`:3`，ADR 0015） |
| `nextRevision(value)` | 非法 → 1；已达上限 → **保持上限不溢出**并告警；否则 +1 |

**谁会 bump `rev`**：

| 侧 | 结论 |
|---|---|
| TS 业务写 | **会**，每个写操作显式 `nextRevision(prev.rev)`（`store-helpers.ts`、`store-tasks.ts`、`import-apply.ts` 等多处） |
| Rust `save_data` 普通路径 | **不会**，原样保留 |
| Rust 修复路径 | 会（`stamp_reference_repair`，`storage.rs:2364`） |

> **实践含义**：如果你自己改 `AppData` 里某条实体却忘了 `rev: nextRevision(old.rev)`，这次修改**在同步时可能输给远端旧值**（因为 rev 没涨）。这是本仓库最容易被忽略的规则之一。

### 9.5 `mergeConflict` 钩子不是"决定胜负"

唯一调用点 `sync.ts:766`：
```ts
const mergedItem = mergeConflict ? mergeConflict(local, incoming, winner) : winner;
```
**胜者已由 §9.2 决定**，钩子只做胜者的**字段级修补**（附件合并、向前兼容、序列修复）。

### 9.6 支持的后端

`SyncBackend = 'off' | 'file' | 'webdav' | 'cloud' | 'cloudkit'`（`sync-service-utils.ts:4`）

> **⚠️ Dropbox 不是独立 backend**，而是 `cloud` 下的 `cloudProvider`（`sync-service-utils.ts:5`）。

---

## 10. 导入子系统（第三方数据导入）

> 这一节是理解 [钉钉待办同步方案](./requirements/钉钉待办同步/钉钉待办同步-设计文档.md) 的前置。

### 10.1 调用链

```
UI
 └─ apps/desktop/src/lib/data-transfer.ts:440  importDesktopOmniFocusData
      └─ packages/core/src/import-runner.ts:348  runImport
           └─ packages/core/src/omnifocus-import.ts:1216  applyOmniFocusImport
                └─ packages/core/src/import-apply.ts:171  applyImport   （纯函数）
      └─ packages/core/src/data-transfer-transaction.ts:132  runDataTransferTransaction
```

`runDataTransferTransaction` 提供的保证：`flushPendingSave` → 读快照 → `apply` → `ensureFresh`（陈旧检测）→ 恢复快照 → 持久化 → `markNextLoadAsDocumentReplacement` → 刷新 store，全程在文档写队列与写锁内。

### 10.2 `applyImport` 的两个核心语义

**① `sourceKey` 是身份**（`import-apply.ts`）
- 每个导入实体必须提供 `sourceKey`（`:74` 注释说明这是 REQUIRED，缺失会全部塌缩成同一个 id）
- `idFor(kind, sourceKey)` 把它映射成稳定 id。**默认实现是 `uuidv4()`**（`:191`）—— 不传 `idFor` 就**没有幂等性**，每次导入都会新建重复数据
- 各导入器的既有实现：`generateDeterministicUUID`（`uuid.ts:69`）+ 命名空间，如 `mindwtr:ticktick-import:v1:${kind}:${sourceKey}`（`ticktick-import.ts:27-33`）

**② 重复导入是「跳过」，不是「更新」**（`:431-436`）
```ts
if (existingTaskIds.has(taskId)) {
    if (deletedTaskIds.has(taskId)) skippedDeletedTaskCount += 1;
    else skippedExistingTaskCount += 1;
    return;                    // ← 一个字段都不更新
}
```
- ✅ 好处：天然幂等；用户删过的实体有墓碑，不会被复活（测试见 `import-apply.test.ts:180`）
- ❌ 代价：**已存在实体的任何字段变化都不会被同步**。如果需求是"远端变了要跟着变"，必须自己在 `applyImport` 之后补一个更新步骤

仓库里唯一的"applyImport 之后打补丁"先例是 Mindwtr CSV 的 post-apply 迁移（`mindwtr-csv-import.ts:1096`），它带一个 provenance 守卫（`:949`）：只对「导入后从未被用户编辑过」的任务做迁移。

### 10.3 相关的导入器

`packages/core/src/` 下：`todoist-import.ts`、`ticktick-import.ts`、`omnifocus-import.ts`、`mindwtr-csv-import.ts`、`dgt-import/`、`legacy-json-import.ts`。共享的字节/CSV 机制在 `import-source-reader.ts`，诊断在 `import-diagnostics.ts`。

---

## 11. 平台壳层

### 11.1 桌面端（`apps/desktop`）

**前端**：React 19 + Vite 7 + TypeScript + Zustand + Tailwind + dnd-kit

| 目录 | 职责 |
|---|---|
| `src/components/views/` | 各功能视图 |
| `src/lib/` | **平台集成层（最厚）**：`tauri-invoke.ts`、`tauri-http.ts`、`storage-adapter.ts`、`sync-service.ts`、`data-transfer.ts`、`notification-service.tsx` 等 |
| `src/store/` | 桌面专有 Zustand store（`ui-store.ts` 等），区别于 core 的领域 store |
| `src/contexts/`、`src/hooks/` | React Context 与 hooks |

**Rust 侧**（`apps/desktop/src-tauri/src/`，crate 名 `app_lib`）：

| 模块 | 负责 |
|---|---|
| `storage.rs` | SQLite 主存储、任务 CRUD、快照 |
| `config.rs` | 配置与密钥（含 keyring） |
| `sync.rs` | 各同步后端实现与附件发布 |
| `sync_crypto.rs` / `sync_encryption.rs` | MWENC1 加密容器与设备本地密钥缓存 |
| `local_api.rs` | 应用内本地 HTTP API server |
| `platform.rs` | macOS 日历 / CloudKit、`open_path`、附件导入 |
| `ui.rs` / `window_state.rs` | 窗口 / 托盘 / 快速添加窗口 / 全局快捷键 |
| `audio.rs` | 录音 + whisper 转写 |
| `obsidian_*.rs` | Obsidian vault 扫描 / 监听 / 写回 |

**渲染进程 ↔ Rust 通信**：
- `invokeNative`（`src/lib/tauri-invoke.ts:96`）→ `@tauri-apps/api/core` 的 `invoke`
- `invokeNativeOr`（`:108`）无 Tauri 运行时返回 fallback，调用方不必自己 guard
- **沙箱模式有命令白名单**（`tauri-invoke.ts:4-14`，仅 5 个命令）
- 命令注册：`src-tauri/src/lib.rs:1750-1907` 的 `generate_handler![...]`

**哪些能力必须走 Rust**：文件系统/SQLite（WebView 无法直接读）、keyring（OS 钥匙串）、原生对话框、**HTTP 代理**（需要系统代理与 TLS 链）、系统日历/通知/托盘、音频录制、本地 API server。

### 11.2 移动端（`apps/mobile`）

Expo ~54 + React Native 0.81 + expo-router（文件式路由，`app/` 目录）。

- **共享**：`@mindwtr/core` 全部领域逻辑（Metro 为 monorepo 做了 alias，`metro.config.js`）
- **独有**：op-sqlite、expo-calendar、通知、expo-secure-store、Widget、Watch、whisper.rn 等
- `modules/` 下有 **20 个 Expo Module**（Android/iOS 原生能力），如 `android-widget`、`ios-widget`、`cloudkit-sync`、`watch-connectivity`

### 11.3 服务端与工具

| 组件 | 说明 |
|---|---|
| `apps/cloud` | Bun 运行时单文件服务端，**直接 import core 的同步函数**做合并；Docker 部署见 `docker/compose.yaml` |
| `apps/mcp-server` | 把 Mindwtr 暴露给 AI 工具。stdio（默认）或 `--http`；**默认只读**，`--write` 才解锁写工具；HTTP 模式**强制 token** |
| `scripts/mindwtr-cli.ts` | CLI 子命令：`add` / `list` / `get` / `update` / `complete` … |
| `scripts/mindwtr-api.ts` | 常驻本地 HTTP 服务（默认 4317），需 `MINDWTR_API_TOKEN` |

> **⚠️** `scripts/mindwtr-api.ts` 与桌面 App 内 Rust 实现的 `local_api.rs` 是**两个不同的本地 API**，别混淆。

---

## 12. 凭证存储与出站 HTTP

### 12.1 凭证

| 位置 | 用途 |
|---|---|
| OS keyring | **真正的密钥**（AI key、WebDAV 密码、cloud token、Dropbox token、邮件采集密码） |
| `secrets.toml` | keyring 不可用时的**明文回退**（会 emit `keyring-fallback-warning`） |
| `config.toml` | 非敏感配置 |

范式：`get_ai_key` / `set_ai_key`（`src-tauri/src/config.rs:2070` / `:2116`），渲染侧封装 `apps/desktop/src/lib/ai-config.ts:149-177`。

> **⚠️ 空值语义是 delete**：`set_ai_key` 传空会**清除**凭证。UI 上"留空保存"必须显式设计为"保持原值"，否则会误抹。

### 12.2 出站 HTTP

```ts
// apps/desktop/src/lib/tauri-http.ts:139
export const getTauriHttpFetch = async (): Promise<TauriHttpFetch | undefined> => { ... }
```

- 走 `@tauri-apps/plugin-http`，请求由 **Rust reqwest 发出** → **绕过 CORS 与 CSP**，并支持系统代理
- 已处理 plugin-http 的 `ReadableStream` cancel 崩溃 bug（`tauri-http.ts:44-124`）
- **⚠️ 反例**：`useAiSettings.ts:277` 的 `fetchProviderModelsCached` 用浏览器 `globalThis.fetch`，在桌面端会受 CORS 限制 —— 不要照抄

### 12.3 CSP

`src-tauri/tauri.conf.json:28` 单字符串策略。要点：`script-src 'self'`、`connect-src` 允许 `ipc:` / `localhost:*` / **`https:`（裸通配，任意 HTTPS 源）**、`object-src 'none'`。

> 静态 PWA 的 `apps/desktop/public/_headers` 与 `docker/app/nginx.conf` 必须**逐字节一致**（`security-headers.test.ts:75-90` 断言）。

---

# 第三部分：常见误区与验证

## 13. 新人常见误区速查

| 误区 | 事实 |
|---|---|
| 运行时读 `data.json` | 读 **SQLite**；`data.json` 只在首迁/兜底/备份读 |
| 桌面命令叫 `load_data` | 叫 **`get_data`**（`storage.rs:3934`） |
| Dropbox 是独立同步后端 | 是 `cloud` 下的 `cloudProvider` |
| `revBy` 总是参与冲突裁决 | 仅**两侧都非空**时（`sync.ts:639`） |
| `mergeConflict` 决定胜者 | 它只做胜者字段修补；胜者由裁决顺序决定 |
| 改实体不用管 `rev` | **必须显式 `nextRevision`**，否则修改可能在同步时输给远端旧值 |
| 同步会锁住 UI | 不锁；靠新鲜度守卫 + 重排 |
| 导入是"更新"语义 | 是 **"跳过"** 语义（`import-apply.ts:431`） |
| 不传 `idFor` 也能幂等 | 默认是 `uuidv4()`，**每次都会重复插入** |
| `status === 'archived'` 就是完成 | 可能是**取消**；用 `isTaskCompleted` 区分 |
| `inbox` 必须无 `projectId` | 无此约束；`inbox` 的语义是"未澄清" |
| 有项目时还能挂 `areaId` | 有 `projectId` 时 `areaId` 会被强制清空 |
| `viewSectionIds` 就是 `sectionId` | 前者是视图内分组，后者是项目内章节 |
| 直接写 `state.tasks` | 必须写 `_allTasks`；Trash/Archive 必须读 `_allTasks` |
| 凭证放 settings 就行 | 密钥走 **OS keyring**；空值保存是 **delete** |

## 14. 开发与验证入口

`bun run verify` = `typecheck && lint:all && test && native:test && test:governance && i18n:check && schema:check && docs:check-readme`

| 层 | 命令 | 框架 |
|---|---|---|
| core 单测 | `bun run --filter @mindwtr/core test` | vitest |
| desktop 单测 | `bun run --filter mindwtr test` | vitest + Testing Library + vitest-axe |
| mobile 单测 | `bun run --filter mobile test` | vitest |
| cloud / mcp | `bun run --filter mindwtr-cloud test` / `mindwtr-mcp test` | `bun test` |
| e2e | `bun run test:e2e` | Playwright（webServer = `bun desktop:web`，5173） |
| Rust | `bun run native:test` | cargo test |
| i18n 对齐 | `bun run i18n:check` | `scripts/i18n-locale-parity.ts` |

> **i18n 的坑**：`full-parity` 语言（`zh-Hans`/`zh-Hant`/`es`/`hu`/`uk`/`ja`/`fa`/`sv`/`da`，共 9 种）新增英文 key 后必须**手写翻译**；直接抄英文会被判错，且 `--fix` 会把它删掉造成死循环。

---

## 附：权威文档索引

| 主题 | 位置 |
|---|---|
| 英文架构概览 | [docs/ARCHITECTURE.md](./ARCHITECTURE.md) |
| 架构决策记录 | [docs/adr/](./adr/README.md)（29 篇，含 SQLite/JSON 桥、同步修订、tombstone 策略） |
| 同步算法（面向用户） | https://docs.mindwtr.app/data-sync/sync-algorithm |
| 贡献指南 | [docs/CONTRIBUTING.md](./CONTRIBUTING.md) |
| 性能指南 | [docs/performance/](./performance/) |
