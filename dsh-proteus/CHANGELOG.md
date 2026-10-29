# Changelog

## 0.1.0 — 2026-10-30

首个参考实现（设计见 `../Proteus-插件设计.md`，接口见 `../spec/INTERFACES.md`）。

### Added

- **宿主半侧** `dsh-proteus`：启动时把 `skills/proteus/` 幂等同步到 `$DSH_HOME/skills/proteus/`（字节比较 + 残留清理 + 空目录回收）；在 `agentPresets` 可用时按 `presets/roster.json` + persona 程序化注册 5 个预设。
- **预设半侧** `dsh-proteus/tools`：按 `role` 注册 7 个 `proteus_*` 工具的子集，并注入 scoped systemPrompt 区块。
- **7 个工具**：`proteus_contract`、`proteus_route`、`proteus_budget`、`proteus_verify`、`proteus_grade`、`proteus_finalize`、`proteus_audit`。
- **判定引擎**：契约校验/内容哈希、考试矩阵五维与优先级、预算四相位、数值回代/表达式采样/定义域探测、24 条陷阱规则、rubric 计分与置信度、五态定稿、审计包哈希链与 replay。
- **5 个预设**：主控 / 契约官 / 解题者 / 评分官 / 审计官；角色工具物理隔离。
- **技能库**：`SKILL.md` + 高考 49 节点 / 考研数一 79 节点大纲 + 12 个 rubric 模板 + 24 条陷阱 + 输出协议 / 矩阵 / 审计规范。
- **测试**：126 个 `node:test` 用例（含全链路 create→verify→grade→finalize→audit、证据/结论伪造负例、篡改检测、角色越权、证明题门、技能幂等与残留清理、symlink 路径收敛）。

### Design decisions

- **v0.1 只有 `numeric` 一种证据介质**：`numeric_residual`、`expression_sample`、`domain_probe` 全部产 `numeric`，`structural` 不计入独立种类。因此 v0.1 的状态上限是 `LowConfidence`；`Verified` 需要未来的 `symbolic`/`formal` 适配器或 `human` 证据。把采样比对标成 `symbolic` 可以让状态好看，但那等于自欺，明确拒绝。
- **证明题额外门**：`problem_type=proof` 或 `answer_format.type=proof` 时，`Verified` 还要求 `formal`/`human`；数值抽样不能证明全称命题。
- **证据只由工具写入**：模型只能引用 evidence_id；`finalize` 重算证据的 kind/digest/id，并按当前 attempt 的 plan/seed 重跑比对；`audit verify/replay` 用包内 contract+solution 重跑检查、重算评分与五态，再与包内结论比对。
- **attempt 语义**：一次 verify 一个 attempt，只采用当前 attempt 的证据；旧证据保留供审计，避免「曾经错一次」永久污染结论。
- **配置门限不信任被审计对象**：`evidenceMinKinds` 由调用方配置传入，包内同名记录只做一致性校验（`CONFIG_MISMATCH`）。
- **路径收敛**：`cwd`/`bundle_path` 做 realpath 感知的边界校验，符号链接逃逸返回 `PATH_DENIED`。
- **预设程序化注册**：与官方 `@deepseek-ai/dsh-agent-preset` 声明行内部行为一致，避免 patch 中重复 5 份工具清单与 persona 正文。

### Known limitations

- 无 CAS / 形式化证明适配器；多变量方程残差与含变量答案的数值检查返回 `unknown`。
- 评分是规则预测，不是权威；rubric 的 `inferred`/`model` 来源会降低可信度。
- 矩阵一个契约只落第一个知识点的格子；整卷模式未实现。
- 未在本机安装验证（安装会修改 profile）；运行时行为以 99 项离线测试与 fake-context 集成测试为准。
