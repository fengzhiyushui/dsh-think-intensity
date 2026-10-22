# dsh-think-intensity

<p align="center">
  <strong>DeepSeek Harness (DSH) 思考强度策略插件</strong><br>
  在已有档位之上决定每次请求用哪一档，可观测、可自愈、可回滚。
</p>

<p align="center">
  <a href="https://github.com/fengzhiyushui/dsh-think-intensity/actions/workflows/ci.yml">
    <img src="https://github.com/fengzhiyushui/dsh-think-intensity/actions/workflows/ci.yml/badge.svg" alt="CI Status">
  </a>
  <a href="https://www.npmjs.com/package/dsh-think-intensity">
    <img src="https://img.shields.io/npm/v/dsh-think-intensity.svg" alt="npm version">
  </a>
  <a href="https://github.com/fengzhiyushui/dsh-think-intensity/releases">
    <img src="https://img.shields.io/github/v/release/fengzhiyushui/dsh-think-intensity" alt="GitHub release">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License">
  </a>
  <img src="https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24-brightgreen" alt="Node.js">
  <img src="https://img.shields.io/badge/dsh-%3E%3D0.1.7--rc.1%20%3C0.3.0-orange" alt="DSH Support">
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong>
</p>

---

## 解决的问题

在 DeepSeek Harness (DSH) 中，**模型的“思考强度”（推理等级）不是一个随意的运行时参数，而是一段严格的能力声明**（`reasoningEfforts`）：

1. **官方内置模型**（如 DeepSeek Reasoner、OpenAI o1/o3 等）已内置该声明，因此在输入框点开模型选择时，原生自带第二行【推理等级 >】；
2. **自定义第三方模型**（如阶跃星辰 StepFun `step-5-preview`、智谱 GLM `glm-5.3`、第三方中转站端点等）在添加时，DSH 设置界面并未开放推理档位配置，导致模型缺少 `reasoningEfforts` 声明；
3. **结果**：DSH 客户端默认将它们当作纯文本模型，**隐藏了推理等级菜单**；若强行携带参数还会导致网关报错 `UNSUPPORTED_REASONING_EFFORT`。

**本插件专为解决该痛点而设计：**
- **原生激活**：自动为缺失声明的第三方模型补齐档位映射，**原生唤出 DSH 客户端的【推理等级 >】二级菜单**；
- **显式优先**：只要用户在界面上选了某一档位，插件 100% 尊重并原样放行，绝不修改；
- **缺省策略**：没选档位时，按配置策略（如全局 high、子 agent 独立 max、辅助调用压缩 low）自动注入；
- **自愈防错**：若网关拒绝某档位，会话内自动加入黑名单降级放行，避免死循环重试；
- **安全沙箱**：零侵入，卸载后干净无残留。

---

## 原生交互与视觉体验

本插件**完全复用 DSH 官方客户端原生 UI**，不引入突兀的第三方悬浮窗或重绘组件。在对话框底部点击模型弹出菜单时，呈现官方标准二级菜单：

```text
┌──────────────────────────────────────┐
│ 模型      step-5-preview / glm-5.3   >│
│ 推理等级  High                       >│
└──────────────────────────────────────┘
```

点击 `推理等级`，即可原生展开切换选择：
* `Off`（关闭思考）
* `Low`（低强度）
* `Medium`（中强度）
* `High`（高强度）
* `Max`（最高强度）

---

## 核心策略决策链

插件在每次发起请求时的决策流向如下：

```text
┌──────────────┐
│ 发起 Agent 请求│
└──────┬───────┘
       │
       ▼
 界面是否显式选档? ──(是)──► 100% 保持用户选择不变，直接放行
       │ (否)
       ▼
 是否为子 Agent 会话? ──(是)──► 选用 subagentLevel 配置
       │ (否)
       ▼
 是否为辅助调用 (compaction等)? ──(是)──► 选用 purposeLevels 映射
       │ (否)
       ▼
 选用全局 defaultLevel 配置
       │
       ▼
 能力守卫 (resolveModelInfo)
 ├── 目标模型支持该档位? ──► 注入档位并发送
 ├── 目标模型为非推理模型? ──► 自动剥离残留参数防报错
 └── 命中网关错误黑名单? ──► 自动降级放行
```

---

## 配置文件路径对照

DSH 的配置层存放在各 Profile 目录下的 `cordis.patch.yml` 中：

| 操作系统 | 桌面端客户端路径（默认 Profile 为 `desktop`） | Web 端路径（默认 Profile 为 `web`） |
|---|---|---|
| **Windows** | `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` | `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` |
| **macOS** | `~/.dsh/profiles/desktop/cordis.patch.yml` | `~/.dsh/profiles/web/cordis.patch.yml` |
| **Linux** | `~/.dsh/profiles/desktop/cordis.patch.yml` | `~/.dsh/profiles/web/cordis.patch.yml` |

---

## 启用与配置

在对应 Profile 的 `cordis.patch.yml` 中追加或修改条目配置：

