import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncSkills } from '../lib/skills.js';
import { makeTempDir } from './helpers.js';

test('skills：改名/删除后清理目标侧残留文件与空目录', () => {
  const source = makeTempDir('proteus-skill-src-');
  const home = makeTempDir('proteus-skill-home-');
  try {
    const srcDir = join(source.dir, 'proteus');
    mkdirSync(join(srcDir, '大纲'), { recursive: true });
    writeFileSync(join(srcDir, 'SKILL.md'), '---\nname: proteus\n---\n');
    writeFileSync(join(srcDir, '大纲', '高考数学.md'), '# 高考\n');

    const first = syncSkills({ sourceDir: srcDir, dshHome: home.dir });
    assert.equal(first.synced, 2);
    const target = join(home.dir, 'skills', 'proteus');
    assert.ok(existsSync(join(target, '大纲', '高考数学.md')));

    // 目标侧出现不属于源清单的旧文件（模拟上一版本遗留）
    writeFileSync(join(target, '旧文件.md'), 'stale');

    // 源侧删除一个文件、新增一个文件（模拟改名/重构）
    writeFileSync(join(srcDir, '改名后.md'), readFileSync(join(srcDir, '大纲', '高考数学.md')));
    unlinkSync(join(srcDir, '大纲', '高考数学.md'));
    const second = syncSkills({ sourceDir: srcDir, dshHome: home.dir });
    assert.equal(second.synced, 1, '新增文件应被同步');
    assert.equal(second.pruned, 2, '旧文件与已删除的源文件都应被清理');
    assert.equal(existsSync(join(target, '旧文件.md')), false);
    assert.equal(existsSync(join(target, '大纲', '高考数学.md')), false);
    assert.equal(existsSync(join(target, '大纲')), false, '空目录应被删除');
    assert.equal(existsSync(join(target, '改名后.md')), true);

    const third = syncSkills({ sourceDir: srcDir, dshHome: home.dir });
    assert.equal(third.synced, 0);
    assert.equal(third.current, 2);
    assert.equal(third.pruned, 0);
  } finally {
    source.cleanup();
    home.cleanup();
  }
});
