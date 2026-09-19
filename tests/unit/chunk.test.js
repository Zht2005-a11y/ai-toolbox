import test from 'node:test';
import assert from 'node:assert/strict';

import { chunkText } from '../../lib/chunk.js';

test('空输入返回空数组', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\n  '), []);
  assert.deepEqual(chunkText(null), []);
  assert.deepEqual(chunkText(undefined), []);
});

test('短文本返回单段，且首尾空白被去掉', () => {
  const out = chunkText('  你好，世界  ');
  assert.deepEqual(out, ['你好，世界']);
});

test('空白归一化：CRLF、连续空格、3 个以上换行', () => {
  const out = chunkText('a\r\n\r\n\r\nb   c');
  assert.deepEqual(out, ['a\n\nb c']);
});

test('多个短段落会合并进同一段（不超过目标长度）', () => {
  const out = chunkText('aaaa\n\nbbbb', 20);
  assert.deepEqual(out, ['aaaa\n\nbbbb']);
});

test('超过目标长度时按段落边界拆开', () => {
  const out = chunkText('aaaa\n\nbbbb', 8);
  assert.deepEqual(out, ['aaaa', 'bbbb']);
});

test('超长段落按句子边界切分', () => {
  const text = '第一句。第二句。第三句。';
  const out = chunkText(text, 6);
  assert.deepEqual(out, ['第一句。', '第二句。', '第三句。']);
});

test('单句超长且无标点时硬切，内容不丢失', () => {
  const text = 'x'.repeat(20);
  const out = chunkText(text, 6);
  assert.deepEqual(out.map((c) => c.length), [6, 6, 6, 2]);
  assert.equal(out.join(''), text, '拼接后应与原文一致');
});

test('长文档切分后内容不丢失（逐句可找回）', () => {
  const sentences = Array.from({ length: 40 }, (_, i) => `这是第 ${i + 1} 句话，用于验证切分不丢内容。`);
  const text = sentences.join('');
  const out = chunkText(text, 1500);
  const joined = out.join('');
  for (const s of sentences) {
    assert.ok(joined.includes(s), `切分后应能找回：${s}`);
  }
});

test('默认目标长度下，普通中文文档切成多段', () => {
  const text = Array.from({ length: 20 }, (_, i) => `段落 ${i + 1}：` + '内容内容内容'.repeat(30)).join('\n\n');
  const out = chunkText(text);
  assert.ok(out.length > 1, '应切成多段');
  for (const c of out) {
    assert.ok(c.length <= 1500 * 1.2, '单段不应远超目标长度');
  }
});
