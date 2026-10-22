# dsh-think-intensity

思考强度策略插件：在模型已有档位之上决定每次请求用哪一档，并让每次干预可观测、可回滚。

- 状态：M0–M4 已实现（123 个单测），M5 设置页与 M6 多版本矩阵/发布未开始。
- 零配置：不注入任何档位，只剥离"无推理能力模型上的继承档位"并记录统计/决策日志。
- 启用方式（`defaultLevel` 等配置项与验证命令）见 [README.md](README.md#启用)。
- 冒烟安装：`npx --ignore-scripts @deepseek-ai/dsh plugin --profile web add .`
- 卸载：`npx --ignore-scripts @deepseek-ai/dsh plugin --profile web remove dsh-think-intensity`
