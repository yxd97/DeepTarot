/* DeepSeek 塔罗解牌 — client-side app (vanilla JS, no build step).
 *
 * Flow: pick spread -> enter question + drawn cards -> stream a reading.
 * BYOK: the API key lives only in `state.apiKey` (memory). The browser calls
 * DeepSeek directly (CORS-verified). No data is persisted.
 */

'use strict';

/* ============================================================
 * Draft system prompt (under user review — easy to edit here).
 * Stable text kept first in the message array for cache hits (guide §11).
 * ============================================================ */
const SYSTEM_PROMPT = `你是一位经验丰富、温暖而真诚的塔罗解读师，精通韦特体系塔罗牌。
用户会告诉你：所使用的牌阵、每个位置的含义、ta 的问题，以及每个位置抽到的牌（含正位/逆位），并附上每张牌的牌义参考资料。

请用简体中文，按以下结构给出解读：

1. **逐张解读**：按位置顺序，逐一解读每张牌。结合「该位置的含义」与「该牌（正位/逆位）的牌义」，说明这张牌在此处对当事人意味着什么。请优先依据用户提供的牌义参考资料，而非泛泛而谈。
2. **牌与牌之间的联系**：分析这些牌如何相互呼应、强化或冲突，串起一个连贯的故事或整体局势。
3. **针对问题的直接回答**：明确、诚实地回应用户的问题，给出你的判断与倾向，不要含糊其辞。
4. **建议**：给出 2–4 条具体、可操作、体贴的建议。

要求：
- 语气真诚、有同理心，但不回避真实情况；该提醒的风险要如实指出。
- 紧扣用户的问题与所抽到的牌，避免空泛的套话。
- 不要编造参考资料中没有的牌；只解读用户实际抽到的牌。
- 适当使用小标题与分点，便于阅读。
- 结尾可加一句简短的鼓励或提醒，并说明塔罗仅供参考、决定权在当事人自己。
- 因设备限制，不要输出表格，代码块，或者嵌套列表！`;

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

/* ============================================================
 * State
 * ============================================================ */
const state = {
  apiKey: '',
  spread: null,          // selected spread object
  question: '',
  selections: [],        // [{ n, label, card|null, reversed }]
};

let SPREADS = [];
let CARDS = [];
const CARD_LOOKUP = new Map();   // normalized key -> card
const CARD_BY_FILE = new Map();

/* ============================================================
 * DOM helpers
 * ============================================================ */
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style') node.setAttribute('style', v);
    else node.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
};
const stripTags = (html) => {
  if (!html) return '';
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.textContent.replace(/\s+\n/g, '\n').trim();
};

/* ============================================================
 * Minimal Markdown -> HTML renderer (self-contained, no deps)
 * Handles headings, bold/italic, inline code, links, lists,
 * blockquotes, horizontal rules and paragraphs. All input is
 * HTML-escaped first, so it is safe for untrusted LLM output.
 * ============================================================ */
const escapeHtml = (s) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