```yaml
- id: think-intensity
  config:
    defaultLevel: high        # 没显式选档的日常对话统一注入 high；留空 = 不干预
    subagentLevel: max        # 子 agent 会话单独跑最高档 max；留空 = 回落 defaultLevel
    providers: []             # 只对列出的 provider 路由生效；空数组 = 全部生效
    purposeLevels:            # 辅助调用分档
      compaction: low         # 记忆压缩等系统内部任务使用低档节省 token
      session-title: off      # 生成会话标题关闭思考
    backfillEnabled: true     # 为缺失档位的第三方模型自动补全声明，激活原生菜单
```

### 完整配置项说明

| 配置键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `defaultLevel` | string | 空 | 全局默认思考档位（`low` / `medium` / `high` / `max` 等）；留空表示不主动干预 |
| `subagentLevel` | string | 空 | 子 agent 会话（`origin === 'subagent'`）默认档位；留空回落到 `defaultLevel` |
| `providers` | string[] | `[]` | 白名单路由列表；为空时对全部路由生效 |
| `purposeLevels` | object | `{}` | 内部任务目的（`purpose`）到档位的映射表 |
| `statsFlushMs` | number | `30000` | 统计信息落盘最小间隔（毫秒），写入 `$DSH_HOME/storages/think-intensity-stats.json` |
| `backfillEnabled` | boolean | `false` | 是否自动回填补齐缺失声明；`false` 为 dry-run（只记录日志不改写） |
| `backfillLevels` | object | `{}` | 回填档位字典；留空时自动使用内置的标准 `DEFAULT_BACKFILL_LEVELS` |
| `routeDefaultLevel`| string | 空 | 路由级默认档位；仅当该路由下所有模型均支持该档时才写入 |

---

## 手动声明第三方模型档位（无需开启自动回填）

如果你希望针对特定模型精确控制档位映射，也可以直接在 `cordis.patch.yml` 的 `llm-pi-ai` 节点下手动添加 `reasoningEfforts`：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      stepfun:
        models:
          - id: step-5-preview
            name: step-5-preview
            contextWindow: 1024000
            reasoningEfforts:
              off: null       # off 表示支持关闭思考，向网关不发送多余参数
              low: low
              medium: medium
              high: high
              max: max
      zai-coding-cn:
        models:
          - id: glm-5.3
            name: GLM-5.3
            contextWindow: 1000000
            maxTokens: 131072
            input:
              - text
            reasoningEfforts:
              off: null
              low: low
              medium: medium
              high: high
              max: max
```

保存后重启 DSH，对话框即刻激活原生选择菜单。

---

## 安装与卸载

### 方式 1：通过 npm 安装（发布后官方推荐）
```bash
# 桌面端安装
dsh plugin --profile desktop add dsh-think-intensity

# Web 端安装
dsh plugin --profile web add dsh-think-intensity
```

### 方式 2：通过 GitHub Release 标签安装（固定版本）
```bash
dsh plugin --profile desktop add github:fengzhiyushui/dsh-think-intensity#v0.1.0
```

### 方式 3：本地源码安装
```bash
dsh plugin --profile desktop add /path/to/dsh-think-intensity
```

### 卸载
```bash
dsh plugin --profile desktop remove dsh-think-intensity

# 检查当前配置确认已彻底剥离
dsh --profile desktop --dump-config
```
> 卸载仅移除插件挂载，不会删除已生成的历史统计文件 `$DSH_HOME/storages/think-intensity-stats.json`（按需手动清理）。

---

## 本地开发与测试

```bash
# 1. 安装依赖（pnpm）
pnpm install

# 2. 编译产物（TSDown 产生 lib/index.js 单文件与 lib/types）
pnpm run build

# 3. 运行 124 项全量单元测试
pnpm run test

# 4. 类型检查
pnpm run typecheck
```

### 测试用例覆盖的核心场景
1. **显式选择优先**：用户界面选档时 100% 放行；
2. **缺省兜底策略**：未选档请求正确注入 `defaultLevel` / `subagentLevel` / `purposeLevels`；
3. **能力守卫**：无档位模型不报错，非推理模型自动剥离残留参数；
4. **自定义 Wire 映射**：如 `high: ultra` 正确发往上游网关；
5. **网关错误自愈**：遇到 `UNSUPPORTED_REASONING_EFFORT` 自动加入会话内黑名单降级；
6. **回填合法性校验**：杜绝写入非法档位声明或空字典；
7. **并发与 HMR 防护**：热安装与配置冲突时延迟重试；
8. **内置标准档位表**：`DEFAULT_BACKFILL_LEVELS` 符合官方 Catalog 规范。

---

## 已知边界与说明

* **自愈黑名单仅保存在内存中**：DSH 重启后黑名单自动清空，避免临时网络波动导致的误判被持久化固化；
* **非推理模型参数剥离**：如果模型本身不支持思考却带了继承档位，插件会主动剥离该参数防止网关报错；这是“显式优先”唯一的安全防护例外。

---

## 开源协议

本项目采用 [MIT License](LICENSE) 许可协议。
