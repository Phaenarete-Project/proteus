# Proteus v0.1 接口契约（并行开发基线）

> 本文件是三条并行工作流（核心引擎 / 技能库 / bundle 与预设）的唯一接口真相。
> 任何一方要改字段名、工具名、文件路径，必须先改本文件并在交付说明里注明。
> 目标目录：`Proteus/dsh-proteus/`（包名 `dsh-proteus`）。

---

## 0. 一句话架构

- **宿主半侧**（`dsh-proteus`，package root）：启动时把随包 `skills/` 幂等同步到 `$DSH_HOME/skills/proteus/`，让技能可被发现。不做别的。
- **预设半侧**（`dsh-proteus/tools`，subpath export）：由每个 Proteus 预设按 `role` 挂载，注册**限定作用域**的 7 个 `proteus_*` 工具 + 一段 scoped systemPrompt 区块。角色不同，工具物理上不同。
- **技能**：`skills/proteus/SKILL.md` 为主入口，`大纲/`、`评分标准/`、`陷阱库.md`、`输出协议.md`、`考试矩阵.md`、`审计包.md` 按需加载。
- **预设**：宿主半侧在 `agentPresets` 服务可用时，按随包 `presets/roster.json` + `presets/persona-*.md` **程序化注册** 5 个预设（主控 + 契约官 / 解题者 / 评分官 / 审计官）。这与官方 `@deepseek-ai/dsh-agent-preset` 行内部行为完全一致（它本身就是调用 `agentPresets.register(config)`），但避免在 patch 里重复 5 份工具清单与 persona 正文。

**硬约束**

1. 不安装、不改 `~/.dsh/profiles/**`、不跑 pnpm、不碰 DSH 源码。只写 `Proteus/`。
2. 只用 Node 22+ ESM 与 `node:*` 内置模块；唯一 npm 依赖是 `schemastery`（`Config` 用）。**不要 import `@deepseek-ai/dsh-tools`**（本地无法解析；工具用原始 `ToolDefinition` 注册）。
3. 工具参数用**原始 JSON Schema**（不是 defineTool DSL），对外 `ctx.tools.register({ name, description, parameters, output, execute })`。
4. 所有跨工具状态落盘到工作区 `<root>/`，不依赖进程内状态；工具必须能在重启后继续。
5. 中文文档/注释；标识符、字段名、错误码用英文。

---

## 1. 文件所有权（并行写作用）

| 角色 | 独占写入范围 |
|---|---|
| Lead | `Proteus/README.md`、`Proteus/Proteus-插件设计.md`、`Proteus/spec/**`、`Proteus/dsh-proteus/CHANGELOG.md` |
| core-dev | `Proteus/dsh-proteus/lib/**`、`Proteus/dsh-proteus/test/**` |
| skill-author | `Proteus/dsh-proteus/skills/**`、`Proteus/dsh-proteus/presets/persona-*.md` |
| bundle-smith | `Proteus/dsh-proteus/package.json`、`cordis.patch.yml`、`dsh.plugin.json`、`locale/**`、`icon.svg`、`README.md`、`presets/roster.json`、`scripts/validate-package.mjs` |
| reviewer | `Proteus/评审/**`（只读其他文件） |

禁止跨范围写。需要改别人的文件 → 在交付说明里提，由 Lead 集成。

---

## 2. 数据契约

所有 JSON 都是纯 JSON（无 undefined）；时间用 ISO-8601 UTC 字符串；哈希小写 hex。

### 2.1 ExamContract（`proteus.contract/v1`）

```jsonc
{
  "schema": "proteus.contract/v1",
  "contract_id": "sha256:<hex>",          // 由工具计算，输入里可省略
  "exam": "gaokao-math" ,                  // "gaokao-math" | "kaoyan-math1" | "custom"
  "problem": {
    "source": "2024 全国甲卷 理 21",        // 可选
    "text": "原题全文（可含 LaTeX）",        // 必填
    "attachments": []                        // 可选
  },
  "domain": "calculus",                    // calculus|linear_algebra|probability|geometry|series|inequality|complex|other
  "knowledge_points": ["GK.FUNC.DERIV"],   // 必填，>=1；ID 约定见 §7.2
  "problem_type": "computation",           // multiple_choice|fill_blank|computation|proof|construction|classification
  "givens": [                              // 可选
    { "id": "G1", "text": "f(x)=x^3-3x", "symbol": "f" }
  ],
  "goal": {
    "kind": "evaluate",                    // evaluate|prove|construct|classify|find_range
    "statement": "求 f 的单调区间"
  },
  "answer_format": {
    "type": "interval",                    // exact|numerical|interval|expression|set|proof
    "tolerance": { "abs": 0.001, "rel": 0.001 },   // numerical 必填
    "units": null,                          // 或 "cm^2"；有单位时答案必须带
    "endpoints": { "left": "open", "right": "closed" },  // interval 可选；兼容单数 endpoint
    "distractors": ["3", "1/3"]             // 选择题可选；也可放顶层 contract.distractors
  },
  "grading_rubric": {
    "source": "inferred",                  // official|inferred|model
    "total_points": 12,
    "answer_points": 2,
    "step_points": [
      { "id": "S1", "desc": "写出定义域", "points": 2, "required": true,
        "evidence": ["structural"], "partial": "all_or_nothing" },
      { "id": "S2", "desc": "求导并写出 f'(x)", "points": 3, "required": true,
        "evidence": ["symbolic", "numeric"] }
    ],
    "deduction_rules": [
      { "trap": "T01", "deduct": 2 }
    ]
  },
  "verification": {                          // 可选；没有则只能做结构检查
    "equations": ["x^2 - 5*x + 6 = 0"],      // 单变量等式
    "reference_expr": "2",                   // 官方答案表达式（可选）
    "variables": ["x"],
    "sample_range": [-10, 10],
    "seed": 42,
    "expected_solution_count": 2,            // T07 可选；缺省不判
    "checks": ["answer_format", "numeric_residual", "expression_sample", "domain_probe"]
  },
  "time_budget_s": 900,
  "difficulty": "medium",                    // easy|medium|hard
  "ambiguity": {
    "severity": "none",                      // none|minor|blocking
    "flags": []                              // 如 [{code:"LIMIT_DIRECTION_UNSPECIFIED", detail:"x→0 未说明左右"}]
  },
  "syllabus": {
    "in_syllabus": true,
    "out_of_syllabus": []                    // 如 ["留数定理"]
  },
  "matrix_cell": "gaokao-math|calculus|GK.FUNC.DERIV|computation|medium"  // 工具计算
}
```

