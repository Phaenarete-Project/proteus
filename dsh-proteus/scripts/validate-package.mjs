#!/usr/bin/env node
/**
 * validate-package.mjs — dsh-proteus bundle 清单静态校验。
 *
 * 纯 Node（>=22）、零依赖，从 package 根运行：
 *   node scripts/validate-package.mjs
 *   node scripts/validate-package.mjs --quiet   # 只打印 ERROR 与结论
 *
 * 退出码：0 = 全部通过；1 = 至少一个 ERROR。
 *
 * 检查项：
 *  1. package.json / dsh.plugin.json / locale/*.json / presets/roster.json 可 JSON.parse；
 *  2. package.json 的 exports 目标文件存在（lib 未就绪时如实报 ERROR，不静默放过）；
 *  3. cordis.patch.yml 含且仅含一个 insert 块，id=proteus、name=dsh-proteus，无 tab、无 !!js；
 *  4. roster 5 条 id 唯一、order 递增、personaFile 均存在；
 *  5. skills/proteus/SKILL.md 存在且 frontmatter 含 name: proteus 与 description；
 *  6. lib 与 skills 文本里不出现 /Users/leon、不出现 @deepseek-ai/dsh-tools；
 *  7. 附带清单一致性（包名/版本/engines/files 覆盖、locale 文案、icon.svg 合法性、README 关键信息）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUIET = process.argv.includes('--quiet');
const issues = []; // { level: 'error'|'warning', code, message }

const error = (code, message) => issues.push({ level: 'error', code, message });
const warn = (code, message) => issues.push({ level: 'warning', code, message });
const abs = (rel) => join(ROOT, rel);
const exists = (rel) => existsSync(abs(rel));

function readText(rel) {
  try {
    return readFileSync(abs(rel), 'utf8');
  } catch (err) {
    error('READ_FAILED', `${rel} 读取失败: ${err.code || err.message}`);
    return null;
  }
}

function readJson(rel) {
  const text = readText(rel);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    error('JSON_PARSE', `${rel} 不是合法 JSON: ${err.message}`);
    return null;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 去掉 YAML 行内注释（尊重单双引号），用于结构解析。 */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function unquote(value) {
  const trimmed = (value || '').trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** 校验 cordis.patch.yml 的结构：一个顶层 - insert，且只含一条 id=proteus 的行。 */
function validatePatch() {
  const rel = 'cordis.patch.yml';
  if (!exists(rel)) {
    error('PATCH_MISSING', `${rel} 不存在`);
    return;
  }
  const text = readText(rel);
  if (text === null) return;

  if (text.includes('\t')) error('PATCH_TAB', `${rel} 含制表符（YAML 缩进禁止 tab）`);

  const lines = text
    .split(/\r?\n/)
    .map((raw, index) => ({ no: index + 1, text: stripComment(raw) }))
    .filter((line) => line.text.trim() !== '');
  const yamlContent = lines.map((line) => line.text).join('\n');
  if (yamlContent.includes('!!js')) {
    error('PATCH_JS_TAG', `${rel} 出现 !!js（bundle patch 禁止求值标签）`);
  }

  const topLevel = lines.filter((line) => line.text[0] !== ' ' && line.text[0] !== '\t');
  const insertLines = topLevel.filter((line) => /^-\s+insert:\s*$/.test(line.text));
  const otherTop = topLevel.filter((line) => line !== undefined && !/^-\s+insert:\s*$/.test(line.text));

  if (insertLines.length !== 1) {
    error(
      'PATCH_INSERT_COUNT',
      `${rel} 顶层 - insert 块数量为 ${insertLines.length}，期望恰好 1 个`,
    );
  }
  if (otherTop.length > 0) {
    error(
      'PATCH_EXTRA_TOP',
      `${rel} 存在 insert 之外的顶层条目: 第 ${otherTop.map((line) => line.no).join('、')} 行`,
    );
  }
  if (insertLines.length !== 1) return;

  const insertLine = insertLines[0];
  const body = lines.filter((line) => line.no > insertLine.no);
  const entryStart = body.findIndex((line) => /^\s*-\s+/.test(line.text));
  if (entryStart < 0) {
    error('PATCH_NO_ROW', `${rel} 的 insert 块没有任何插件行`);
    return;
  }

  const entryIndent = body[entryStart].text.match(/^(\s*)/)[1].length;
  const entryLines = [];
  for (let i = entryStart; i < body.length; i += 1) {
    const line = body[i];
    const indent = line.text.match(/^(\s*)/)[1].length;
    if (i > entryStart && indent <= entryIndent) break;
    entryLines.push(line);
  }
  const extraRows = body
    .slice(entryStart + entryLines.length)
    .filter((line) => /^\s*-\s+/.test(line.text));
  if (extraRows.length > 0) {
    error(
      'PATCH_ROW_COUNT',
      `${rel} 的 insert 块含 ${1 + extraRows.length} 条插件行（期望 1 条）: 第 ${extraRows
        .map((line) => line.no)
        .join('、')} 行为多余行`,
    );
  }

  // 归一化条目字段（去掉首行 "- " 与缩进）。
  const fields = entryLines.map((line, index) => {
    let trimmed = line.text.trim();
    let indent = line.text.match(/^(\s*)/)[1].length;
    if (index === 0) {
      // "- id: proteus" 的 "- " 占 2 列，等价于其余字段的缩进。
      trimmed = trimmed.replace(/^-\s+/, '');
      indent += 2;
    }
    return { no: line.no, indent, text: trimmed };
  });
  const topIndent = Math.min(...fields.map((field) => field.indent));
  const top = {};
  const nested = {};
  for (const field of fields) {
    const match = field.text.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!match) continue;
    if (field.indent === topIndent) {
      top[match[1]] = unquote(match[2]);
    } else if (field.indent > topIndent) {
      nested[match[1]] = unquote(match[2]);
    }
  }

  if (top.id !== 'proteus') {
    error('PATCH_ROW_ID', `${rel} 插件行 id 为 ${JSON.stringify(top.id ?? null)}，期望 "proteus"`);
  }
  if (top.name !== 'dsh-proteus') {
    error(
      'PATCH_ROW_NAME',
      `${rel} 插件行 name 为 ${JSON.stringify(top.name ?? null)}，期望 "dsh-proteus"`,
    );
  }
  for (const key of ['enabled', 'skillSync', 'presets']) {
    if (nested[key] !== 'true') {
      error('PATCH_CONFIG', `${rel} config.${key} 应为 true，实际为 ${JSON.stringify(nested[key] ?? null)}`);
    }
  }
}

