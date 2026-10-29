# Proteus

> 当 AI 学会「按评分标准得分」——一个构建在 DeepSeek Harness 上的数学应试插件设计 + 可安装参考实现。

本目录是原随笔 [《Proteus：当 AI 学会"按评分标准得分"》](<../../Documents/AEON/AEON/Proteus：当 AI 学会"按评分标准得分".md>) 的工程化落地：不是再写一遍理念，而是把理念翻译成**契约、工具、状态机、评分函数、审计包**，并给出可以在 DSH 里安装的 `dsh-proteus` bundle 参考实现。

- 公开仓库：[Phaenarete-Project/proteus](https://github.com/Phaenarete-Project/proteus)
- 市场收录申请：[dsh-plugin-index #138](https://github.com/polang233/dsh-plugin-index/issues/138)（审核中；来源为公开 Git 仓库 + 固定提交）
- npm：`dsh-proteus@0.1.0`（待 `npm login` 后发布）

---

## 读什么

| 文件 | 作用 | 建议读者 |
|---|---|---|
| [`Proteus-插件设计.md`](Proteus-插件设计.md) | 主设计文档：意图解构、四层架构、数据契约、五态、评分算法、评测方案、与原随笔逐条对照 | 所有人，先读这个 |
| [`spec/INTERFACES.md`](spec/INTERFACES.md) | 开发接口契约：字段、工具签名、模块 API、受控词表、文件所有权、验收标准 | 实现者 / 评审者 |
| [`dsh-proteus/`](dsh-proteus/) | 可安装的参考实现（bundle + 5 预设 + 技能库 + 测试） | 想直接跑的人 |
| [`dsh-proteus/README.md`](dsh-proteus/README.md) | 安装、预设、工具表、能力边界 | 使用者 |
| [`评审/`](评审/) | 独立评审报告（设计一致性 / 实现符合性） | 质量把关 |

---

## 它解决什么问题

普通「AI 做数学」优化的是**答案正确率**；考试真正考察的是**在评分标准下，用可被识别、可被给分的步骤走到正确答案**。

Proteus 的取舍：

- **契约先行**：题目先被结构化成 `ExamContract`（知识点、题型、答案形式、rubric、时间预算、歧义、大纲内外）；没有 `ready` 契约不求解。
- **矩阵可度量**：每次定稿自动更新「大纲 × 题型 × 难度」格子的五维指标（覆盖率、正确率、步骤分、时间、Unknown 率），路由据此选策略。
- **证据可验证**：答案必须有多路独立证据（数值回代 / 符号 / 形式化 / 人工），结构检查不计入独立种类；证据只能由工具产生，模型不能伪造。
- **评分可解释**：按 rubric 的步骤 ID 对齐计分，规则分是 canonical；LLM 只能解释，不能改分。
- **失败可分类**：输出只有五态 `Verified / LowConfidence / Unknown / Ambiguous / OutOfSyllabus`，没有「可能做对了」。
- **过程可重放**：契约、解答、证据、评分、环境、时间线打包成哈希链审计包，确定性检查可 replay。

一句话：**模型负责「怎么想」，插件负责「算不算数」。**

---

## 目录结构

```
Proteus/
├── README.md                       # 本文件
├── Proteus-插件设计.md              # 主设计文档
├── spec/
│   └── INTERFACES.md               # 并行开发接口契约（唯一真相）
├── dsh-proteus/                    # 可安装 bundle（参考实现）
│   ├── package.json
│   ├── cordis.patch.yml            # 只插宿主行
│   ├── dsh.plugin.json
│   ├── icon.svg / locale/          # 插件卡片资源
│   ├── lib/                        # 宿主 + scoped 工具 + 判定引擎
│   ├── presets/                    # roster.json + 5 份 persona
│   ├── skills/proteus/             # SKILL.md + 大纲/评分标准/陷阱库/协议
│   ├── test/                       # node:test
│   └── scripts/validate-package.mjs
└── 评审/                            # 独立评审报告
```

---

## 快速验证（不安装）

```bash
cd Proteus/dsh-proteus
node --test                       # 单元 + 全链路集成测试（Node 24 下不要写成 node --test test/）
node scripts/validate-package.mjs # 清单/roster/技能/禁忌项自检
```

**当前验证状态（2026-10-30）**：`node --test` → 126 pass / 0 fail；`validate-package: OK`；独立评审两轮（`评审/独立评审报告.md`、`评审/复审报告.md`）发现的 2 个 blocker 与 15 个 major 已修复并被复审确认；终审结论见 `评审/终审报告.md`。**尚未在本机 profile 安装**（安装需你确认）。

## 安装（示例，需你手动执行）

```bash
dsh plugin --profile desktop add link:/Users/leon/AI4Math/Proteus/dsh-proteus
```

安装后重启 DSH，新建会话时选择「Proteus 应试主控」或四个单阶段角色。插件启动时会：

1. 把 `skills/proteus/` 幂等同步到 `~/.dsh/skills/proteus/`；
2. 通过 `agentPresets.register()` 注册 5 个预设（主控 / 契约官 / 解题者 / 评分官 / 审计官）。

> 本仓库只提供源码与设计，**没有替你执行安装**——安装会改动当前 profile 并执行插件代码，属于需要你确认的操作。

---

## 三条设计红线

1. **无契约不求解**：没有 `state=ready` 的契约，定稿只会是 `Ambiguous`/`OutOfSyllabus`，不会进入求解与评分。
2. **无证据不给分**：evidence 只由 `proteus_verify` 写入，模型提交的文本不算证据。
3. **不会就诚实说**：`Unknown` 是特性，不是缺陷；它必须携带已完成的部分步骤与可得分项。

---

## v0.1 能力边界

- 验证：数值回代、表达式采样、定义域探测、格式/结构检查；**无 CAS、无形式化证明**（接口已留，未配置即 `unknown`）。因此只有 `numeric` 一种证据介质，**v0.1 的诚实上限是 `LowConfidence`**；`Verified` 要等 v0.2 适配器。
- 评分：规则分 canonical；历史评分与人类校准在路线图（v0.3）。
- 时间：四相位降级是**策略协议**，工具只报告相位，不杀进程。
- 覆盖：高考数学 / 考研数学一的方法论骨架；题目本身由用户提供（无 OCR、无题库）。
- 评测：给出三层基线与 12 题最小基准集方案；完整 benchmark 在 v0.2。