**校验不变量（`validateContract` 必须检查）**

| 码 | 规则 | 级别 |
|---|---|---|
| `SCHEMA` | `schema` 缺失/不符 | error |
| `PROBLEM_TEXT` | `problem.text` 为空 | error |
| `DOMAIN` / `TYPE` | 枚举外 | error |
| `KP_EMPTY` | `knowledge_points` 为空 | error |
| `KP_FORMAT` | 任一 ID 不匹配 `/^[A-Z0-9]+(\.[A-Z0-9_]+)+$/` | warning |
| `POINTS_SUM` | `Σ step.points + answer_points ≠ total_points`（容差 0.001） | error |
| `STEP_EMPTY` | 任一 step 无 id/desc 或 points < 0 | error |
| `STEP_DUP` | step id 重复 | error |
| `EVIDENCE_KIND` | step.evidence 含枚举外值 | error |
| `TOLERANCE` | `answer_format.type=numerical` 且无 tolerance | error |
| `PROOF_FORMAT` | `problem_type=proof` 且 `answer_format.type≠proof` | warning |
| `AMBIGUITY` | `ambiguity.severity=blocking` | warning（状态转 Ambiguous） |
| `OUT_OF_SYLLABUS` | `syllabus.in_syllabus=false` 或 out_of_syllabus 非空 | warning（状态转 OutOfSyllabus） |
| `BUDGET` | `time_budget_s <= 0` | error |

**state 判定**：有 error → `invalid`；`ambiguity.severity=blocking` → `ambiguous`；大纲外 → `out_of_syllabus`；否则 `ready`。

`contract_id = "sha256:" + sha256(canonicalJson(contract 去掉 contract_id 与 matrix_cell 两个派生字段))`。

### 2.2 Solution（模型输入给 verify/grade/finalize）

```jsonc
{
  "answer": { "value": "[0,2]", "unit": null },       // value 必填字符串或数字
  "steps": [
    {
      "id": "S1",
      "text": "函数定义域为 R，f'(x)=3x^2-3=3(x-1)(x+1)。",
      "tags": ["domain", "theorem:fermat"],            // 受控词表见 §6.2
      "evidence_refs": ["ev_ab12cd34ef56"]             // 只能引用 verify 产生的 id
    }
  ]
}
```

### 2.3 Evidence（只由 `proteus_verify` 产生）

```jsonc
{
  "evidence_id": "ev_<12hex>",
  "kind": "structural|numeric|symbolic|formal|human",
  "check": "answer_format|numeric_residual|expression_sample|domain_probe",
  "claim": "answer",              // v0.1 只产 answer 级证据；step.evidence_refs 是对它的回引
  "status": "pass|fail|unknown",
  "detail": "residual=3.2e-12 at x=2",
  "input_digest": "sha256:<hex>",
  "output_digest": "sha256:<hex>",
  "created_at": "2026-10-29T15:40:54.000Z"
}
```

- `structural` 不计入「独立证据种类」（`independent_kinds` 只算 numeric/symbolic/formal/human）。
- `unknown` 表示**无法验证**（如无 reference_expr、表达式无法解析），必须保留，不得当作 pass。
- evidence 只能由工具写入 ledger；模型无法直接提交 evidence。
- **每个 evidence 必须可重算**：`kind` 必须等于该 `check` 的固定 kind；`input_digest = digest({contract_id, check, claim, kind, answer, seed})`；`output_digest = digest({status, detail})`；`evidence_id = "ev_" + sha256(input_digest|output_digest|check|claim|kind).slice(0,12)`。finalize 与 audit 会重算并比对，任一不符即 `EVIDENCE_CONFLICT`。
- **attempt 语义**：一次 `proteus_verify run` 是一个 attempt；ledger 记录 `verification = {attempt, plan, seed, evidence_ids}`。grade/finalize/五态判定只使用**当前 attempt** 的证据；旧 attempt 的证据保留在 ledger 供审计，不参与当前结论。

### 2.4 TrapFinding

