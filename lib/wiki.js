import * as store from './store.js';
import { chat, chatJSON, chatStream, sleep } from './llm.js';

// ===== Schema：给 LLM 的行为契约（对应 LLM Wiki 的 schema 层）=====
const SCHEMA = `你是「知识库维基维护员」，负责把用户上传的原始资料编译成结构化的 Markdown 词条。

【身份】你不是聊天机器人，是知识库的编译器和维护员。

【安全红线】
1. 原始资料（raw）只读，永不修改。
2. 词条页面永不物理删除；内容过时用「> 已过时：」引用块标注，不删除原文。
3. 每条知识点都要能追溯到来源，禁止无出处的论断。
4. 不编造原文没有的事实；原文没说的，不要补充。

【词条类型】
- concept：概念、技术、方法论
- entity：具体的人、公司、产品、组织
- summary：一份来源资料的摘要
- synthesis：跨来源的综合分析、对比结论

【写作规范】
- 用简体中文，Markdown 格式
- 每个词条 200~700 字，精炼、信息密度高，不要空话
- 结构：## 定义 / ## 要点 / ## 关联（用 [[其他词条]] 建立双向链接）
- 关联链接只在确实相关时建立，不要硬凑`;

// 单次送入模型的文本上限（字符）。512K 上下文足够，这里保守取值控制成本与延迟
const MAX_SINGLE_CHARS = Math.max(20000, Number(process.env.WIKI_MAX_SINGLE || 60000));
// 已有词条全量送入的上限
const MAX_EXISTING_CHARS = Math.max(10000, Number(process.env.WIKI_MAX_EXISTING || 60000));
// 每次 ingest 最多更新的已有词条数
const MAX_UPDATES = Math.max(1, Number(process.env.WIKI_MAX_UPDATES || 6));

// ===================== 编译队列（全局串行，避免索引并发写 + 遵守 RPM 限制）=====================
const queue = [];
let running = false;

export function enqueueCompile(userId, docId) {
  if (queue.some((t) => t.docId === docId)) return false;
  queue.push({ userId, docId, type: 'compile' });
  pump();
  return true;
}

/** 文档被删除后重建目录，让 index 与实际词条保持一致 */
export function enqueueReindex(userId) {
  queue.push({ userId, docId: null, type: 'reindex' });
  pump();
}

export function queueStatus() {
  return { pending: queue.length, running };
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const task = queue.shift();
    try {
      if (task.type === 'reindex') {
        await rebuildIndex(task.userId);
        store.appendLog(task.userId, 'reindex | 目录已重建');
      } else {
        await compileDocument(task.userId, task.docId);
      }
    } catch (e) {
      console.error('[wiki] 编译任务异常:', e.message);
    }
  }
  running = false;
}

// ===================== 工具 =====================

function nowStamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 16);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** 把切分后的数组按字符数分组 */
function groupByChars(items, limit) {
  const batches = [];
  let cur = [];
  let len = 0;
  for (const it of items) {
    const t = typeof it === 'string' ? it : it.text;
    if (len + t.length > limit && cur.length) {
      batches.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(t);
    len += t.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * 超长文档先分批摘要，再合并成"提炼稿"供编译使用
 * 返回 { text, batched }
 */
async function distill(chunks) {
  const full = chunks.join('\n\n');
  if (full.length <= MAX_SINGLE_CHARS) return { text: full, batched: false };

  const batches = groupByChars(chunks, MAX_SINGLE_CHARS);
  const parts = [];
  for (let i = 0; i < batches.length; i++) {
    const part = await chat(
      [
        {
          role: 'system',
          content:
            '你是资料整理助手。请对用户给出的这一段原始资料做结构化提炼，保留所有关键事实、数据、专有名词、结论和定义，去掉冗余表述。用简体中文，要点式输出，不要遗漏信息。',
        },
        {
          role: 'user',
          content: `【第 ${i + 1}/${batches.length} 段】\n\n${batches[i].join('\n\n')}`,
        },
      ],
      { throttle: true, maxTokens: 4096, temperature: 0.2 }
    );
    parts.push(part);
  }
  return { text: parts.join('\n\n---\n\n'), batched: true };
}

/** 读取某用户的已有词条清单与内容 */
function readExisting(userId) {
  const slugs = store.listPages(userId);
  const pages = [];
  let total = 0;
  for (const slug of slugs) {
    const raw = store.readPage(userId, slug);
    if (!raw) continue;
    const title = (raw.match(/^title:\s*(.+)$/m) || [])[1] || slug;
    const summary = (raw.match(/^summary:\s*(.+)$/m) || [])[1] || '';
    total += raw.length;
    pages.push({ slug, title: title.trim(), summary: summary.trim(), raw });
  }
  return { pages, total };
}

function buildPageFile({ title, type, content, sources, summary }) {
  return `---
title: ${title}
type: ${type}
summary: ${summary || ''}
sources: ${sources.join(', ')}
updated: ${today()}
---

# ${title}

${content.trim()}
`;
}

// ===================== Ingest：编译 =====================

export async function compileDocument(userId, docId) {
  const doc = store.getDoc(userId, docId);
  if (!doc) return;

  store.updateDoc(docId, { status: 'compiling', error: null });

  try {
    const chunks = store.loadContent(docId) || [];
    if (!chunks.length) throw new Error('文档内容为空');

    const rawTexts = chunks.map((c) => (typeof c === 'string' ? c : c.text));
    const { text: sourceText, batched } = await distill(rawTexts);

    const existing = readExisting(userId);
    const useFullExisting = existing.total <= MAX_EXISTING_CHARS;

    // 已有词条清单（标题 + 摘要），用于让模型判断该新建还是更新
    const catalog = existing.pages.length
      ? existing.pages.map((p) => `- ${p.title}（slug: ${p.slug}，${p.type || 'concept'}）${p.summary ? ' — ' + p.summary : ''}`).join('\n')
      : '（当前知识库为空）';

    const existingBlock = useFullExisting && existing.pages.length
      ? existing.pages.map((p) => `### 已有词条：${p.title}（slug: ${p.slug}）\n${p.raw}`).join('\n\n')
      : '（已有词条全文见上方的清单，请只依据清单判断哪些需要更新，不要臆造其内容）';

    const prompt = `【任务】把下面这份新资料编译进知识库。

【当前知识库词条清单】
${catalog}

【已有词条内容】
${existingBlock}

【新资料】文件名：${doc.name}
${sourceText}

【要求】
1. 先通读新资料，提炼出值得长期保存的知识点。
2. 对每个知识点，判断是「新建词条」还是「更新已有词条」：
   - 如果清单里已有语义相同的词条，请输出**合并后**的完整内容（保留原词条中仍然正确的内容，补充新资料带来的信息）
   - 否则新建
3. 最多输出 ${MAX_UPDATES + 4} 个词条，只保留最有价值的，不要为细枝末节建页。
4. 每个词条内容 200~700 字，用 Markdown，含 ## 定义 / ## 要点 / ## 关联 结构，关联用 [[词条名]]。
5. is_update 为 true 时，slug 必须使用清单里给出的 slug。

【输出格式】只输出 JSON，不要任何解释文字：
{
  "doc_summary": "这份资料的 150 字以内摘要",
  "pages": [
    {
      "type": "concept | entity | summary | synthesis",
      "title": "词条标题",
      "slug": "文件名（新建时由你给出简短英文或中文词条名，更新时必须用已有 slug）",
      "is_update": false,
      "summary": "一句话说明这个词条讲什么（不超过 40 字）",
      "content": "## 定义\\n...\\n\\n## 要点\\n- ...\\n\\n## 关联\\n[[其它词条]]"
    }
  ]
}`;

    let result;
    try {
      result = await chatJSON(
        [
          { role: 'system', content: SCHEMA },
          { role: 'user', content: prompt },
        ],
        { throttle: true, maxTokens: 8192, temperature: 0.3 }
      );
    } catch (e) {
      // JSON 解析失败时重试一次，强调格式
      console.error('[wiki] 首次解析失败，重试:', e.message);
      result = await chatJSON(
        [
          { role: 'system', content: SCHEMA },
          { role: 'user', content: prompt },
          { role: 'assistant', content: '（上次输出格式有误，请只输出合法 JSON）' },
        ],
        { throttle: true, maxTokens: 8192, temperature: 0.1 }
      );
    }

    const pages = Array.isArray(result?.pages) ? result.pages : [];
    if (!pages.length) throw new Error('模型未产出任何词条');

    // ===== 写入词条页面 =====
    const touched = [];
    for (const p of pages.slice(0, MAX_UPDATES + 4)) {
      const title = String(p.title || '').trim();
      if (!title) continue;

      let slug;
      if (p.is_update && p.slug) {
        slug = String(p.slug).replace(/[\\/:*?"<>|#\[\]()]/g, '');
      } else {
        slug = store.slugify(title);
      }
      if (!slug) continue;

      // 更新已有词条时，把旧的来源一并保留
      const oldRaw = p.is_update ? store.readPage(userId, slug) : null;
      const oldSources = oldRaw ? (oldRaw.match(/^sources:\s*(.+)$/m) || [])[1] || '' : '';
      const sourceSet = new Set(
        [oldSources, doc.name]
          .join(',')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      );

      store.writePage(
        userId,
        slug,
        buildPageFile({
          title,
          type: p.type || 'concept',
          content: String(p.content || ''),
          summary: String(p.summary || ''),
          sources: [...sourceSet],
        })
      );
      touched.push(slug);
    }

    // ===== 重新生成 index.md（查询时的导航入口）=====
    await rebuildIndex(userId);

    // ===== 记录日志 + 更新文档状态 =====
    store.appendLog(
      userId,
      `ingest | ${doc.name}${batched ? '（超长，已分批提炼）' : ''} → 更新 ${touched.length} 个词条`
    );
    store.updateDoc(docId, {
      status: 'done',
      error: null,
      pageSlugs: touched,
      compiledAt: new Date().toISOString(),
    });
    console.log(`[wiki] 编译完成 ${doc.name} → ${touched.length} 个词条`);
  } catch (e) {
    console.error('[wiki] 编译失败:', e.message);
    store.updateDoc(docId, { status: 'error', error: e.message.slice(0, 200) });
    store.appendLog(userId, `error | ${doc.name} 编译失败：${e.message.slice(0, 120)}`);
  }
}

/** 用 LLM 重新生成 index.md */
async function rebuildIndex(userId) {
  const slugs = store.listPages(userId);
  if (!slugs.length) return;

  const items = slugs
    .map((slug) => {
      const raw = store.readPage(userId, slug);
      if (!raw) return null;
      const title = ((raw.match(/^title:\s*(.+)$/m) || [])[1] || slug).trim();
      const type = ((raw.match(/^type:\s*(.+)$/m) || [])[1] || 'concept').trim();
      const summary = ((raw.match(/^summary:\s*(.+)$/m) || [])[1] || '').trim();
      const sources = ((raw.match(/^sources:\s*(.+)$/m) || [])[1] || '').trim();
      return { slug, title, type, summary, sources };
    })
    .filter(Boolean);

  const docs = store.listDocs(userId).filter((d) => d.status === 'done');

  const listText = items
    .map((i) => `- title: ${i.title} | type: ${i.type} | summary: ${i.summary} | sources: ${i.sources} | slug: ${i.slug}`)
    .join('\n');

  let md;
  try {
    md = await chat(
      [
        { role: 'system', content: SCHEMA },
        {
          role: 'user',
          content: `【任务】为知识库生成总目录 index.md。

【全部词条】
${listText}

【来源文档】${docs.map((d) => d.name).join('、') || '（无）'}

【要求】
1. 按 type 分组：概念 / 实体 / 来源摘要 / 综合分析。
2. 每个词条一行，格式：- [[标题]] — 一句话说明 · 来源 N 处
3. 顶部写一行统计：共 N 个词条，来自 M 份资料。
4. 只输出 Markdown 正文，不要代码围栏，不要额外解释。`,
        },
      ],
      { throttle: true, maxTokens: 4096, temperature: 0.2 }
    );
  } catch (e) {
    // 模型失败时退化为程序生成
    md =
      `# 知识库索引\n\n> 共 ${items.length} 个词条，来自 ${docs.length} 份资料。\n\n` +
      items.map((i) => `- [[${i.title}]] — ${i.summary || '（无摘要）'}`).join('\n');
  }

  const header = `<!-- 由 LLM Wiki 引擎自动生成，最后更新：${nowStamp()} -->\n\n`;
  store.writeWikiFile(userId, 'index.md', header + md.trim() + '\n');
}

// ===================== Query：检索 + 回答 =====================

/**
 * 语义定位：让模型读 index.md，判断需要读哪些词条
 * 返回 { slugs, debug }
 */
async function locate(userId, question) {
  const index = store.readWikiFile(userId, 'index.md') || '';
  const slugs = store.listPages(userId);

  if (!index || !slugs.length) return { slugs: [], debug: '知识库为空' };

  // 词条很少时直接全读，省一次调用
  if (slugs.length <= 3) return { slugs, debug: '词条较少，直接全读' };

  try {
    const picked = await chatJSON(
      [
        {
          role: 'system',
          content:
            '你是知识库导航员。根据用户问题，从目录中选出最可能包含答案的词条。只输出 JSON，不要解释。',
        },
        {
          role: 'user',
          content: `【知识库目录】
${index}

【可用 slug 列表】
${slugs.join(', ')}

【用户问题】
${question}

【任务】选出与问题最相关的词条，最多 6 个。若问题需要跨词条综合，请一并选出。
【输出格式】{"slugs": ["slug1", "slug2"]}`,
        },
      ],
      { maxTokens: 500, temperature: 0.1 }
    );
    const list = Array.isArray(picked?.slugs) ? picked.slugs : [];
    const valid = list.filter((s) => slugs.includes(s)).slice(0, 6);
    return { slugs: valid.length ? valid : slugs.slice(0, 4), debug: `语义定位命中 ${valid.length} 个词条` };
  } catch (e) {
    console.error('[wiki] 定位失败，回退到前几个词条:', e.message);
    return { slugs: slugs.slice(0, 4), debug: '定位失败，回退' };
  }
}

/**
 * 基于知识库回答问题（流式）
 * onMeta 会在开始回答前拿到 { slugs, titles, mode }
 */
export async function answerFromWiki(userId, question, onDelta, onMeta) {
  const { slugs, debug } = await locate(userId, question);

  const pages = [];
  let total = 0;
  for (const slug of slugs) {
    const raw = store.readPage(userId, slug);
    if (!raw) continue;
    if (total + raw.length > MAX_SINGLE_CHARS) break;
    total += raw.length;
    const title = ((raw.match(/^title:\s*(.+)$/m) || [])[1] || slug).trim();
    pages.push({ title, raw });
  }

  if (!pages.length) {
    // 知识库还没编译完 —— 降级：直接读原文回答
    return await answerFromRaw(userId, question, onDelta, onMeta, debug);
  }

  if (onMeta) onMeta({ mode: 'wiki', slugs, titles: pages.map((p) => p.title), debug });

  const context = pages.map((p, i) => `【词条 ${i + 1}：${p.title}】\n${p.raw}`).join('\n\n');

  const messages = [
    {
      role: 'system',
      content: `${SCHEMA}

【回答要求】
- 你是知识库问答助手，严格基于提供的【知识库词条】回答问题。
- 用简体中文，条理清晰，可以用列表。
- 若词条内容不足以回答，明确说「知识库中未找到相关内容」，不要编造。
- 引用具体词条时用 [[词条名]] 的形式标注。`,
    },
    { role: 'user', content: `【知识库词条】\n${context}\n\n【问题】\n${question}` },
  ];

  return await chatStream(messages, onDelta, { maxTokens: 2048, temperature: 0.4 });
}

/** 降级：知识库尚未编译完成时，直接用原文回答 */
async function answerFromRaw(userId, question, onDelta, onMeta, reason) {
  const docs = store.listDocs(userId);
  const usable = docs.filter((d) => d.status === 'done' || d.status === 'compiling' || d.status === 'pending');
  let budget = MAX_SINGLE_CHARS;
  const parts = [];

  for (const d of usable) {
    const chunks = store.loadContent(d.id) || [];
    const text = chunks.map((c) => (typeof c === 'string' ? c : c.text)).join('\n\n');
    if (!text) continue;
    const slice = text.slice(0, Math.max(2000, budget));
    if (!slice) break;
    parts.push(`【资料：${d.name}】\n${slice}`);
    budget -= slice.length;
    if (budget <= 2000) break;
  }

  if (!parts.length) {
    const hint = '知识库中还没有可用的资料，请先上传文档。';
    if (onMeta) onMeta({ mode: 'empty', titles: [], debug: reason });
    if (onDelta) onDelta(hint);
    return hint;
  }

  if (onMeta) {
    onMeta({
      mode: 'raw',
      titles: usable.slice(0, parts.length).map((d) => d.name),
      debug: '知识库正在编译中，本次直接读取原文回答',
    });
  }

  const messages = [
    {
      role: 'system',
      content: `你是知识库问答助手。严格基于用户提供的【资料】内容回答，用简体中文，条理清晰。若资料不足以回答，请明确说明「资料中未找到相关内容」，不要编造。`,
    },
    { role: 'user', content: `${parts.join('\n\n')}\n\n【问题】\n${question}` },
  ];

  return await chatStream(messages, onDelta, { maxTokens: 2048, temperature: 0.4 });
}

// ===================== Lint：知识库健康检查 =====================

export function lintWiki(userId) {
  const slugs = store.listPages(userId);
  const issues = { orphans: [], brokenLinks: [] };

  const linkMap = new Map();
  for (const slug of slugs) {
    const raw = store.readPage(userId, slug) || '';
    const links = [...raw.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim());
    linkMap.set(slug, links);
  }

  const titleToSlug = new Map();
  for (const slug of slugs) {
    const raw = store.readPage(userId, slug) || '';
    const title = ((raw.match(/^title:\s*(.+)$/m) || [])[1] || slug).trim();
    titleToSlug.set(title, slug);
  }

  const inbound = new Map(slugs.map((s) => [s, 0]));
  for (const [slug, links] of linkMap) {
    for (const l of links) {
      const target = titleToSlug.get(l);
      if (!target) {
        issues.brokenLinks.push({ from: slug, to: l });
      } else if (target !== slug) {
        inbound.set(target, (inbound.get(target) || 0) + 1);
      }
    }
  }

  for (const [slug, n] of inbound) {
    if (n === 0 && slugs.length > 1) issues.orphans.push(slug);
  }

  return {
    pageCount: slugs.length,
    issues,
    index: store.readWikiFile(userId, 'index.md') || '',
  };
}
