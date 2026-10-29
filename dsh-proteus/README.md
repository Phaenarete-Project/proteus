<p align="center"><img src="./icon.svg" width="72" height="72" alt="Proteus"></p>

# dsh-proteus — Proteus 数学应试插件

Proteus 把「**按评分标准得分**」做成 DeepSeek Harness 原生插件：先立考试契约（题目、知识点、评分标准、验证方式），再用考试矩阵路由策略，产出结构化解答，多路验证证据，按确定性规则模拟评分，最后定稿并写审计包。

它不追求「只算出答案」，而是追求「在时间预算内拿到能拿到的步骤分」，并把每一个判断落成可审计的证据。

- **宿主半侧**（`dsh-proteus`）：主机启动时把随包 `skills/` 幂等同步到 `$DSH_HOME/skills/proteus/`；在 `agentPresets` 服务可用时，按 `presets/roster.json` 程序化注册 5 个预设。不做别的。
- **预设半侧**（`dsh-proteus/tools`）：由每个预设按 `toolsRole` 挂载，注册**限定作用域**的 7 个 `proteus_*` 工具与一段 scoped systemPrompt 区块。角色不同，工具物理上不同。
- **技能库**：`skills/proteus/` 随包分发，安装后同步到 `~/.dsh/skills/proteus/`。

## 安装

> 以下命令是**本地开发示例，未执行**。本次交付没有安装插件，也没有修改 `~/.dsh/profiles`。

```bash
dsh plugin --profile desktop add link:/Users/leon/AI4Math/Proteus/dsh-proteus
```

安装后**重启 DSH**，新建会话时在预设选择器中选择「**Proteus 应试主控**」（另有契约官 / 解题者 / 评分官 / 审计官 4 个角色预设）。宿主半侧会自动：

1. 把 `skills/proteus/` 同步到 `~/.dsh/skills/proteus/`，技能选择器随即出现 `proteus`；
2. 读取 `presets/roster.json` + `presets/persona-*.md`，向 `agentPresets` 注册 5 个预设。

## 七个工具

所有工具返回 `{ ok, ... }`，失败返回 `{ ok:false, error:{ code, message } }`，不抛异常。

| 工具 | 用途 | 主要参数 | 可用角色 |
|---|---|---|---|
| `proteus_contract` | 创建 / 校验 / 查看考试契约，产出 `contract_id`、状态与路由建议；`show` 同时返回契约状态 `state` 与账本生命周期 `ledger_state` | `action: create\|validate\|show`、`contract`、`contract_id` | 主控、契约官（create）；评分官、审计官（show） |
| `proteus_route` | 按考试矩阵查询当前单元格、五维指标、优先级与策略；或统计最弱单元格 | `action: lookup\|stats`、`contract_id`、`limit` | 主控、契约官、解题者、评分官（lookup）；审计官（stats） |
| `proteus_budget` | 起表 / 打点 / 查看时间预算，返回 explore / converge / salvage / exhausted 相位；每个契约只能起表一次 | `action: start\|check\|status`、`contract_id`、`stage` | 全部角色（status）；主控、契约官、解题者（start/check） |
| `proteus_verify` | 规划或执行验证检查（格式、数值回代、表达式采样、定义域探针），证据只由本工具写入账本 | `action: plan\|run`、`contract_id`、`solution`、`checks`、`seed` | 主控、解题者（run）；契约官、评分官、审计官不可（审计的 replay 在 tool 内部完成） |
| `proteus_grade` | 按确定性规则模拟评分，输出 `GradePrediction`（步骤分、扣分、覆盖率、置信度） | `contract_id`、`solution` | 主控、评分官 |
| `proteus_finalize` | 重算评分 → 判定五态 → 写解答与审计包 → 更新考试矩阵 | `contract_id`、`solution` | 仅主控 |
| `proteus_audit` | 写 / 校验 / 回放审计包，检查哈希链与评分漂移 | `action: write\|verify\|replay`、`contract_id`、`bundle_path` | 主控、审计官 |

## 五个预设