```jsonc
{
  "trap": "T01",                 // 见 §6.1
  "severity": "major",           // minor|major|blocker
  "basis": "rule",               // rule|heuristic；只有 rule 可扣分
  "step": "S2",                  // 可选
  "deduct": 2,                   // 建议扣分（由 rubric 的 deduction_rules 或陷阱默认值决定）
  "detail": "题目含分母 x-1，未声明 x≠1"
}
```

### 2.5 GradePrediction（`proteus-rubric/v1`）

```jsonc
{
  "schema": "proteus.grade/v1",
  "prediction_id": "gp_<12hex>",
  "contract_id": "sha256:<hex>",
  "rule_version": "proteus-rubric/v1",
  "max_points": 12,
  "predicted_points": 9.5,
  "answer_points": 2,
  "step_scores": [
    { "id": "S1", "earned": 2, "max": 2, "reason": "evidence structural pass", "kinds": ["structural"] }
  ],
  "deductions": [
    { "trap": "T01", "points": 2, "reason": "major rule finding" }
  ],
  "traps": [ /* TrapFinding[] */ ],
  "coverage": { "steps_verified": 3, "steps_total": 4 },
  "independent_kinds": ["numeric"],
  "confidence": 0.72,
  "notes": []
}
```

计分规则（确定性、可测试）：

1. 每个 step：`text` 非空才可能得分；`required=true` 且无 pass 证据时，按 `partial` 取值：`all_or_nothing`→0，`half_on_missing`→0.5×points，`proportional`→`0.5×points×verifiedKinds/requiredKinds`。
2. step 的 `evidence` 含 `structural` 时，结构性证据由 `proteus_grade` 内部生成（step.text 非空即 pass），不计入独立种类。
3. 答案分：答案格式合法 +（有 reference/equation 时，至少一个**非 structural** 证据 pass，v0.1 即 numeric）→ 满分；否则 0。
4. 扣分：只对 `basis=rule` 的 finding 扣；按 `deduction_rules` 的 trap→points 映射，缺省用 finding.deduct；总扣分 ≤ total_points。
5. `predicted_points = clamp(roundHalf(stepSum + answerPoints - deductions), 0, total)`；`roundHalf` 取 0.5 的整数倍。
6. `confidence = clamp(0.5 + 0.4*coverageRatio + 0.1*(independentKinds/3) - 0.15*majorCount, 0, 1)`，保留 2 位小数；`coverageRatio = 只计 requiredKinds 全部满足的步骤数 / 总步骤数`（部分满足但 0 分的步骤**不得**计入 coverage，也不得视为 verified）。
7. `prediction_id = "gp_" + sha256(contract_id|canonicalJson(solution)|rule_version).slice(0,12)`。

### 2.6 Budget

```jsonc
{
  "started_at": "...", "budget_s": 900, "stage": "solve",
  "checkpoints": [{ "at_s": 120, "stage": "solve", "remaining_s": 780 }]
}
```

`checkBudget(budget, now)` 返回 `{elapsed_s, remaining_s, ratio, phase, allow_verified, allow_new_search, add_search, recommended}`：

| ratio（remaining/budget） | phase | allow_verified | 建议 |
|---|---|---|---|
| > 0.6 | `explore` | true | 可多策略并行 |
| 0.3–0.6 | `converge` | true | 收敛最佳候选并验证 |
| 0.1–0.3 | `salvage` | true（但只允许已有证据） | 补可得分步骤，停止新探索 |
| < 0.1 | `exhausted` | **false** | 输出当前最佳，标低置信 |

`proteus_budget start` 每个 contract 只能成功一次；二次调用返回 `BUDGET_ALREADY_STARTED`（除非显式 `restart:true`，此时 timeline 记 `budget.restarted`，审计可见）。

### 2.7 Matrix（`proteus.matrix/v1`）

```jsonc
{
  "schema": "proteus.matrix/v1",
  "updated_at": "...",
  "cells": {
    "<cell_key>": {
      "exam": "gaokao-math", "domain": "calculus",
      "knowledge_point": "GK.FUNC.DERIV", "problem_type": "computation", "difficulty": "medium",
      "attempts": 3, "verified": 2, "low_confidence": 1, "unknown": 0,
      "ambiguous": 0, "out_of_syllabus": 0,
      "points_earned": 26.5, "points_possible": 36,
      "time_samples_s": [420, 510],
      "last_attempt_at": "..."
    }
  }
}
```

派生指标（`cellStats`）：`coverage=min(1, attempts/targetAttempts)`，`correctness=verified/attempts`，`step_score=points_earned/points_possible`，`unknown_rate=(unknown+low_confidence)/attempts`，`time_p50`。`priority = 0.3*(1-coverage)+0.3*(1-correctness)+0.2*(1-step_score)+0.1*unknown_rate+0.1*min(1,time_p50/900)`。

### 2.8 AuditBundle（`proteus.audit/v1`）