/** 校验预设 roster（§7.1 固定 5 条）。 */
function validateRoster(roster) {
  if (!roster) return;
  const rel = 'presets/roster.json';

  if (roster.schema !== 'proteus.presets/v1') {
    error('ROSTER_SCHEMA', `${rel} schema 应为 "proteus.presets/v1"，实际为 ${JSON.stringify(roster.schema ?? null)}`);
  }
  if (!Array.isArray(roster.presets)) {
    error('ROSTER_SHAPE', `${rel} 缺少 presets 数组`);
    return;
  }
  if (roster.presets.length !== 5) {
    error('ROSTER_COUNT', `${rel} 预设数量为 ${roster.presets.length}，期望 5`);
  }

  const expected = [
    ['proteus', 'persona-proteus.md', 'full'],
    ['proteus-contractor', 'persona-proteus-contractor.md', 'contract'],
    ['proteus-solver', 'persona-proteus-solver.md', 'solver'],
    ['proteus-grader', 'persona-proteus-grader.md', 'grader'],
    ['proteus-auditor', 'persona-proteus-auditor.md', 'auditor'],
  ];
  const expectedIds = expected.map(([id]) => id);
  const seenIds = new Set();
  const seenOrders = new Set();
  let previousOrder = -Infinity;

  roster.presets.forEach((preset, index) => {
    const where = `${rel} presets[${index}]`;
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
      error('ROSTER_ENTRY', `${where} 不是对象`);
      return;
    }
    for (const key of ['id', 'name', 'description', 'personaFile', 'toolsRole']) {
      if (!isNonEmptyString(preset[key])) error('ROSTER_FIELD', `${where}.${key} 缺失或为空`);
    }
    if (typeof preset.order !== 'number' || !Number.isFinite(preset.order)) {
      error('ROSTER_ORDER', `${where}.order 必须是有限数字`);
    } else {
      if (preset.order <= previousOrder) {
        error('ROSTER_ORDER', `${where}.order=${preset.order} 未严格递增（前一条为 ${previousOrder}）`);
      }
      if (seenOrders.has(preset.order)) error('ROSTER_ORDER', `${where}.order=${preset.order} 重复`);
      seenOrders.add(preset.order);
      previousOrder = preset.order;
    }
    if (preset.id) {
      if (seenIds.has(preset.id)) error('ROSTER_DUP_ID', `${where}.id=${preset.id} 重复`);
      seenIds.add(preset.id);
    }
    const [, expectedPersona, expectedRole] = expected[index] || [];
    if (expectedPersona && preset.personaFile !== expectedPersona) {
      error(
        'ROSTER_PERSONA',
        `${where}.personaFile 为 ${JSON.stringify(preset.personaFile ?? null)}，期望 "${expectedPersona}"`,
      );
    }
    if (expectedRole && preset.toolsRole !== expectedRole) {
      error(
        'ROSTER_ROLE',
        `${where}.toolsRole 为 ${JSON.stringify(preset.toolsRole ?? null)}，期望 "${expectedRole}"`,
      );
    }
    for (const flag of ['bash', 'jobs', 'delegation', 'askUser', 'web']) {
      if (typeof preset[flag] !== 'boolean') error('ROSTER_FLAG', `${where}.${flag} 必须是布尔值`);
    }
    if (isNonEmptyString(preset.personaFile) && !exists(join('presets', preset.personaFile))) {
      error('ROSTER_PERSONA_MISSING', `${where}.personaFile 指向的文件不存在: presets/${preset.personaFile}`);
    }
  });

  if (roster.presets.length === 5) {
    for (const id of expectedIds) {
      if (!seenIds.has(id)) error('ROSTER_ID_SET', `${rel} 缺少预设 id="${id}"`);
    }
    for (const id of seenIds) {
      if (!expectedIds.includes(id)) error('ROSTER_ID_SET', `${rel} 含 spec 之外的预设 id="${id}"`);
    }
  }
}

