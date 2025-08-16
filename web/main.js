const API = {
  listDocs: async () => fetch('/api/documents').then(r => r.json()),
  getDocHtml: async (id) => fetch(`/api/document/${encodeURIComponent(id)}`).then(r => r.text()),
  upload: async (file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    return res.json();
  },
  uploadPdf: async (file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/upload-pdf', { method: 'POST', body: form });
    return res.json();
  },
  listNodes: async (docId) => fetch(`/api/nodes/${encodeURIComponent(docId)}`).then(r => r.json()),
  saveNode: async (docId, node) => fetch(`/api/nodes/${encodeURIComponent(docId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(node)
  }).then(r => r.json()),
  deleteNode: async (docId, nodeId) => fetch(`/api/nodes/${encodeURIComponent(docId)}/${encodeURIComponent(nodeId)}`, { method: 'DELETE' }).then(r => r.json()),
  chat: async (payload) => fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(r => r.json())
};

const state = {
  zoom: 1,
  panX: 0,
  panY: 0,
  documentId: null,
  nodes: [],
  elementIdCounter: 0,
};

const els = {
  select: document.getElementById('documentSelect'),
  upload: document.getElementById('uploadInput'),
  uploadPdf: document.getElementById('uploadPdfInput'),
  toggleSidebar: document.getElementById('toggleSidebar'),
  sidebar: document.getElementById('sidebar'),
  sidebarContent: document.getElementById('sidebarContent'),
  sidebarResizer: document.getElementById('sidebarResizer'),
  collapseSidebarBtn: document.getElementById('collapseSidebarBtn'),
  zoomValue: document.getElementById('zoomValue'),
  canvasWrapper: document.getElementById('canvasWrapper'),
  canvas: document.getElementById('canvas'),
  contentFrame: document.getElementById('contentFrame'),
  docHtml: document.getElementById('docHtml'),
  wires: document.getElementById('wires'),
  microChatTemplate: document.getElementById('microChatTemplate'),
  nodeTemplate: document.getElementById('nodeTemplate'),
};

function setTransform() {
  els.canvas.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  els.zoomValue.textContent = `${Math.round(state.zoom * 100)}%`;
}

function initPanZoom() {
  let isPanning = false;
  let last = { x: 0, y: 0 };
  els.canvasWrapper.addEventListener('mousedown', (e) => {
    if (e.target.closest('.micro-chat') || e.target.closest('.node') || e.target === els.sidebarResizer) return;
    isPanning = true; last = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    const dx = e.clientX - last.x; const dy = e.clientY - last.y; last = { x: e.clientX, y: e.clientY };
    state.panX += dx; state.panY += dy; setTransform();
    redrawWires();
  });
  window.addEventListener('mouseup', () => { isPanning = false; });
  els.canvasWrapper.addEventListener('wheel', (e) => {
    e.preventDefault();
    const scale = Math.exp(-e.deltaY * 0.001);
    const rect = els.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left; const cy = e.clientY - rect.top;
    const wx = (cx - state.panX) / state.zoom; const wy = (cy - state.panY) / state.zoom;
    state.zoom *= scale;
    state.panX = cx - wx * state.zoom; state.panY = cy - wy * state.zoom;
    setTransform(); redrawWires();
  }, { passive: false });
}

function annotateAtoms() {
  const selector = 'p, img, table, thead, tbody, tr, pre, h1, h2, h3, h4, h5, h6, li, blockquote, code, figure, figcaption, math, svg';
  const nodes = els.docHtml.querySelectorAll(selector);
  nodes.forEach((n) => {
    n.classList.add('atom');
    const id = `atom-${++state.elementIdCounter}`;
    n.dataset.atomId = id;
    n.dataset.originalHtml = n.outerHTML;
    const ask = document.createElement('div');
    ask.className = 'ask';
    ask.textContent = '?';
    n.appendChild(ask);
    n.addEventListener('mouseenter', () => n.classList.add('hover'));
    n.addEventListener('mouseleave', () => n.classList.remove('hover'));
    ask.addEventListener('click', (e) => {
      e.stopPropagation();
      openMicroChat(n);
    });
  });
}

function toggleNodeConversation(node) {
  const existingChat = document.querySelector(`.micro-chat[data-node-id-ref='${node.node_id}']`);
  if (existingChat) {
    existingChat.remove();
  } else {
    openNodeConversation(node);
  }
}

function openMicroChat(atomEl) {
  closeAllMicroChats();
  const tpl = els.microChatTemplate.content.cloneNode(true);
  const box = tpl.querySelector('.micro-chat');
  const rect = atomEl.getBoundingClientRect();
  const parentRect = els.canvas.getBoundingClientRect();
  const contentFrameRect = els.contentFrame.getBoundingClientRect();
  const offsetX = contentFrameRect.right - parentRect.left;
  const offsetY = rect.top - parentRect.top;
  const left = offsetX / state.zoom + 24;
  const top = offsetY / state.zoom;
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  els.canvas.appendChild(box);
  const input = box.querySelector('input');
  const sendBtn = box.querySelector('.send');
  const messagesEl = box.querySelector('.messages');
  const saveBtn = box.querySelector('.save');
  const expandBtn = box.querySelector('.expand');
  const discardBtn = box.querySelector('.discard');
  let conversation = [];

  async function send() {
    const text = input.value.trim(); if (!text) return;
    input.value = '';
    conversation.push({ role: 'user', text, timestamp: Date.now() });
    await renderMessages(messagesEl, conversation);
    const payload = {
      document_id: state.documentId,
      source_element_id: atomEl.dataset.atomId,
      messages: conversation,
      source_element_html: atomEl.dataset.originalHtml,
    };
    try {
      const res = await API.chat(payload);
      conversation.push({ role: res.role || 'assistant', text: res.text, timestamp: res.timestamp || Date.now() });
      await renderMessages(messagesEl, conversation);
    } catch (err) {
      conversation.push({ role: 'assistant', text: '聊天服务不可用。', timestamp: Date.now() });
      await renderMessages(messagesEl, conversation);
    }
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  saveBtn.addEventListener('click', async () => {
    const node = await saveConversationAsNode(atomEl, conversation);
    box.remove();
    addNodeToCanvas(node);
  });
  expandBtn.addEventListener('click', () => {
    els.sidebar.classList.remove('hidden');
    els.sidebarResizer.classList.remove('hidden');
    appendChatToSidebar(atomEl, conversation);
  });
  discardBtn.addEventListener('click', () => { box.remove(); });
}

function closeAllMicroChats() {
  document.querySelectorAll('.micro-chat').forEach(e => e.remove());
}

async function renderMessages(container, messages) {
  container.innerHTML = '';
  for (const m of messages) {
    const div = document.createElement('div');
    div.className = `m ${m.role}`;
    if (m.role === 'assistant' && window.marked) {
      div.innerHTML = marked.parse(m.text, { breaks: true }); // Using breaks option for better line breaks
    } else {
      div.textContent = m.text;
    }
    container.appendChild(div);
  }
  
  if (window.MathJax && window.MathJax.typesetPromise) {
    try {
      await window.MathJax.typesetPromise([container]);
    } catch (err) {
      console.error("MathJax typesetting error:", err);
    }
  }
  
  container.scrollTop = container.scrollHeight;
}

async function saveConversationAsNode(atomEl, conversation) {
  const node = {
    node_id: crypto.randomUUID(),
    document_id: state.documentId,
    source_element_id: atomEl.dataset.atomId,
    canvas_position: {
      x: (atomEl.getBoundingClientRect().left - els.canvas.getBoundingClientRect().left) / state.zoom,
      y: (atomEl.getBoundingClientRect().top - els.canvas.getBoundingClientRect().top) / state.zoom,
    },
    conversation_log: conversation,
    user_annotations: null
  };
  try {
    await API.saveNode(state.documentId, node);
  } catch (e) {
    const key = `nbweb:${state.documentId}:nodes`;
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    list.push(node); localStorage.setItem(key, JSON.stringify(list));
  }
  state.nodes.push(node);
  redrawWires();
  return node;
}

function addNodeToCanvas(node) {
  const tpl = els.nodeTemplate.content.cloneNode(true);
  const el = tpl.querySelector('.node');
  el.style.left = `${node.canvas_position.x}px`;
  el.style.top = `${node.canvas_position.y}px`;
  el.dataset.nodeId = node.node_id;
  el.dataset.sourceId = node.source_element_id;
  el.title = '点击展开/收缩对话';
  el.addEventListener('click', () => toggleNodeConversation(node));
  enableNodeDrag(el, node);
  els.canvas.appendChild(el);
  redrawWires();
}

function enableNodeDrag(el, node) {
  let dragging = false; let start = { x: 0, y: 0 };
  el.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    dragging = true; 
    start = { x: e.clientX, y: e.clientY };
    el.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = (e.clientX - start.x) / state.zoom; 
    const dy = (e.clientY - start.y) / state.zoom;
    const newX = parseFloat(el.style.left) + dx;
    const newY = parseFloat(el.style.top) + dy;
    el.style.left = `${newX}px`; 
    el.style.top = `${newY}px`;
    node.canvas_position.x = newX; 
    node.canvas_position.y = newY; 
    start = { x: e.clientX, y: e.clientY };
    redrawWires();
  });
  window.addEventListener('mouseup', async () => {
    if (!dragging) return; 
    dragging = false; 
    el.style.cursor = 'grab';
    try { await API.saveNode(state.documentId, node); } catch {}
  });
}


function redrawWires() {
  els.wires.innerHTML = '';
  els.wires.setAttribute('width', els.canvas.scrollWidth);
  els.wires.setAttribute('height', els.canvas.scrollHeight);
  
  state.nodes.forEach(node => {
    const nodeEl = document.querySelector(`.node[data-node-id="${node.node_id}"]`);
    const srcEl = els.docHtml.querySelector(`[data-atom-id="${node.source_element_id}"]`);
    
    if (!nodeEl || !srcEl) return;
    
    const nodeRect = nodeEl.getBoundingClientRect();
    const srcRect = srcEl.getBoundingClientRect();
    const canvasRect = els.canvas.getBoundingClientRect();
    
    const x1 = (nodeRect.left + nodeRect.width / 2 - canvasRect.left) / state.zoom;
    const y1 = (nodeRect.top + nodeRect.height / 2 - canvasRect.top) / state.zoom;
    const x2 = (srcRect.left - canvasRect.left) / state.zoom;
    const y2 = (srcRect.top + srcRect.height / 2 - canvasRect.top) / state.zoom;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const d = `M ${x1},${y1} C ${x1 - 50},${y1} ${x2 - 150},${y2} ${x2},${y2}`;
    path.setAttribute('d', d);
    path.setAttribute('class', 'wire');
    els.wires.appendChild(path);
  });
}

function openNodeConversation(node) {
  closeAllMicroChats();
  const tpl = els.microChatTemplate.content.cloneNode(true);
  const box = tpl.querySelector('.micro-chat');
  const nodeEl = document.querySelector(`.node[data-node-id="${node.node_id}"]`);
  if (!nodeEl) return;
  box.dataset.nodeIdRef = node.node_id;

  const chatBoxWidth = 320;
  const gap = 16;
  const left = parseFloat(nodeEl.style.left) - chatBoxWidth - gap;
  const top = parseFloat(nodeEl.style.top);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;

  const messagesEl = box.querySelector('.messages');
  renderMessages(messagesEl, node.conversation_log || []);

  box.querySelector('.save').addEventListener('click', () => box.remove());
  box.querySelector('.expand').addEventListener('click', () => {
    els.sidebar.classList.remove('hidden');
    els.sidebarResizer.classList.remove('hidden');
    appendChatToSidebar({ dataset: { atomId: node.source_element_id } }, node.conversation_log || []);
    box.remove();
  });
  box.querySelector('.discard').addEventListener('click', async () => {
    if (confirm('确定要删除这个知识节点吗？')) {
      try {
        await API.deleteNode(state.documentId, node.node_id);
        state.nodes = state.nodes.filter(n => n.node_id !== node.node_id);
        nodeEl.remove();
        box.remove();
        redrawWires();
      } catch {}
    }
  });

  els.canvas.appendChild(box);
}

async function appendChatToSidebar(atomEl, conversation) {
  els.sidebarContent.innerHTML = '';
  const tpl = els.microChatTemplate.content.cloneNode(true);
  const mc = tpl.querySelector('.micro-chat');
  mc.classList.add('sidebar');

  // 【修改】先将空的聊天框添加到DOM，然后再填充内容
  els.sidebarContent.appendChild(mc);

  const messagesEl = mc.querySelector('.messages');
  // 现在，当renderMessages被调用时，messagesEl已经是DOM的一部分
  await renderMessages(messagesEl, conversation); 
  
  const saveBtn = mc.querySelector('.save');
  const discardBtn = mc.querySelector('.discard');

  saveBtn.textContent = '关闭';
  saveBtn.addEventListener('click', () => {
    els.sidebar.classList.add('hidden');
    els.sidebarResizer.classList.add('hidden');
  });

  discardBtn.textContent = '清空';
  discardBtn.addEventListener('click', () => {
    els.sidebarContent.innerHTML = '';
  });
  
  els.sidebar.classList.remove('hidden');
  els.sidebarResizer.classList.remove('hidden');
}


async function loadDocument(id) {
  state.documentId = id;
  const html = await API.getDocHtml(id).catch(() => '<p style="color:#a00">无法加载文档</p>');
  els.docHtml.innerHTML = html;
  annotateAtoms();
  if (window.MathJax && window.MathJax.typesetPromise) {
    try { await window.MathJax.typesetPromise([els.docHtml]); } catch {}
  }
  await loadNodes(id);
}

async function loadNodes(id) {
  let nodes = [];
  try { nodes = await API.listNodes(id); }
  catch {
    const key = `nbweb:${id}:nodes`; nodes = JSON.parse(localStorage.getItem(key) || '[]');
  }
  state.nodes = nodes;
  document.querySelectorAll('.node').forEach(e => e.remove());
  nodes.forEach(addNodeToCanvas);
  redrawWires();
}

async function refreshDocs() {
  const docs = await API.listDocs().catch(() => []);
  els.select.innerHTML = '';
  docs.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.document_id; opt.textContent = d.title; els.select.appendChild(opt);
  });
  if (docs.length) {
    els.select.value = docs[0].document_id; 
    await loadDocument(docs[0].document_id);
  } else {
    els.docHtml.innerHTML = '<p style="color:#666">请先上传HTML或PDF文档</p>';
  }
}

function initUI() {
  els.select.addEventListener('change', () => loadDocument(els.select.value));
  els.upload.addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    await API.upload(f).catch(() => {});
    await refreshDocs();
  });
  els.uploadPdf.addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const res = await API.uploadPdf(f).catch(() => {});
    await refreshDocs();
    if (res && res.document_id) {
      els.select.value = res.document_id; 
      await loadDocument(res.document_id);
    }
  });
}

function initSidebar() {
    const toggle = () => {
        const isHidden = els.sidebar.classList.toggle('hidden');
        els.sidebarResizer.classList.toggle('hidden', isHidden);
    };

    els.toggleSidebar.addEventListener('click', toggle);
    els.collapseSidebarBtn.addEventListener('click', () => {
        els.sidebar.classList.add('hidden');
        els.sidebarResizer.classList.add('hidden');
    });

    let isResizing = false;
    els.sidebarResizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        isResizing = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        const onMouseMove = (e) => {
            if (!isResizing) return;
            const containerRect = document.querySelector('#container').getBoundingClientRect();
            let newWidth = containerRect.right - e.clientX;
            
            const minWidth = parseInt(getComputedStyle(els.sidebar).minWidth, 10) || 300;
            const maxWidth = parseInt(getComputedStyle(els.sidebar).maxWidth, 10) || 800;
            if (newWidth < minWidth) newWidth = minWidth;
            if (newWidth > maxWidth) newWidth = maxWidth;

            els.sidebar.style.width = `${newWidth}px`;
        };

        const onMouseUp = () => {
            isResizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    });
}

function boot() {
  initPanZoom();
  initUI();
  initSidebar(); 
  const wrapper = els.canvasWrapper.getBoundingClientRect();
  state.panX = (wrapper.width - 920) / 2;
  state.panY = 60;
  setTransform();
  els.sidebar.classList.add('hidden');
  els.sidebarResizer.classList.add('hidden');
  refreshDocs();
}

boot();