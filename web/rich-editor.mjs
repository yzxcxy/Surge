const markerPattern = /^!?\[([^\]]*)\]\(surge-blob:([a-f0-9-]{36})\)$/;
const inlinePattern = /(!?\[[^\]]*\]\(surge-blob:[a-f0-9-]{36}\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]]+\]\(https?:\/\/[^)]+\))/g;
const blockStart = line => /^\s*(?:#{1,6}\s|[-*]\s|\d+\.\s|>\s|```|~~~)/.test(line) || /^\|/.test(line) || markerPattern.test(line.trim());

function appendTextWithBreaks(parent, text) {
  text.split('\n').forEach((part, index) => {
    if (index) parent.append(document.createElement('br'));
    if (part) parent.append(document.createTextNode(part));
  });
}

export function attachmentNode(marker) {
  const match = markerPattern.exec(marker.trim());
  const figure = document.createElement('figure');
  figure.className = 'rich-attachment';
  figure.contentEditable = 'false';
  figure.dataset.marker = marker.trim();
  figure.dataset.blobId = match?.[2] || '';
  const label = document.createElement('span');
  label.textContent = marker.startsWith('!') ? '' : (match?.[1] || '附件');
  if (marker.startsWith('!')) label.hidden = true;
  figure.append(label);
  return figure;
}

function appendInline(parent, source) {
  let start = 0;
  for (const match of source.matchAll(inlinePattern)) {
    appendTextWithBreaks(parent, source.slice(start, match.index));
    const token = match[0];
    if (markerPattern.test(token)) {
      parent.append(attachmentNode(token));
    } else if (token.startsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else if (token.startsWith('*')) {
      const emphasis = document.createElement('em');
      emphasis.textContent = token.slice(1, -1);
      parent.append(emphasis);
    } else if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(token);
      if (link) {
        const anchor = document.createElement('a');
        anchor.textContent = link[1];
        anchor.href = link[2];
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        parent.append(anchor);
      } else appendTextWithBreaks(parent, token);
    }
    start = match.index + token.length;
  }
  appendTextWithBreaks(parent, source.slice(start));
}

export function renderInlineMarkdown(source, root) {
  root.replaceChildren();
  appendInline(root, source);
}

export function tableNode(rows = [['项目', '内容'], ['', '']]) {
  const table = document.createElement('table');
  table.className = 'rich-table';
  const thead = document.createElement('thead');
  const header = document.createElement('tr');
  for (const value of rows[0] || []) {
    const cell = document.createElement('th');
    appendInline(cell, value);
    header.append(cell);
  }
  thead.append(header);
  table.append(thead);
  const tbody = document.createElement('tbody');
  for (const row of rows.slice(1)) {
    const tr = document.createElement('tr');
    for (const value of row) {
      const cell = document.createElement('td');
      appendInline(cell, value);
      tr.append(cell);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

const tableCells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());

export function renderMarkdown(source, root) {
  root.replaceChildren();
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (markerPattern.test(line.trim())) { root.append(attachmentNode(line)); i++; continue; }
    const fence = /^(\s*)(```|~~~)(.*)$/.exec(line);
    if (fence) {
      const sourceLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[2])) sourceLines.push(lines[i++]);
      if (i < lines.length) i++;
      const pre = document.createElement('pre');
      pre.dataset.fence = fence[2];
      pre.dataset.info = fence[3];
      const code = document.createElement('code');
      code.textContent = sourceLines.join('\n');
      pre.append(code);
      root.append(pre);
      continue;
    }
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const rows = [tableCells(line)];
      i += 2;
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(tableCells(lines[i++]));
      root.append(tableNode(rows));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const node = document.createElement('h' + heading[1].length);
      appendInline(node, heading[2]);
      root.append(node);
      i++;
      continue;
    }
    if (/^\s*(?:[-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      if (ordered) list.start = Number(/^\s*(\d+)\./.exec(line)[1]);
      while (i < lines.length && (ordered ? /^\s*\d+\.\s/.test(lines[i]) : /^\s*[-*]\s/.test(lines[i]))) {
        const value = lines[i++].replace(ordered ? /^\s*\d+\.\s/ : /^\s*[-*]\s/, '');
        const li = document.createElement('li');
        const task = /^\[([ xX])\]\s*(.*)$/.exec(value);
        if (task) {
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = task[1].toLowerCase() === 'x';
          checkbox.contentEditable = 'false';
          li.append(checkbox, document.createTextNode(' '));
          appendInline(li, task[2]);
        } else appendInline(li, value);
        list.append(li);
      }
      root.append(list);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = document.createElement('blockquote');
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        if (quote.childNodes.length) quote.append(document.createElement('br'));
        appendInline(quote, lines[i++].replace(/^>\s?/, ''));
      }
      root.append(quote);
      continue;
    }
    const paragraph = document.createElement('p');
    const text = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !blockStart(lines[i])) text.push(lines[i++]);
    appendInline(paragraph, text.join('\n'));
    root.append(paragraph);
  }
  if (!root.childNodes.length || root.lastElementChild?.matches('.rich-attachment')) root.append(document.createElement('p'));
}

function inlineMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = node.tagName.toLowerCase();
  if (tag === 'br') return '\n';
  if (node.dataset?.marker) return node.dataset.marker;
  if (tag === 'input' && node.type === 'checkbox') return '';
  const value = [...node.childNodes].map(inlineMarkdown).join('');
  if (tag === 'b' || tag === 'strong') return '**' + value + '**';
  if (tag === 'i' || tag === 'em') return '*' + value + '*';
  if (tag === 'code') return '`' + value + '`';
  if (tag === 'a' && /^https?:\/\//.test(node.href)) return `[${value}](${node.href})`;
  return value;
}

function serializeBlock(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = node.tagName.toLowerCase();
  if (node.dataset?.marker) return node.dataset.marker;
  if (tag === 'pre') return `${node.dataset.fence || '```'}${node.dataset.info || ''}\n${node.textContent || ''}\n${node.dataset.fence || '```'}`;
  if (tag === 'ul' || tag === 'ol') return [...node.children].map((li, index) => {
    const checkbox = li.querySelector(':scope > input[type="checkbox"]');
    const text = [...li.childNodes].filter(child => child !== checkbox).map(inlineMarkdown).join('').trimStart();
    return (tag === 'ol' ? `${(node.start || 1) + index}. ` : '- ') + (checkbox ? `[${checkbox.checked ? 'x' : ' '}] ` : '') + text;
  }).join('\n');
  if (tag === 'table') {
    const rows = [...node.rows].map(row => [...row.cells].map(cell => inlineMarkdown(cell).replace(/\|/g, '\\|')));
    if (!rows.length) return '';
    const rowText = row => '| ' + row.join(' | ') + ' |';
    return [rowText(rows[0]), rowText(rows[0].map(() => '---')), ...rows.slice(1).map(rowText)].join('\n');
  }
  if (/^h[1-6]$/.test(tag)) return '#'.repeat(Number(tag[1])) + ' ' + inlineMarkdown(node);
  if (tag === 'blockquote') return inlineMarkdown(node).split('\n').map(line => '> ' + line).join('\n');
  return inlineMarkdown(node);
}

export function serializeMarkdown(root) {
  return [...root.childNodes].map(serializeBlock).filter(value => value !== '').join('\n\n').replace(/\n{3,}/g, '\n\n');
}