function renderInline(s) {
  // s is already HTML-escaped. Apply inline markdown.
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      (_, t, h) => `<a href="${h}" target="_blank" rel="noopener">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
}

function renderMarkdown(md) {
  const lines = escapeHtml(md).split('\n');
  let html = '';
  let listType = null; // 'ul' | 'ol'
  let inQuote = false;

  const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
  const closeQuote = () => { if (inQuote) { html += '</blockquote>'; inQuote = false; } };

  for (let raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (!line.trim()) { closeList(); closeQuote(); continue; }

    // Horizontal rule
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
      closeList(); closeQuote(); html += '<hr>'; continue;
    }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList(); closeQuote();
      const lvl = h[1].length;
      html += `<h${lvl}>${renderInline(h[2])}</h${lvl}>`;
      continue;
    }

    // Blockquote ('>' is already escaped to '&gt;' at this point)
    const q = line.match(/^&gt;\s?(.*)$/);
    if (q) {
      closeList();
      if (!inQuote) { html += '<blockquote>'; inQuote = true; }
      html += `<p>${renderInline(q[1])}</p>`;
      continue;
    }
    closeQuote();

    // Ordered list item
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
      html += `<li>${renderInline(ol[1])}</li>`;
      continue;
    }

    // Unordered list item
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
      html += `<li>${renderInline(ul[1])}</li>`;
      continue;
    }

    // Paragraph
    closeList();
    html += `<p>${renderInline(line)}</p>`;
  }

  closeList();
  closeQuote();
  return html;
}

function showStep(which) {
  ['step-pick', 'step-input', 'step-result'].forEach((id) => {
    $(id).classList.toggle('active', id === which);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ============================================================
 * Data loading
 * ============================================================ */
async function loadData() {
  const [s, c] = await Promise.all([
    fetch('data/spreads.json').then((r) => r.json()),
    fetch('data/cards.json').then((r) => r.json()),
  ]);
  SPREADS = s.spreads;
  CARDS = c.cards;
  const norm = (x) => String(x).trim().toLowerCase();
  CARDS.forEach((card) => {
    const display = `${card.zh} · ${card.en}`;
    card._display = display;
    CARD_LOOKUP.set(norm(display), card);
    CARD_LOOKUP.set(norm(card.zh), card);
    CARD_LOOKUP.set(norm(card.en), card);
    // also index the part before "/" for names like 权杖一/权杖首牌
    if (card.zh.includes('/')) CARD_LOOKUP.set(norm(card.zh.split('/')[0]), card);
    CARD_BY_FILE.set(card.file, card);
  });
}

function resolveCard(value) {
  return CARD_LOOKUP.get(String(value).trim().toLowerCase()) || null;
}

/* ============================================================
 * Step 1 — spread picker
 * ============================================================ */
function renderSpreadGrid() {
  const grid = $('spread-grid');
  grid.innerHTML = '';
  SPREADS.forEach((sp) => {
    const cardEl = el('div', { class: 'spread-card', 'data-slug': sp.slug }, [
      el('div', { class: 'zh', text: sp.name_zh }),
      el('div', { class: 'en', text: sp.name_en }),
      el('div', { class: 'cnt', text: `${sp.count} 张牌` }),
    ]);
    cardEl.addEventListener('click', () => selectSpread(sp));
    grid.appendChild(cardEl);
  });
}

function selectSpread(sp) {
  state.spread = sp;
  state.selections = sp.positions
    .slice()
    .sort((a, b) => a.n - b.n)
    .map((p) => ({ n: p.n, label: p.label, card: null, reversed: false }));
  buildInputStep();
  showStep('step-input');
}

/* ============================================================
 * Step 2 — layout + inputs
 * ============================================================ */
function buildInputStep() {
  const sp = state.spread;
  $('input-title').textContent = `第二步 · ${sp.name_zh}（输入抽到的牌）`;
  renderLayout(sp);

  // notes
  const notesWrap = $('input-notes');
  notesWrap.innerHTML = '';
  if (sp.notes_html) {
    notesWrap.appendChild(el('div', { class: 'spread-notes', html: sp.notes_html }));
  }

  // datalist of all cards
  const dl = $('cards-datalist');
  dl.innerHTML = '';
  CARDS.forEach((c) => dl.appendChild(el('option', { value: c._display })));

  // restore question
  $('question').value = state.question || '';

  // position rows
  const list = $('pos-list');
  list.innerHTML = '';
  state.selections.forEach((sel, idx) => {
    const input = el('input', {
      class: 'card-input',
      list: 'cards-datalist',
      placeholder: '搜索并选择一张牌…',
      autocomplete: 'off',
      'data-idx': idx,
    });
    if (sel.card) input.value = sel.card._display;
    input.addEventListener('input', () => onCardInput(idx, input));

    const orient = el('div', { class: 'orient' }, [
      el('button', { type: 'button', 'data-rev': '0', class: sel.reversed ? '' : 'on', text: '正位' }),
      el('button', { type: 'button', 'data-rev': '1', class: sel.reversed ? 'on' : '', text: '逆位' }),
    ]);
    orient.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        sel.reversed = b.dataset.rev === '1';
        orient.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      });
    });

    const labelText = sel.label ? `位置 ${sel.n} · ${sel.label}` : `位置 ${sel.n}`;
    const row = el('div', { class: 'pos-row', id: `pos-row-${idx}` }, [
      el('div', { class: 'pos-num', text: String(sel.n) }),
      el('div', { class: 'pos-meta' }, [
        el('div', { class: 'pos-label', text: labelText }),
        input,
      ]),
      orient,
    ]);
    list.appendChild(row);
  });

  $('input-error').innerHTML = '';
}

function onCardInput(idx, input) {
  const card = resolveCard(input.value);
  state.selections[idx].card = card;
  input.classList.toggle('invalid', input.value.trim() !== '' && !card);
  // reflect filled state on the layout card
  const layoutCard = document.querySelector(`.spread-canvas .card[data-n="${state.selections[idx].n}"]`);
  if (layoutCard) layoutCard.classList.toggle('filled', !!card);
}

function renderLayout(sp) {
  const scaler = $('canvas-scaler');
  scaler.innerHTML = '';
  const HPAD = 150;
  const VPAD = 36;
  scaler.style.padding = `${VPAD}px ${HPAD}px`;

  const canvas = el('div', { class: 'spread-canvas' });
  canvas.style.width = `${sp.canvas.w}px`;
  canvas.style.height = `${sp.canvas.h}px`;

  if (sp.svg) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'spread-lines');
    svg.setAttribute('viewBox', sp.viewBox || `${-sp.canvas.w / 2} ${-sp.canvas.h / 2} ${sp.canvas.w} ${sp.canvas.h}`);
    svg.innerHTML = sp.svg;
    canvas.appendChild(svg);
  }

  sp.positions.forEach((p) => {
    const card = el('div', {
      class: 'card',
      'data-n': String(p.n),
      style: `--dx:${p.dx}px; --dy:${p.dy}px;`,
      text: String(p.n),
    });
    if (p.label) card.appendChild(el('span', { class: `label label--${p.dir || 'top'}`, text: p.label }));
    card.addEventListener('click', () => {
      const row = $(`pos-row-${state.selections.findIndex((s) => s.n === p.n)}`);
      if (row) {
        const inp = row.querySelector('.card-input');
        inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
        inp.focus();
      }
    });
    canvas.appendChild(card);
  });

  scaler.appendChild(canvas);
  scaleCanvas();
}

function scaleCanvas() {
  const viewport = document.querySelector('.canvas-viewport');
  const scaler = $('canvas-scaler');
  if (!viewport || !scaler.firstChild) return;
  scaler.style.transform = 'scale(1)';
  const naturalW = scaler.offsetWidth;
  const naturalH = scaler.offsetHeight;
  const avail = viewport.clientWidth;
  const scale = Math.min(1, avail / naturalW);
  scaler.style.transform = `scale(${scale})`;
  viewport.style.height = `${naturalH * scale}px`;
}
window.addEventListener('resize', scaleCanvas);

function validateInput() {
  state.question = $('question').value.trim();
  const errs = [];
  if (!state.question) errs.push('请填写你的问题。');
  const missing = state.selections.filter((s) => !s.card).map((s) => s.n);
  if (missing.length) errs.push(`还有位置未选择有效的牌：${missing.join('、')}。`);
  if (!state.apiKey) errs.push('请在页面顶部填写 DeepSeek API Key。');
  const box = $('input-error');
  box.innerHTML = '';
  if (errs.length) {
    box.appendChild(el('div', { class: 'status-msg error', text: errs.join(' ') }));
    return false;
  }
  return true;
}

/* ============================================================
 * Step 3 — prompt building + streaming
 * ============================================================ */
async function buildMessages() {
  const sp = state.spread;
  const sels = state.selections;

  // Fetch each drawn card's meaning file (dedupe by file).
  const files = [...new Set(sels.map((s) => s.card.file))];
  const textByFile = {};
  await Promise.all(
    files.map((f) =>
      fetch(`cards/${f}`)
        .then((r) => (r.ok ? r.text() : ''))
        .then((t) => { textByFile[f] = t; })
    )
  );

  const ori = (rev) => (rev ? '逆位' : '正位');
  const notesText = stripTags(sp.notes_html);

  let user = `牌阵：${sp.name_zh} · ${sp.name_en}（共 ${sp.count} 张）\n`;
  if (notesText) user += `牌阵位置说明：\n${notesText}\n`;
  user += `\n问题：${state.question}\n\n抽到的牌：\n`;
  sels.forEach((s) => {
    const pos = s.label ? `位置${s.n} · ${s.label}` : `位置${s.n}`;
    user += `- ${pos}：${s.card.zh}（${s.card.en}）— ${ori(s.reversed)}\n`;
  });

  user += `\n【每张牌的牌义参考资料】\n`;
  sels.forEach((s) => {
    const pos = s.label ? `位置${s.n} · ${s.label}` : `位置${s.n}`;
    user += `\n========== ${pos}：${s.card.zh}（${ori(s.reversed)}）==========\n`;
    user += `${textByFile[s.card.file] || '(无参考资料)'}\n`;
  });

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

function errorMessageForStatus(status, bodyText) {
  switch (status) {
    case 401: return '密钥无效（401）。请检查你的 DeepSeek API Key 是否正确。';
    case 402: return '账户余额不足（402）。请前往 DeepSeek 充值后再试。';
    case 422: return '请求参数有误（422）。' + (bodyText ? ` ${bodyText}` : '');
    case 429: return '请求过于频繁（429），正在重试…';
    case 500: return '服务器错误（500），正在重试…';
    case 503: return '服务器繁忙（503），正在重试…';
    default:  return `请求失败（${status}）。` + (bodyText ? ` ${bodyText}` : '');
  }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function connectWithRetry(messages) {
  const body = JSON.stringify({
    model: 'deepseek-v4-flash',
    messages,
    stream: true,
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
    max_tokens: 8192,
  });
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let resp;
    try {
      resp = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.apiKey}` },
        body,
      });
    } catch (e) {
      // network / CORS failure
      if (attempt < maxAttempts - 1) { await sleep(800 * 2 ** attempt); continue; }
      throw new Error('网络连接失败，无法连接 DeepSeek。请检查网络后重试。');
    }
    if (resp.ok) return resp;

    const transient = resp.status === 429 || resp.status === 500 || resp.status === 503;
    let bodyText = '';
    try { const j = await resp.json(); bodyText = j.error?.message || ''; } catch (_) {}
    if (transient && attempt < maxAttempts - 1) {
      setStatus(errorMessageForStatus(resp.status, ''), 'info');
      await sleep(800 * 2 ** attempt + Math.random() * 400);
      continue;
    }
    throw new Error(errorMessageForStatus(resp.status, bodyText));
  }
  throw new Error('多次重试后仍然失败，请稍后再试。');
}