```jsonc
{
  "schema": "proteus.audit/v1",
  "bundle_id": "sha256:<hex>",         // 去掉 bundle_id 后 canonicalJson 的哈希
  "contract": { /* 规范化契约 */ },
  "solution": { /* 最终提交的 Solution */ },
  "evidence": [ /* 当前 attempt 的证据（旧 attempt 留在 ledger，不入包） */ ],
  "grade": { /* 最终重算的 GradePrediction */ },
  "verification": { "attempt": 1, "plan": ["answer_format", "expression_sample"], "seed": 42 },
  "grade_drift": false,                 // finalize 重算与账本既有 grade 是否不一致
  "state": {
    "state": "Verified",               // Verified|LowConfidence|Unknown|Ambiguous|OutOfSyllabus
    "reason_codes": [],
    "decided_at": "..."
  },
  "budget": { /* Budget + 顶层 phase + check */ },
  "environment": {
    "plugin_version": "0.1.0", "node": "v22.x", "platform": "darwin",
    "model": "deepseek-flash", "seed": 42, "rule_version": "proteus-rubric/v1",
    "evidence_min_kinds": 2
  },
  "timeline": [ { "seq": 1, "at": "...", "event": "contract.created", "prev": null, "hash": "sha256:<hex>" } ]
}
```

`verifyBundle` 必须做**语义校验**，不只校验完整性：

1. 重算 `bundle_id`、逐条重算 timeline 哈希链；
2. `validateContract(bundle.contract)` 的 state 必须与 `bundle.state.state` 相容（ready→Verified/LowConfidence/Unknown；ambiguous→Ambiguous；out_of_syllabus→OutOfSyllabus）；
3. 按 `bundle.verification.plan/seed` 用 `bundle.contract + solution` 重跑 `runChecks`，逐条比对 `bundle.evidence` 的 id/kind/status/claim，且不允许包里多出未重跑出的证据；
4. 用重跑证据重算 `grade()`，比对总分/步骤分/扣分/置信度/覆盖/独立种类；
5. 重算 §2.9 五态（含证明题门与预算降级），比对 `state.state` 与 `reason_codes`；
6. 校验 `solution.steps[].evidence_refs` 全部存在、`budget.phase=exhausted` 时 state 不得为 `Verified`；
7. 任一项不符 → `ok:false` 并给出 issue；
8. `evidenceMinKinds` 由调用方配置传入（`ctx.cfg.evidenceMinKinds`，**代码内下限锁 2**），**不得**读包内 `environment.evidence_min_kinds` 作为门限；包内该字段仅作记录，若与调用方不一致报 `CONFIG_MISMATCH`。

`replay` 与 `verify` 使用同一套语义重算，并把 `GRADE_MISMATCH` / `STATE_MISMATCH` 写入 diffs。

### 2.9 FinalState

`Verified | LowConfidence | Unknown | Ambiguous | OutOfSyllabus`——**没有第六态**。判定顺序：

1. contract.state=`ambiguous` → `Ambiguous`
2. contract.state=`out_of_syllabus` → `OutOfSyllabus`
3. `solution.answer.value` 为空 → `Unknown`
4. `independent_kinds >= evidenceMinKinds` 且 answer_format pass 且无未消解 `blocker`、无未消解 `major` 陷阱 → `Verified`
   - **证明题附加门**：`problem_type=proof` 或 `answer_format.type=proof` 时，`independent_kinds` 必须含 `formal` 或 `human`；否则不得 `Verified`（数值抽样不能证明全称命题），降 `LowConfidence` + `FORMAL_EVIDENCE_REQUIRED`。
5. 预算 phase=`exhausted` 时，`Verified` 降级 `LowConfidence`（reason `TIME_EXHAUSTED`）
6. 至少 1 条证据或格式 pass → `LowConfidence`
7. 否则 → `Unknown`

`reason_codes` 取值：`EVIDENCE_INSUFFICIENT`、`EVIDENCE_CONFLICT`、`FORMAT_MISMATCH`、`TRAP_UNRESOLVED`、`FORMAL_EVIDENCE_REQUIRED`、`TIME_EXHAUSTED`、`NO_ANSWER`、`CONTRACT_AMBIGUOUS`、`OUT_OF_SYLLABUS`、`GRADE_DRIFT`。

---

## 3. 存储布局

`root` 配置默认 `proteus`（相对会话工作区）：

```
<root>/ledger/<contract_hex>.json     # 单一契约的完整账本（见下）
<root>/matrix.json                    # 考试矩阵
<root>/solutions/<contract_hex>.md   # 面向评分者的解答（finalize 写）
<root>/audit/<contract_hex>.json     # 审计包
```

Ledger：

```jsonc
{
  "schema": "proteus.ledger/v1",
  "contract": { /* normalized */ },
  "state": "created",                   // created|verified|finalized
  "budget": null,
  "evidence": [],
  "grade": null,
  "final": null,
  "timeline": []
}
```

**并发/原子性**：所有写入先写 `<path>.tmp` 再 `rename`；读失败/损坏时返回 `{ok:false,error:{code:"LEDGER_CORRUPT"}}`，不静默覆盖。工作区绝对路径解析：`exec.agent?.session?.header?.cwd ?? process.cwd()`，再 `join(cwd, root)`。

---

## 4. 工具面（7 个）

所有工具返回 `{ ok: boolean, ... }`；失败返回 `{ok:false, error:{code,message}}`，**不 throw**（除非程序缺陷）。参数里都有可选 `cwd`（覆盖工作区）。工具名固定，不带前缀命名空间。

### 4.1 `proteus_contract`

params：

