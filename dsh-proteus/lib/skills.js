/**
 * 宿主半侧：把随包 `skills/proteus/` 幂等同步到 `$DSH_HOME/skills/proteus/`。
 *
 * 幂等：逐文件比较字节，相同计入 current，不同/缺失才写（synced）。
 * 失败不抛错、不阻断宿主启动：收集到 failed 并 warn。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';

/** 展开路径开头的 `~`。 */
export function expandHome(path, home = homedir()) {
  if (typeof path !== 'string') return path;
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2));
  return path;
}

/**
 * 解析 DSH 主目录：DSH_HOME 优先，其次平台 home 下的 `.dsh`。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const raw = env?.DSH_HOME;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const expanded = expandHome(raw.trim(), home);
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded);
  }
  return join(home, '.dsh');
}

function filesUnder(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === '.DS_Store') continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(root);
  out.sort();
  return out;
}

/**
 * 幂等同步技能目录。
 * @param {{sourceRoot: string, dshHome?: string, logger?: {info?: Function, warn?: Function}, skillName?: string, sourceDir?: string}} input
 * @returns {{synced: number, current: number, failed: Array<{file: string, code: string, message?: string}>}}
 */
export function syncSkills({ sourceRoot, dshHome, logger, skillName = 'proteus', sourceDir } = {}) {
  const result = { synced: 0, current: 0, pruned: 0, failed: [] };
  const src = sourceDir ?? join(sourceRoot, 'skills', skillName);
  const home = dshHome ?? resolveDshHome();
  const target = join(home, 'skills', skillName);

  if (!existsSync(src)) {
    const message = `技能源目录不存在: ${src}`;
    result.failed.push({ file: src, code: 'SKILL_SOURCE_MISSING', message });
    logger?.warn?.(`[proteus] ${message}`);
    return result;
  }

  let files;
  try {
    files = filesUnder(src);
  } catch (error) {
    result.failed.push({ file: src, code: 'SKILL_SCAN_FAILED', message: error?.message ?? String(error) });
    logger?.warn?.(`[proteus] 技能目录扫描失败: ${error?.message ?? error}`);
    return result;
  }

  for (const file of files) {
    const relativePath = relative(src, file);
    const destination = join(target, relativePath);
    try {
      const bytes = readFileSync(file);
      if (existsSync(destination) && readFileSync(destination).equals(bytes)) {
        result.current += 1;
        continue;
      }
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
      result.synced += 1;
    } catch (error) {
      result.failed.push({ file: relativePath, code: 'SKILL_COPY_FAILED', message: error?.message ?? String(error) });
      logger?.warn?.(`[proteus] 技能同步失败 ${relativePath}: ${error?.message ?? error}`);
    }
  }

  // 清理源目录已不存在的旧文件：技能改名/删除后不在目标侧留残影。
  // 仅删除 target 内、且相对路径不在本次源清单中的文件；随后向上删除空目录。
  const keep = new Set(files.map((file) => relative(src, file)));
  const touchedParents = new Set();
  try {
    for (const stale of filesUnder(target)) {
      const relativePath = relative(target, stale);
      if (keep.has(relativePath)) continue;
      unlinkSync(stale);
      touchedParents.add(dirname(stale));
      result.pruned += 1;
    }
    for (const start of touchedParents) {
      let dir = start;
      while (dir !== target && dir.startsWith(target)) {
        if (!existsSync(dir) || readdirSync(dir).length > 0) break;
        rmdirSync(dir);
        dir = dirname(dir);
      }
    }
  } catch (error) {
    result.failed.push({ file: target, code: 'SKILL_PRUNE_FAILED', message: error?.message ?? String(error) });
    logger?.warn?.(`[proteus] 技能残留清理失败: ${error?.message ?? error}`);
  }

  // 最小结构校验：SKILL.md 必须有 YAML frontmatter 且含 name/description，
  // 否则技能提供方会静默丢弃它（失败只记录，不阻断宿主）。
  const skillFile = join(target, 'SKILL.md');
  try {
    const text = readFileSync(skillFile, 'utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
    if (frontmatter === '' || !/\bname:\s*proteus\b/.test(frontmatter) || !/\bdescription:\s*\S/.test(frontmatter)) {
      result.failed.push({
        file: 'SKILL.md',
        code: 'SKILL_FRONTMATTER',
        message: 'SKILL.md 缺少合法的 YAML frontmatter（name: proteus / description）',
      });
    }
  } catch (error) {
    result.failed.push({ file: 'SKILL.md', code: 'SKILL_READ_FAILED', message: error?.message ?? String(error) });
  }

  const summary = `技能同步 ${src} → ${target}: synced=${result.synced} current=${result.current} pruned=${result.pruned} failed=${result.failed.length}`;
  if (result.failed.length > 0) logger?.warn?.(`[proteus] ${summary}`);
  else logger?.info?.(`[proteus] ${summary}`);
  return result;
}