| id | 名称 | 工具角色 | 扩展能力 | persona |
|---|---|---|---|---|
| `proteus` | Proteus 应试主控 | `full` | bash / jobs / delegation / askUser / web | `presets/persona-proteus.md` |
| `proteus-contractor` | Proteus 契约官 | `contract` | askUser | `presets/persona-proteus-contractor.md` |
| `proteus-solver` | Proteus 解题者 | `solver` | bash / jobs / delegation / askUser | `presets/persona-proteus-solver.md` |
| `proteus-grader` | Proteus 评分官 | `grader` | — | `presets/persona-proteus-grader.md` |
| `proteus-auditor` | Proteus 审计官 | `auditor` | bash | `presets/persona-proteus-auditor.md` |

主控流程：**考试契约 → 矩阵路由 → 求解 → 多路验证 → 评分模拟 → 定稿审计**，时间预算内自动降级（explore → converge → salvage → exhausted）。

## 技能

安装后技能位于：

```
~/.dsh/skills/proteus/
├── SKILL.md                # 主入口（触发词：Proteus / 应试 / 按评分标准 / 步骤分 / 估分 / 高考数学 / 考研数学 / 陷阱）
├── 大纲/高考数学.md         # GK.* 知识点 ID
├── 大纲/考研数学一.md       # KY1.* 知识点 ID
├── 评分标准/高考解答题.md
├── 评分标准/考研计算题.md
├── 评分标准/证明题.md
├── 陷阱库.md               # 24 个陷阱（T01–T24）与检测/扣分规则
├── 输出协议.md             # 五态、解答模板、evidence 标注
├── 考试矩阵.md             # 五维指标、优先级、更新规则
└── 审计包.md               # bundle 结构、replay 语义
```

## v0.1 能力边界

- **只有数值回代**：验证基于安全表达式求值与数值残差，**没有 CAS、没有形式化证明**（sympy / Lean 适配器不在 v0.1）。因此三个检查都产 `numeric` 一种证据介质，`independent_kinds` 上限为 1——**v0.1 的状态上限是 `LowConfidence`，`Verified` 需要适配器接入后才可达**。这是刻意的能力边界，不要通过改证据种类绕过。
- **评分是预测，不是权威**：`GradePrediction` 由确定性规则计算，是模拟估分；最终仍以规则分为 canonical，模型只做解释。
- **只支持单变量等式与表达式级检查**，不做整卷计时、题库、OCR 录题。
- **角色限制只到「注册哪些工具」**，不做参数级 policy 校验。
- **多模型交叉评审**可在主控 persona 中手工用 subagent 触发，但不是工具保证。
- 账本、矩阵、解决方案与审计包全部落盘在工作区 `<root>/`（默认 `proteus/`），可重启续跑。

## 目录结构

```
dsh-proteus/
├── package.json                # npm 清单 + dsh.bundle.patch + exports
├── cordis.patch.yml            # bundle patch：只插入一行宿主插件
├── dsh.plugin.json             # registry 元数据（工具/技能贡献声明）
├── icon.svg                    # 插件图标
├── README.md
├── locale/
│   ├── en.json
│   └── zh.json
├── presets/
│   ├── roster.json             # 5 个预设的注册清单
│   └── persona-*.md            # 5 份 persona 正文
├── lib/                        # 宿主入口 index.js、tools.js 与核心引擎
├── skills/                     # 随包技能库（同步到 ~/.dsh/skills/proteus/）
├── test/                       # node --test 测试
└── scripts/
    └── validate-package.mjs    # 本包清单静态校验（零依赖）
```

## 自检

```bash
node scripts/validate-package.mjs          # 或 npm run validate
node scripts/validate-package.mjs --quiet  # 只输出 error 与结论
```

校验内容：JSON 可解析、`exports` 目标文件存在、patch 结构（仅一个 insert、id/name 正确、无 tab、无 YAML 求值标签）、roster 5 条（id 唯一、order 递增、persona 文件存在）、`SKILL.md` frontmatter、lib/skills 不含本机绝对路径与禁止的 DSH 工具包名、icon 与 README 完整性。有 error 时退出码为 1。

## 许可

MIT