```jsonc
{
  "action": { "type": "string", "enum": ["create", "validate", "show"] },
  "contract": { "type": "object", "description": "契对象；create/validate 必填" },
  "contract_id": { "type": "string", "description": "show 必填" },
  "cwd": { "type": "string" }
}
```

- `create`：校验 → 不合法（state=invalid）**不落盘**，直接返回 issues；合法写 ledger（state=created）→ 返回 `{ok, contract_id, state, issues, contract, routing:{cell_key,strategy,priority}, next}`
  - `next`: `"solve" | "clarify" | "stop"`（ready→solve，ambiguous→clarify，out_of_syllabus/invalid→stop）
- `validate`：不落盘，同上但无 contract_id 持久化。
- `show`：读 ledger，返回 `{ok, contract, state, ledger_state, evidence_count, grade, final}`；`state` 是**契约状态**（ready/ambiguous/out_of_syllabus/invalid），`ledger_state` 是账本生命周期（created/verified/finalized）。
- 角色限制：`contract`/`full` 可 create；`grader`/`auditor` 只能 show。
- **路径约束**：所有工具的 `cwd` 必须等于或位于 `exec.agent.session.header.cwd` 之下（realpath 前缀校验），否则 `{ok:false,error:{code:'PATH_DENIED'}}`；`bundle_path` 只允许 `<root>/audit/` 下的文件。

### 4.2 `proteus_route`

params：`{action:"lookup"|"stats", contract_id?, cwd?, limit?}`

- `lookup`：需 ledger；返回 `{ok, cell_key, cell, metrics, priority, strategy:{id,name,checklist,preferred_checks}, weak_siblings:[...]}`
- `stats`：返回 `{ok, totals, cells:[...], weakest:[...]}`（按 priority 降序，limit 默认 10）
- 角色：`full`/`contract`/`solver`/`grader` 可用 lookup；`auditor` 用 stats。

strategy 枚举（确定性映射）：`symbolic_first`（calculus/series/inequality）、`numeric_first`（probability/geometry）、`formal_first`（proof）、`case_enumeration`（classification/abs/param）、`construction_search`（construction）。

### 4.3 `proteus_budget`

params：`{action:"start"|"check"|"status", contract_id?, cwd?, stage?}`

- `start`：从 contract.time_budget_s 起表，写 ledger。
- `check`：追加 checkpoint 并返回 §2.6 状态。
- `status`：不改 checkpoint。
- 角色：全部可 status；`full`/`contract`/`solver` 可 start/check。

### 4.4 `proteus_verify`

params：

```jsonc
{
  "action": "plan" | "run",
  "contract_id": "sha256:...",
  "solution": { /* §2.2，run 必填 */ },
  "checks": ["answer_format", "numeric_residual"],   // 可选，缺省=plan 全量
  "seed": 42,
  "cwd": "..."
}
```

- `plan`：返回 `{ok, checks:[{id,kind,description,available,reason}]}`；`available=false` 时给 reason（如 `NO_REFERENCE_EXPR`）。
- `run`：执行可用检查，把 Evidence 追加进 ledger，并记录 `verification = {attempt, plan, seed, evidence_ids}`；返回 `{ok, evidence, summary:{pass,fail,unknown,total}, independent_kinds, attempt, plan}`。`seed` 覆盖会写入 ledger 与审计包，保证 replay 一致。
- 角色：`full`/`solver` 可 run；`contract`/`grader`/`auditor` 不可（auditor 的 replay 在 `proteus_audit` 内部完成，不需要写账本）。

### 4.5 `proteus_grade`

params：`{contract_id, solution, cwd?}`（solution 必填）

返回 §2.5。同时把 grade 写回 ledger。
角色：`full`/`grader` 可用。

### 4.6 `proteus_finalize`

params：`{contract_id, solution, cwd?}`

流程（必须按序）：**先要求 `ledger.verification` 存在且 `evidence_ids` 非空**（否则 `VERIFICATION_REQUIRED`，不写任何文件）→ 校验/重跑当前 attempt 证据（不一致 → `EVIDENCE_CONFLICT` 且不得 Verified）→ 重算 grade（与 ledger 中已有 grade 比对，不一致 → reason `GRADE_DRIFT`）→ 重算 evidence 摘要 → 判定 §2.9 状态 → **先更新 matrix**（失败即 `MATRIX_WRITE_FAILED`，此时尚未写解答/审计）→ 追加 `finalize.completed` 事件 → 写 audit bundle → 写 `solutions/<hex>.md` → ledger.state=finalized。
幂等：同一 contract 且 solution 内容哈希相同 → 返回既有 final（`idempotent:true`，不重写、不重复计数）；solution 不同 → `ALREADY_FINALIZED`。
返回 `{ok, state, reason_codes, answer, predicted_points, max_points, evidence_summary, solution_path, audit_path}`。
角色：仅 `full`。

### 4.7 `proteus_audit`

params：`{action:"write"|"verify"|"replay", contract_id?, bundle_path?, cwd?}`

- `write`：从 ledger 生成审计包；若目标文件已存在且 `verify` 通过，返回既有包（`existing:true`），不覆盖。
- `verify`：读 bundle，按 §2.8 做完整语义校验（重算 evidence/grade/state）；返回 `{ok, bundle_id, issues}`。
- `replay`：按 bundle 的 `verification.plan/seed` 与 contract+solution 重跑 `runChecks`，比对 evidence/grade/state；返回 `{ok, checks, diffs}`。
- 角色：`full`/`auditor`。

