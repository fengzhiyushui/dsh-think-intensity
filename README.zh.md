# dsh-think-intensity

DSH 思考强度策略插件：**在模型已有档位之上决定每次请求用哪一档**，并让每次干预变得可观测、可回滚。

- **显式优先**：用户在界面上手动选了档位，插件绝不干预、原样放行；
- **缺省策略**：没选档的请求按配置注入（如子 agent 跑 max、日常对话跑 high）；
- **能力守卫**：注入前校验模型能力，非推理模型自动剥离残留参数防报错；
- **自愈降级**：网关返回 `UNSUPPORTED_REASONING_EFFORT` 时，自动在会话内加入黑名单，避免死循环重试；
- **开箱即用回填**：内置常用档位表 `DEFAULT_BACKFILL_LEVELS`，支持为缺失档位的第三方模型补齐声明。

---

## 交互模式与官方原生菜单

本插件**完全复用并尊重 DSH 官方客户端的原生交互体验**。在对话框底部点击模型弹出菜单时，支持思考的模型原生展示二级菜单：

```text
┌──────────────────────────────────────┐
│ 模型      DeepSeek-V4.1-Flash / ...  >│
│ 推理等级  High                       >│
└──────────────────────────────────────┘
```

点击 `推理等级`，可原生展开选择 `Off / Low / Medium / High / Max`。

### 为什么部分第三方模型默认看不到这行菜单？
DSH 对话框底部是否渲染【推理等级】行，严格取决于模型配置中是否带有 `reasoningEfforts` 声明字典。官方内置模型默认携带；而用户手动添加的第三方模型（如阶跃星辰 `step-5-preview`、智谱 `glm-5.3` 等）若未声明，DSH 会将其视为纯文本模型，隐藏该菜单行。

### 本插件与该交互的配合：
1. **用户界面手动选档（显式优先）**：只要你在菜单中手动选择了某一档，本插件判定为显式干预，**100% 尊重并原样放行**；
2. **缺省自动兜底**：在新会话或未显式选档的请求中，自动注入配置的 `defaultLevel` 或 `subagentLevel`；
3. **自动回填激活**：只需配置 `backfillEnabled: true`，插件加载时会自动扫描并补全未声明的第三方模型，瞬间激活该二级菜单。

---

## 启用配置

在你的 DSH Profile 对应的 `cordis.patch.yml` 中（桌面端默认为 `$DSH_HOME/profiles/desktop/cordis.patch.yml`，Web 端为 `$DSH_HOME/profiles/web/cordis.patch.yml`）按 id 覆盖配置：

```yaml
- id: think-intensity
  config:
    defaultLevel: high        # 没选档的请求统一 high；留空 = 不干预
    subagentLevel: max        # 子 agent 会话单独一档；留空 = 回落 defaultLevel
    providers: []             # 只对列出的 provider 生效；空 = 全部生效
    purposeLevels:            # 辅助调用分档
      compaction: low
      session-title: off
    backfillEnabled: true     # 为缺失档位的第三方模型自动补全声明，激活原生菜单
```

### 全部配置项

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `defaultLevel` | 空 | 全局默认思考档位（DSH 档位 id）；留空 = 不干预 |
| `subagentLevel` | 空 | 子 agent 会话（`origin === 'subagent'`）独立档位；留空 = 回落到 defaultLevel |
| `providers` | `[]` | 生效的 provider 白名单；空数组 = 全部生效 |
| `purposeLevels` | `{}` | 辅助调用分档映射（如 `compaction: low`, `session-title: off`） |
| `statsFlushMs` | `30000` | 统计落盘最小间隔（毫秒），写入 `$DSH_HOME/storages/think-intensity-stats.json` |
| `backfillEnabled` | `false` | 是否真正写入缺失的 `reasoningEfforts` 声明（默认 dry-run 只报告） |
| `backfillLevels` | `{}` | 回填档位字典；留空时自动使用内置标准档位 `DEFAULT_BACKFILL_LEVELS` |
| `routeDefaultLevel` | 空 | 路由默认候选档位；仅当路由内所有模型均支持时才写入 |

---

## 手动为第三方模型配置档位示例

如果不使用自动回填，也可以直接在 `cordis.patch.yml` 的 `llm-pi-ai` 中为模型添加 `reasoningEfforts`：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      stepfun:
        displayName: 阶跃星辰
        apiKeyEnv: STEPFUN_API_KEY
        api: openai-completions
        baseURL: https://api.stepfun.com/step_plan/v1
        models:
          - id: step-5-preview
            name: step-5-preview
            contextWindow: 1024000
            reasoningEfforts:
              off: null
              low: low
              medium: medium
              high: high
              max: max
```

重启 DSH 桌面客户端后，该模型即刻在输入框激活官方原生【推理等级】选择菜单。

---

## 安装与卸载

```bash
# 从 GitHub 安装（桌面端 profile 名通常为 desktop）
dsh plugin --profile desktop add github:fengzhiyushui/dsh-think-intensity#<sha>

# 本地目录安装
dsh plugin --profile desktop add .

# 卸载
dsh plugin --profile desktop remove dsh-think-intensity

# 查看当前配置确认干净无残留
dsh --profile desktop --dump-config
```

---

## 本地开发与测试

```bash
pnpm install
pnpm run build       # 编译出 lib/index.js (单文件 ESM) 与类型声明
pnpm run test        # Vitest 单测（124 用例全部通过）
pnpm run typecheck   # TypeScript 类型校验
```

---

## License

MIT