function setStatus(msg, kind) {
  const box = $('result-status');
  box.innerHTML = '';
  if (msg) box.appendChild(el('div', { class: `status-msg ${kind || 'info'}`, text: msg }));
}

async function runReading() {
  showStep('step-result');
  $('thinking-box').style.display = 'none';
  $('thinking-content').textContent = '';
  $('answer-content').textContent = '';
  setStatus('正在连接 DeepSeek，准备解读', 'info');
  $('result-status').querySelector('.status-msg')?.classList.add('spinner-dots');

  let messages;
  try {
    messages = await buildMessages();
  } catch (e) {
    setStatus('读取牌义资料失败：' + e.message, 'error');
    return;
  }

  let resp;
  try {
    resp = await connectWithRetry(messages);
  } catch (e) {
    setStatus(e.message, 'error');
    return;
  }

  setStatus('正在解读，请稍候', 'info');
  $('result-status').querySelector('.status-msg')?.classList.add('spinner-dots');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finish = null;
  let gotThinking = false;
  let gotAnswer = false;
  let answerRaw = '';

  const onThink = (t) => {
    if (!gotThinking) { $('thinking-box').style.display = 'block'; gotThinking = true; }
    $('thinking-content').textContent += t;
    $('thinking-content').scrollTop = $('thinking-content').scrollHeight;
  };
  const onAnswer = (t) => {
    if (!gotAnswer) { setStatus('', null); gotAnswer = true; }
    answerRaw += t;
    $('answer-content').innerHTML = renderMarkdown(answerRaw);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { buf = ''; break; }
        let chunk;
        try { chunk = JSON.parse(payload); } catch (_) { continue; }
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        const d = choice.delta || {};
        if (d.reasoning_content) onThink(d.reasoning_content);
        if (d.content) onAnswer(d.content);
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }
  } catch (e) {
    setStatus('解读过程中连接中断：' + e.message + '（已显示的部分见下方）', 'error');
    return;
  }

  if (!gotAnswer) {
    setStatus('未能获取解读内容，请重试。', 'error');
  } else if (finish === 'length') {
    setStatus('解读因长度上限被截断，内容可能不完整。可重试或缩短输入。', 'info');
  } else {
    setStatus('', null);
  }
}

/* ============================================================
 * Wiring
 * ============================================================ */
function wire() {
  $('api-key').addEventListener('input', (e) => { state.apiKey = e.target.value.trim(); });
  $('question').addEventListener('input', (e) => { state.question = e.target.value; });

  $('back-to-pick').addEventListener('click', () => showStep('step-pick'));
  $('go-read').addEventListener('click', () => { if (validateInput()) runReading(); });
  $('back-to-input').addEventListener('click', () => showStep('step-input'));
  $('new-reading').addEventListener('click', () => {
    // keep apiKey; reset the rest
    state.spread = null;
    state.question = '';
    state.selections = [];
    $('question').value = '';
    showStep('step-pick');
  });
}

(async function init() {
  wire();
  try {
    await loadData();
    renderSpreadGrid();
  } catch (e) {
    $('spread-grid').appendChild(
      el('div', { class: 'status-msg error', text: '加载数据失败：' + e.message + '（若在本地打开，请用本地服务器访问，例如 python3 -m http.server）' })
    );
  }
})();