---

## 5. 模块 API（core-dev 实现，测试直接引用）

```js
// lib/canonical.js
export function canonicalJson(value): string         // 键排序、无空格、数字规范
export function sha256Hex(text): string
export function digest(valueOrString): string        // "sha256:"+hex
export function roundHalf(n): number

// lib/contract.js
export const CONTRACT_SCHEMA, CONTRACT_ID_PREFIX
export function validateContract(raw): { ok, issues, contract, state }
export function contractDigest(contract): string
export function matrixCellKey(contract): string
export function contractSummary(contract): object

// lib/expr.js
export function evalNumeric(expr, vars = {}): number  // 安全解析器，不 eval
export function parseEquation(text): { lhs, rhs }
export function sameValue(a, b, tol): boolean

// lib/traps.js
export const TRAPS;                                  // [{id,name,severity,defaultDeduct,basis,detect}]
export function detectTraps({ contract, solution }): TrapFinding[]

// lib/evidence.js
export function buildPlan(contract): Check[]
export function runChecks({ contract, plan, solution, seed }): Evidence[]
export function summarizeEvidence(evidence): { pass, fail, unknown, total, independent_kinds }

// lib/rubric.js
export const RULE_VERSION
export function grade({ contract, solution, evidence }): GradePrediction

// lib/matrix.js
export function emptyMatrix(): Matrix
export function loadMatrix(root): Matrix
export function saveMatrix(root, matrix): void
export function upsertOutcome(matrix, { contract, state, predicted, elapsed_s, at }): Matrix
export function cellStats(cell, targetAttempts = 5): object
export function listCells(matrix, { targetAttempts, limit }): { cells, weakest }
export function routeStrategy(contract): Strategy

// lib/budget.js
export function startBudget(contract, now): Budget
export function checkBudget(budget, now, thresholds): BudgetState

// lib/store.js
export function resolveRoot(cwd, root): string
export function ledgerPath(rootDir, contractId): string
export function readLedger(rootDir, contractId): Ledger|null   // 缺失 null；损坏抛 LEDGER_CORRUPT（不静默覆盖）
export function writeLedger(rootDir, ledger): void
export function readJson(path, fallback): any
export function writeJsonAtomic(path, value): void

// lib/audit.js
export function buildBundle({ ledger, matrixBefore, environment, at }): Bundle
export function writeBundle(rootDir, bundle): string
export function readBundle(path): Bundle|null
export function verifyBundle(bundle): { ok, issues }

// lib/skills.js（宿主半侧用）
export function syncSkills({ sourceRoot, dshHome, logger }): { synced, current, pruned, failed }

// lib/tools.js  ← "dsh-proteus/tools" 入口
export const name = "proteus-tools"
export const Config = z.object({ role: z.string().default("full"), root: z.string().default("proteus"),
  evidenceMinKinds: z.number().default(2), targetAttempts: z.number().default(5) })
export const inject = ["tools", "systemPrompt"]
export function apply(ctx, config): void

// lib/presets.js（宿主半侧用）
export function loadRoster(sourceRoot): Roster
export function loadPersona(sourceRoot, file): string
export function buildPresetDefinition(rosterEntry, persona, { toolsConfig }): PresetDefinition
export function registerPresets({ ctx, sourceRoot, logger }): () => void   // 返回 disposer

// lib/index.js ← 包根入口（宿主）
export const name = "proteus"
export const Config = z.object({ enabled: z.boolean().default(true), skillSync: z.boolean().default(true), presets: z.boolean().default(true) })
export const inject = []          // agentPresets 用 ctx.inject 软依赖
export function apply(ctx, config): void
```

工具 execute 的公共签名：`async execute(args, exec) => value`。`exec.agent?.session?.header?.cwd` 取工作区，失败回退 `process.cwd()`。

---

## 6. 受控词表

### 6.1 陷阱（24 个，ID 与技能库必须一致）

