/**
 * 文本切分
 *
 * 注意：LLM Wiki 方案下，切分不承担"检索粒度"的职责（检索由语义导航完成），
 * 它的作用是把超长文档拆成可分批处理的段，并保持语义边界完整。
 * 所以这里不设重叠窗口 —— 重叠是为向量检索服务的，对编译式方案只会造成内容重复。
 */
export function chunkText(text, targetSize = 1500) {
  const clean = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!clean) return [];

  // 先按段落拆
  const paragraphs = clean
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let buf = '';

  const flush = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = '';
  };

  for (const p of paragraphs) {
    if (p.length > targetSize) {
      flush();
      // 超长段落：按句子边界切
      const sentences = p.split(/(?<=[。！？；.!?;])\s*/);
      let cur = '';
      for (const s of sentences) {
        if (cur.length + s.length > targetSize && cur) {
          chunks.push(cur.trim());
          cur = '';
        }
        // 单句仍超长则硬切
        if (s.length > targetSize) {
          for (let i = 0; i < s.length; i += targetSize) {
            chunks.push(s.slice(i, i + targetSize).trim());
          }
          continue;
        }
        cur += s;
      }
      if (cur.trim()) chunks.push(cur.trim());
      continue;
    }

    if (buf.length + p.length + 2 > targetSize && buf) flush();
    buf = buf ? buf + '\n\n' + p : p;
  }

  flush();
  return chunks.filter(Boolean);
}