/** 校验 SKILL.md frontmatter。 */
function validateSkill() {
  const rel = 'skills/proteus/SKILL.md';
  if (!exists(rel)) {
    error('SKILL_MISSING', `${rel} 不存在（等待 skill-author 交付）`);
    return;
  }
  const text = readText(rel);
  if (text === null) return;
  if (!/^---\r?\n/.test(text)) {
    error('SKILL_FRONTMATTER', `${rel} 未以 YAML frontmatter (---) 开头`);
    return;
  }
  const end = text.indexOf('\n---', 3);
  if (end < 0) {
    error('SKILL_FRONTMATTER', `${rel} frontmatter 未闭合`);
    return;
  }
  const frontmatter = text.slice(4, end);
  if (!/^name:\s*['"]?proteus['"]?\s*$/m.test(frontmatter)) {
    error('SKILL_NAME', `${rel} frontmatter 缺少 name: proteus`);
  }
  if (!/^description:\s*\S.*$/m.test(frontmatter)) {
    error('SKILL_DESCRIPTION', `${rel} frontmatter 缺少非空 description`);
  }
  const chars = [...text].length;
  if (chars > 8192) {
    warn('SKILL_SIZE', `${rel} 长度为 ${chars} 字符，超过 8192 字符的目标上限`);
  }
}

/** 递归列出目录下的文件（跳过 node_modules/.git）。 */
function walk(dirRel) {
  const start = abs(dirRel);
  if (!existsSync(start)) return [];
  const out = [];
  const visit = (current, rel) => {
    for (const name of readdirSync(current)) {
      if (name === 'node_modules' || name === '.git') continue;
      const full = join(current, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const stat = statSync(full);
      if (stat.isDirectory()) visit(full, relPath);
      else if (stat.isFile()) out.push({ rel: relPath, size: stat.size });
    }
  };
  visit(start, dirRel);
  return out;
}

const TEXT_EXTENSIONS = /\.(?:js|mjs|cjs|json|md|markdown|yml|yaml|txt|ts|d\.ts)$/;
const FORBIDDEN = [
  ['FORBIDDEN_ABSPATH', '/Users/leon', '出现本机绝对路径 /Users/leon（可移植性要求）'],
  ['FORBIDDEN_DSH_TOOLS', '@deepseek-ai/dsh-tools', '出现禁止的 @deepseek-ai/dsh-tools 依赖'],
];

/** 扫描 lib 与 skills 下的文本文件。 */
function validateForbiddenContent() {
  for (const dir of ['lib', 'skills']) {
    if (!exists(dir)) {
      warn('SCAN_SKIP', `${dir}/ 尚不存在，跳过禁用串扫描（等待并行交付）`);
      continue;
    }
    for (const file of walk(dir)) {
      if (!TEXT_EXTENSIONS.test(file.rel)) continue;
      if (file.size > 4 * 1024 * 1024) {
        warn('SCAN_LARGE', `${file.rel} 超过 4MiB，跳过禁用串扫描`);
        continue;
      }
      const text = readText(file.rel);
      if (text === null) continue;
      for (const [code, needle, message] of FORBIDDEN) {
        if (text.includes(needle)) error(code, `${file.rel}: ${message}`);
      }
    }
  }
}

/** 主流程 */
function main() {
  // 1) JSON 可解析
  const pkg = readJson('package.json');
  const manifest = readJson('dsh.plugin.json');
  const roster = readJson('presets/roster.json');
  const locales = {};
  for (const lang of ['en', 'zh']) {
    locales[lang] = readJson(`locale/${lang}.json`);
  }

  // 2) package.json 清单事实
  const requiredFiles = [
    'lib',
    'lib/**',
    'cordis.patch.yml',
    'dsh.plugin.json',
    'locale/*.json',
    'icon.svg',
    'README.md',
    'presets/**',
    'skills/**',
    'scripts/validate-package.mjs',
  ];

  if (pkg) {
    const facts = [
      ['PKG_NAME', pkg.name === 'dsh-proteus', `name 应为 "dsh-proteus"，实际为 ${JSON.stringify(pkg.name ?? null)}`],
      ['PKG_VERSION', pkg.version === '0.1.0', `version 应为 "0.1.0"，实际为 ${JSON.stringify(pkg.version ?? null)}`],
      ['PKG_TYPE', pkg.type === 'module', 'type 应为 "module"'],
      ['PKG_MAIN', pkg.main === 'lib/index.js', 'main 应为 "lib/index.js"'],
      [
        'PKG_PATCH',
        pkg.dsh?.bundle?.patch === './cordis.patch.yml',
        'dsh.bundle.patch 应为 "./cordis.patch.yml"',
      ],
      [
        'PKG_ENGINE',
        pkg.engines?.node === '>=22.19.0',
        `engines.node 应为 ">=22.19.0"，实际为 ${JSON.stringify(pkg.engines?.node ?? null)}`,
      ],
      [
        'PKG_DEP',
        pkg.dependencies?.schemastery === '^3.18.0',
        'dependencies.schemastery 应为 "^3.18.0"',
      ],
      [
        'PKG_EXPORTS',
        pkg.exports?.['.'] === './lib/index.js' &&
          pkg.exports?.['./tools'] === './lib/tools.js' &&
          pkg.exports?.['./package.json'] === './package.json',
        'exports 至少应含 "."、"tools"、"package.json" 三个入口',
      ],
    ];
    for (const [code, pass, message] of facts) {
      if (!pass) error(code, `package.json: ${message}`);
    }

    const peerKeys = Object.keys(pkg.peerDependencies || {});
    const deepseekPeers = peerKeys.filter((key) => key.startsWith('@deepseek-ai/'));
    if (deepseekPeers.length > 0) {
      error('PKG_PEER', `package.json peerDependencies 不应包含: ${deepseekPeers.join(', ')}`);
    }

    if (!Array.isArray(pkg.files)) {
      error('PKG_FILES', 'package.json: files 必须是数组');
    } else {
      const normalize = (entry) => String(entry).replace(/^\.\//, '').replace(/\/+$/, '');
      const published = new Set(pkg.files.map(normalize));
      for (const required of requiredFiles) {
        if (!published.has(normalize(required))) {
          error('PKG_FILES_COVERAGE', `package.json files 未覆盖 ${required}`);
        }
      }
    }

    // 2) exports 目标文件存在（lib 未就绪时如实报 ERROR）
    if (pkg.exports && typeof pkg.exports === 'object') {
      for (const [key, target] of Object.entries(pkg.exports)) {
        if (typeof target !== 'string') {
          warn('EXPORT_SHAPE', `package.json exports["${key}"] 不是字符串，跳过存在性检查`);
          continue;
        }
        if (target.includes('*')) continue;
        const rel = target.replace(/^\.\//, '');
        if (!exists(rel)) error('EXPORT_MISSING', `exports["${key}"] 目标文件缺失: ${rel}`);
      }
    }

    if (typeof pkg.icon === 'string') {
      const iconRel = pkg.icon.replace(/^\.\//, '');
      if (!exists(iconRel)) error('ICON_MISSING', `package.json icon 指向的文件缺失: ${iconRel}`);
    }
  }

  // dsh.plugin.json
  const manifestFacts = [
    ['MANIFEST_ID', manifest?.id === 'dsh-proteus', `id 应为 "dsh-proteus"，实际为 ${JSON.stringify(manifest?.id ?? null)}`],
    ['MANIFEST_VERSION', manifest?.version === '0.1.0', 'version 应为 "0.1.0"'],
    ['MANIFEST_MAIN', manifest?.main === 'lib/index.js', 'main 应为 "lib/index.js"'],
    [
      'MANIFEST_DESCRIPTION',
      isNonEmptyString(manifest?.description),
      'description 缺失或为空',
    ],
    ['MANIFEST_ENGINES', manifest?.engines?.dsh === '>=0.0.1', 'engines.dsh 应为 ">=0.0.1"'],
    [
      'MANIFEST_TOOLS',
      Array.isArray(manifest?.contributes?.tools),
      'contributes.tools 必须是数组',
    ],
    [
      'MANIFEST_SKILLS',
      Array.isArray(manifest?.contributes?.skills) && manifest.contributes.skills.includes('proteus'),
      'contributes.skills 应包含 "proteus"',
    ],
  ];
  if (manifest) {
    for (const [code, pass, message] of manifestFacts) {
      if (!pass) error(code, `dsh.plugin.json: ${message}`);
    }
  }

  // locale 文案
  for (const lang of ['en', 'zh']) {
    const locale = locales[lang];
    if (!locale) continue;
    const rel = `locale/${lang}.json`;
    if (!isNonEmptyString(locale.meta?.title)) error('LOCALE_TITLE', `${rel}: meta.title 缺失或为空`);
    if (!isNonEmptyString(locale.meta?.description)) {
      error('LOCALE_DESCRIPTION', `${rel}: meta.description 缺失或为空`);
    }
    if (isNonEmptyString(locale.meta?.title) && [...locale.meta.title].length > 40) {
      error('LOCALE_TITLE_LEN', `${rel}: meta.title 超过 40 字`);
    }
    if (isNonEmptyString(locale.meta?.title)) {
      const cjk = /[\u4e00-\u9fff]/.test(locale.meta.title);
      if (lang === 'zh' && !cjk) warn('LOCALE_LANG', `${rel}: 标题未使用中文`);
      if (lang === 'en' && cjk) warn('LOCALE_LANG', `${rel}: 英文标题含中文字符`);
    }
  }

  // 3) 4) 5) 6)
  validatePatch();
  validateRoster(roster);
  validateSkill();
  validateForbiddenContent();

  // icon.svg
  if (!exists('icon.svg')) {
    error('ICON_MISSING', 'icon.svg 不存在');
  } else {
    const size = statSync(abs('icon.svg')).size;
    if (size > 256 * 1024) error('ICON_SIZE', `icon.svg 大小 ${size} 字节，超过 256KiB`);
    const svg = readText('icon.svg') || '';
    if (!/^\s*<svg[\s>]/i.test(svg)) error('ICON_SVG', 'icon.svg 不是以 <svg> 开头的 SVG 文档');
    if (!/<\/svg>\s*$/i.test(svg)) error('ICON_SVG', 'icon.svg 缺少闭合 </svg>');
    if (/<script[\s>]/i.test(svg)) error('ICON_SCRIPT', 'icon.svg 含 <script>');
    if (/(?:href|src)\s*=\s*["']https?:/i.test(svg)) {
      error('ICON_EXTERNAL', 'icon.svg 引用外部 http(s) 资源');
    }
    if (!/viewBox\s*=/.test(svg)) warn('ICON_VIEWBOX', 'icon.svg 缺少 viewBox');
  }

  // README 关键信息（文档质量，记 warning）
  if (!exists('README.md')) {
    error('README_MISSING', 'README.md 不存在');
  } else {
    const readme = readText('README.md') || '';
    const markers = [
      ['Proteus 应试主控', '预设选择说明'],
      ['dsh plugin --profile desktop add', '安装命令'],
      ['~/.dsh/skills/proteus/', '技能路径'],
      ['proteus_contract', '7 工具表'],
      ['能力边界', 'v0.1 能力边界'],
    ];
    for (const [needle, label] of markers) {
      if (!readme.includes(needle)) warn('README_MARKER', `README.md 缺少${label}（${needle}）`);
    }
  }

  // 7) 24 陷阱三方一致（spec / 陷阱库 / lib/traps.js）+ SKILL.md 大小上限
  try {
    const expected = Array.from({ length: 24 }, (_, index) => `T${String(index + 1).padStart(2, '0')}`).join(',');
    const specText = readText('../spec/INTERFACES.md') || '';
    const libraryText = readText('skills/proteus/陷阱库.md') || '';
    const codeText = readText('lib/traps.js') || '';
    const sets = [
      ['spec', [...specText.matchAll(/^\| (T\d{2}) \|/gm)].map((match) => match[1])],
      ['陷阱库', [...libraryText.matchAll(/^## (T\d{2})\b/gm)].map((match) => match[1])],
      ['traps.js', [...codeText.matchAll(/id:\s*'(T\d{2})'/g)].map((match) => match[1])],
    ];
    for (const [name, ids] of sets) {
      const unique = [...new Set(ids)].sort().join(',');
      if (unique !== expected) {
        error('TRAP_SET', `${name} 的陷阱 ID 集合与 T01–T24 不一致（实际 ${ids.length} 个）`);
      }
    }
  } catch (error_) {
    error('TRAP_CHECK', `陷阱三方一致性检查失败: ${error_?.message ?? error_}`);
  }
  if (exists('skills/proteus/SKILL.md')) {
    const skillBytes = statSync(abs('skills/proteus/SKILL.md')).size;
    if (skillBytes > 8192) {
      error('SKILL_TOO_LARGE', `skills/proteus/SKILL.md 为 ${skillBytes} 字节，超过 8192 上限`);
    }
  }

  // 输出
  const errors = issues.filter((issue) => issue.level === 'error');
  const warnings = issues.filter((issue) => issue.level === 'warning');
  for (const issue of issues) {
    if (issue.level === 'warning' && QUIET) continue;
    const tag = issue.level === 'error' ? 'ERROR' : 'WARN ';
    console.error(`${tag} [${issue.code}] ${issue.message}`);
  }
  if (errors.length === 0) {
    console.log(`validate-package: OK${warnings.length ? ` (${warnings.length} warning)` : ''}`);
    process.exitCode = 0;
  } else {
    console.error(
      `validate-package: FAILED (${errors.length} error, ${warnings.length} warning)`,
    );
    process.exitCode = 1;
  }
}

main();