| ID | 名称 | severity | 默认扣分 | 规则检测依据（v0.1 可结构化判定） |
|---|---|---|---|---|
| T01 | 定义域遗漏 | major | 2 | domain∈{calculus,geometry} 且 steps 无 `domain` tag |
| T02 | 绝对值分类讨论不全 | major | 2 | `problem.text` 或 `givens` 文本含 `\|`/`｜`/「绝对值」且 `cases:N` 的 N<2 |
| T03 | 对数定义域遗漏 | major | 2 | 题面/步骤含 `log`/`ln`/`lg` 且无 `domain` tag |
| T04 | 偶次根号定义域遗漏 | major | 2 | 含 `sqrt` 且无 `domain` tag |
| T05 | 分母为零未排除 | major | 2 | 含 `/` 分母变量且无 `domain` tag |
| T06 | 单位遗漏 | minor | 1 | contract 有 units 且 answer.unit 为空 |
| T07 | 多解遗漏 | major | 2 | `contract.verification.expected_solution_count` > 答案个数（缺省不判）；答案切分支持 `,` `;` `；`「或」 |
| T08 | 参数范围未讨论 | major | 2 | `givens[].symbol` 属于单字符参数集合 `a b c k m n p t λ θ`，且 steps 无 `param-range` tag |
| T09 | 区间端点开闭错误 | major | 2 | answer_format=interval 且 value 括号与 `answer_format.endpoints`（兼容单数 `endpoint`）不一致（缺省不判） |
| T10 | 充分必要混淆 | major | 2 | goal=prove 且 steps 含 `iff` 但仅一个方向 tag（`forward`/`backward`） |
| T11 | 循环论证 | blocker | 0 | steps 的 claim 引用了 goal 结论且无独立依据（heuristic，永不扣分） |
| T12 | 增根未检验 | major | 2 | 步骤含 `square-both-sides` 且无 `check:extraneous` tag |
| T13 | 过早四舍五入 | minor | 1 | 中间步骤含 `≈` 且最终答案精度低于容差 |
| T14 | 无结论句 | minor | 1 | goal=prove 且 steps 无 `conclusion` tag |
| T15 | 符号未定义 | minor | 1 | 步骤使用未在 givens/前序定义的符号（regex 粗判，含希腊字母） |
| T16 | 选择题干扰项 | major | 2 | answer 命中 contract.distractors（缺省不判） |
| T17 | 条件未用尽 | major | 2 | givens 中 required 条件在 steps 无引用（需 `uses:G1` tag） |
| T18 | 计数重复/遗漏 | major | 2 | 组合/概率题且无 `cases:N` tag |
| T19 | 独立性误用 | major | 2 | 题面/givens 出现「独立」「条件概率」或 `P(AB)`，且 answer/steps 未标 `independent` |
| T20 | 矩阵乘法顺序错误 | major | 2 | 同一 step 内同时出现 `AB` 与 `BA` |
| T21 | 行列式符号错误 | major | 2 | 线代题 numeric_residual fail |
| T22 | 秩判断错误 | major | 2 | 线代题且无 `rank` tag |
| T23 | 收敛性未检验 | major | 2 | 题面/步骤出现「级数/收敛/发散」且无 `convergence` tag（不再仅凭 domain=series） |
| T24 | 时间超限 | minor | 0 | budget.phase=exhausted（不扣分，只标 reason） |

`TRAPS` 数组元素：`{id,name,severity,defaultDeduct,basis,detect(solution,contract):boolean}`。只有 `basis="rule"` 可扣分。tag 是**模型声明式输入**：缺 tag 会触发规则扣分，贴 tag 可免检，因此 tag 一致性校验列入 v0.2（v0.1 靠技能/persona 与人工审计约束）。

### 6.2 Step tags（受控词表）

`domain`、`cases:N`、`param-range`、`units`、`conclusion`、`theorem:<name>`、`check:extraneous`、`uses:<givenId>`、`rank`、`convergence`、`independent`、`forward`、`backward`、`iff`、`square-both-sides`、`subset`、`complement`。

未知 tag 不报错，但不参与检测。

---

## 7. 预设与技能

### 7.1 预设（5 个，宿主启动时程序化注册）

宿主插件在 `agentPresets` 服务可用时读取 `presets/roster.json`，为每个条目读取 `presets/<personaFile>` 正文，调用 `ctx.agentPresets.register({id,name,description,order,plugins})`。注册失败只记日志，不影响技能同步与其他插件。

`presets/roster.json`（bundle-smith 拥有）：

```jsonc
{
  "schema": "proteus.presets/v1",
  "presets": [
    {
      "id": "proteus",
      "name": "Proteus 应试主控",
      "description": "考试契约 → 矩阵路由 → 求解 → 多路验证 → 评分模拟 → 定稿审计；时间预算内降级。",
      "order": 10,
      "personaFile": "persona-proteus.md",
      "toolsRole": "full",
      "bash": true, "jobs": true, "delegation": true,
      "askUser": true, "web": true
    },
    { "id": "proteus-contractor", "name": "Proteus 契约官", "order": 11,
      "personaFile": "persona-proteus-contractor.md", "toolsRole": "contract",
      "bash": false, "jobs": false, "delegation": false, "askUser": true, "web": false },
    { "id": "proteus-solver", "name": "Proteus 解题者", "order": 12,
      "personaFile": "persona-proteus-solver.md", "toolsRole": "solver",
      "bash": true, "jobs": true, "delegation": true, "askUser": true, "web": false },
    { "id": "proteus-grader", "name": "Proteus 评分官", "order": 13,
      "personaFile": "persona-proteus-grader.md", "toolsRole": "grader",
      "bash": false, "jobs": false, "delegation": false, "askUser": false, "web": false },
    { "id": "proteus-auditor", "name": "Proteus 审计官", "order": 14,
      "personaFile": "persona-proteus-auditor.md", "toolsRole": "auditor",
      "bash": true, "jobs": false, "delegation": false, "askUser": false, "web": false }
  ]
}
```

行模板（`lib/presets.js` 固定生成，顺序稳定；bundle-smith 不重复写）：

