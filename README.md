# dsh-think-intensity

DSH 思考强度策略插件：**不让模型"拥有"档位，而是在已有档位之上决定每次请求用哪一档**，并把每次干预变得可观测、可回滚。

声明层（`reasoningEfforts`）已由 DSH 0.2.x 官方设置页覆盖，本插件只做策略：显式选择永远优先，没选档的请求按配置的默认策略注入，注入前过能力守卫，异常一律放行原请求；不配置时不注入任何档位（唯一例外是剥离无能力模型的继承档位，防报错）。

## 状态

M0–M4 已实现，123 个单测覆盖：策略核心（显式 > 子 agent > 全局默认）、能力守卫、purpose 分档、自愈降级、观测与统计落盘、配置回填（默认 dry-run）。M5 设置页未开始；M6 的发布工程已就绪，多版本实测与 npm 首发待做。

**零配置时插件不注入任何档位**，只做两件事：剥离"模型无推理能力却带着继承档位"的请求参数（防止 `UNSUPPORTED_REASONING_EFFORT`），以及记录调用统计与结构化决策日志。要按策略改档位，见下节。

## 启用

在 profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）里按 entry id 覆盖配置：

```yaml
- id: think-intensity
  config:
    defaultLevel: high        # 没选档的请求统一 high；留空 = 不干预
    subagentLevel: max        # 子 agent 会话单独一档；留空 = 回落 defaultLevel
    providers: []             # 只对列出的 provider 生效；空 = 全部
    purposeLevels:            # 辅助调用分档
      compaction: low
      session-title: off
```

其余配置项：

| 键 | 默认 | 说明 |
|---|---|---|
| `statsFlushMs` | `30000` | 统计落盘最小间隔（毫秒） |
| `backfillEnabled` | `false` | `true` 才真正写入缺失的 `reasoningEfforts` |
| `backfillLevels` | `{}` | 回填用的档位→wire 值表；`off` 可为 `null` |
| `routeDefaultLevel` | 空 | 仅当路由内所有模型都支持该档时才写入 |

自检：`dsh --profile web --dump-config | grep -A4 think-intensity` 确认配置已落到条目；运行后 `grep 'decision {"kind":"inject"'` 看注入记录，统计在 `$DSH_HOME/storages/think-intensity-stats.json`。

## 安装

```bash
dsh plugin --profile web add dsh-think-intensity                        # npm 预构建包（发布后）
dsh plugin --profile web add github:fengzhiyushui/dsh-think-intensity#<sha>   # GitHub 安装：建议固定 commit
dsh plugin --profile web add .                                          # 本地目录
dsh plugin --profile web remove dsh-think-intensity                     # 卸载
dsh --profile web --dump-config                                         # 验证层已移除
```

卸载不会删除 `$DSH_HOME/storages/think-intensity-stats.json`（历史统计，按需手动清理）。

包名 `dsh-think-intensity` 于 2026-10-22 在 npm 查询为未占用；安装时建议固定版本（如 `@0.1.0`），避免同名抢注包。

## 本地开发调试

```bash
pnpm install        # node-linker=hoisted（见 pnpm-workspace.yaml）
pnpm run build      # tsc 出类型 -> tsdown 从 lib/types 打出单文件 lib/index.js
pnpm run test       # vitest 单测（123 用例）
```

需要断点时用 `_research/deepseek-harness` 的源码宿主：`pnpm install && pnpm run build`，再用 `--patch` 挂载自定义 overlay；日常冒烟用上面的 CLI 即可。

或直接用已发布的 CLI 冒烟：

```bash
npx --ignore-scripts @deepseek-ai/dsh plugin --profile web add .
```

## 兼容性

`engines.dsh: ">=0.1.7-rc.1 <0.3.0"`，代码内按能力探测分支（`settings.get` / `describe` / `register` 存在性），不逐 rc 枚举；Node `^22.19.0 || >=24`（对齐官方）。

| 宿主版本 | 状态 | 说明 |
|---|---|---|
| 0.2.1-rc.2 | 冒烟通过 | 安装 / 激活 / 卸载 / `--dump-config` 无残留；真实请求注入待测 |
| 0.2.0 | 待实测 | 命名空间按 entry id 解析的分支 |
| 0.1.7-rc.1 ~ 0.1.x | 待实测 | 声明式设置分支 |

## 测试

`pnpm run test` 跑 123 个单测，覆盖报告 §7.4 场景 1–9：无 `reasoningEfforts` 模型不注入、只含 `off` 的非法声明不写入、自定义 wire 值（`high: ultra`）、路由默认冲突、显式 `off` 不被覆盖、非推理模型剥离、网关拒绝后的会话内降级、HMR 延后写、revision 冲突重试。场景 10（卸载无残留）在 M0 冒烟中用空插件验过，完整插件待复测。

## 分发

- **npm（主）**：`files` 白名单只含 `lib/index.js`、`lib/types/**/*.d.ts` 与声明文件，`prepare` 在打包前强制重建，不发布 TS 源。
- **GitHub（辅）**：安装时 `prepare` 会用源码构建，需要 Node 22+；pnpm 10+ 默认拦截依赖构建脚本，需在 `pnpm-workspace.yaml` 里放行（`onlyBuiltDependencies`）。
- **dist-tag 按宿主大版本分线**（如 `dsh-0.2`），不按 rc 逐个打 tag。

## 已知限制

- 回填只在插件加载时跑一次，之后新增路由需重启才会检测。
- 没有设置页（M5 未开始），配置要手写 `cordis.patch.yml`。
- 自愈黑名单只存在进程内，重启即清空（有意为之：避免误判固化）。
- 非推理模型上的显式档位会被剥离（防 `UNSUPPORTED_REASONING_EFFORT`），这是"显式优先"的唯一例外。

## License

MIT