```yaml
- { id: persona, name: '@deepseek-ai/dsh-persona', config: { prefix: <persona 正文> } }
- { id: agent-instructions, name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } }
- { id: time-context, name: '@deepseek-ai/dsh-time-context' }
- { id: proteus-tools, name: 'dsh-proteus/tools', config: { role: <toolsRole>, root: 'proteus' } }
- { id: tool-fs, name: '@deepseek-ai/dsh-tool-fs' }                       # 永远有
- { id: tool-fs-search, name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } }
- { id: skill-filesystem, name: '@deepseek-ai/dsh-skill-filesystem' }
- { id: tool-skill, name: '@deepseek-ai/dsh-tool-skill' }
- { id: tool-todo, name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } }
- { id: tool-bash, name: '@deepseek-ai/dsh-tool-bash' }                    # bash: true
- { id: tool-jobs, name: '@deepseek-ai/dsh-tool-jobs' }                    # jobs: true
- { id: tool-ask-user, name: '@deepseek-ai/dsh-tool-ask-user' }            # askUser: true
- { id: tool-web, name: '@deepseek-ai/dsh-tool-web', config: { fetch: false, searchTimeoutMs: 60000 } }  # web: true
- delegation group（delegation: true）:
    - tool-subagent-control
    - tool-subagent-list-agents
    - tool-subagent (provider: spawn, toolName: subagent)
- compaction group（永远有，4 行，照 standard 预设）
```

**persona 简报**（skill-author 写 `presets/persona-<id>.md`，纯 Markdown，无 frontmatter；bundle-smith 贴进 `prefix`）：

- 主控：契约先行铁律；工具调用顺序；五态；时间相位与降级；独立验算（subagent 只拿题目+答案，不给推导）；评分是预测不是权威；不伪造证据；收尾汇报。
- 契约官：只做契约；歧义问人（ask_user_question）；大纲外直接标；不写解法。
- 解题者：结构化步骤（id/text/tags/evidence_refs）；每步声明证据需求；必须 verify；不做评分；不会就 Unknown+部分步骤。
- 评分官：只读 solution+rubric；规则分为准；heuristic 不扣分；输出 GradePrediction 要点；不改写解答。
- 审计官：只做 audit/verify/replay；检查证据链；不改解答；报告问题清单。

### 7.2 技能目录（skill-author 写）

```
skills/proteus/
├── SKILL.md                    # 主入口（frontmatter: name: proteus, description）
├── 大纲/高考数学.md             # 模块→知识点 ID（GK.<MOD>.<NODE>），≥40 个
├── 大纲/考研数学一.md           # KY1.<MOD>.<NODE>，≥50 个
├── 评分标准/高考解答题.md        # 12 分题 step points 模板、踩分点、扣分
├── 评分标准/考研计算题.md
├── 评分标准/证明题.md
├── 陷阱库.md                    # 与 §6.1 的 24 个完全一致，逐条给检测/扣分/反例
├── 输出协议.md                  # 五态、解答模板、evidence 标注
├── 考试矩阵.md                  # 五维指标、优先级、更新规则
└── 审计包.md                    # bundle 结构、replay 语义
```

`SKILL.md` 必须含：frontmatter；`## 0. 入口`；`## 1. 五态输出`；`## 2. 工作流`；`## 3. 工具`；`## 4. 技能索引`；`## 5. 反伪造纪律`；`## 6. 降级`。触发词：`Proteus`、`应试`、`按评分标准`、`步骤分`、`估分`、`高考数学`、`考研数学`、`陷阱`。

知识点 ID 规则：`^[A-Z0-9]+(\.[A-Z0-9_]+)+$`，例：`GK.FUNC.DERIV`、`GK.TRIG.IDENT`、`KY1.CALC.LIMIT`、`KY1.LINALG.EIGEN`、`KY1.PROB.BAYES`。

---

## 8. 验收标准

1. `node --check` 通过 `lib/**/*.js`（或 `node --input-type=module -e "import(...)"`）。
2. `cd Proteus/dsh-proteus && node --test` 全绿（Node 24 下 `node --test test/` 会把目录当模块而失败，不要用）；测试不依赖 DSH、不联网、不写工作区外（临时目录除外）。**工作区没有 `node_modules`**：`schemastery` 只能通过 `lib/config.js` 里的 `await import('schemastery')` + 失败回退（`Config = undefined`）获得；禁止顶层裸 `import z from 'schemastery'`。
3. 测试覆盖：
   - contract：合法/缺点数/枚举错/歧义/大纲外/哈希稳定性；
   - expr：优先级、幂、函数、非法表达式抛错；
   - traps：24 个各一个正例/反例；
   - rubric：满分、缺证据、扣分封顶、confidence、0.5 取整；
   - matrix：upsert/派生指标/优先级排序/原子写；
   - budget：四相位边界；
   - audit：bundle_id 稳定、篡改检测、replay 一致；
   - tools：以 fake ctx/exec + 临时目录跑通 create→verify→grade→finalize→audit 全链路。
4. `cordis.patch.yml` 可被 YAML 解析（bundle-smith 用 `node` 简单校验或肉眼+结构检查；不引入依赖）。
5. 不出现 `@deepseek-ai/dsh-tools` import；不出现绝对路径 `/Users/leon`。

---

## 9. 已知边界（写进设计文档，不在 v0.1 实现）

- 符号计算/形式化证明适配器（需 Python/sympy 或 Lean）；v0.1 只有 JS 数值回代。
- 多模型交叉评审（subagent 可在主控 persona 中手工触发，不是工具保证）。
- 题库/整卷计时/OCR 录题。
- 角色工具限制只到「注册哪些工具」，不做参数级 policy。
- 评分模拟是预测，不是权威；最终以规则分为 canonical，LLM 只做解释。
