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
    if (e.target.closest('.micro-chat') || e.target.closest('.node')) return;
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
  // 1. 根据我们刚才添加的标记，查找这个节点的对话框是否已经存在
  const existingChat = document.querySelector(`.micro-chat[data-node-id-ref='${node.node_id}']`);

  if (existingChat) {
    // 2. 如果存在，就移除它（关闭）
    existingChat.remove();
  } else {
    // 3. 如果不存在，就调用原来的函数来创建并打开它
    openNodeConversation(node);
  }
}
function openMicroChat(atomEl) {
  closeAllMicroChats();
  const tpl = els.microChatTemplate.content.cloneNode(true);
  const box = tpl.querySelector('.micro-chat');

  // box.dataset.nodeIdRef = node.node_id;
  // 1. 获取所有元素相对于浏览器视窗的位置信息
  const rect = atomEl.getBoundingClientRect();
  const parentRect = els.canvas.getBoundingClientRect(); // 画布容器 #canvas 的位置
  const contentFrameRect = els.contentFrame.getBoundingClientRect(); // 内容区域 #contentFrame 的位置

  // 2. 【核心修改】计算在视窗中的像素偏移量
  const offsetX = contentFrameRect.right - parentRect.left;
  const offsetY = rect.top - parentRect.top;

  // 3. 【关键】将视窗偏移量根据当前缩放比例转换回画布的内部坐标
  //    这是解决缩放问题的关键一步
  const left = offsetX / state.zoom + 24; // 在右侧留出 24px 的*画布内*间距
  const top = offsetY / state.zoom;

  // 4. 将计算出的正确位置应用到提问框上
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
    renderMessages(messagesEl, conversation);
    const payload = {
      document_id: state.documentId,
      source_element_id: atomEl.dataset.atomId,
      messages: conversation,
      source_element_html: atomEl.outerHTML,
      full_document_html: els.docHtml.innerHTML,
    };
    try {
      const res = await API.chat(payload);
      conversation.push({ role: res.role || 'assistant', text: res.text, timestamp: res.timestamp || Date.now() });
      renderMessages(messagesEl, conversation);
    } catch (err) {
      conversation.push({ role: 'assistant', text: '聊天服务不可用。', timestamp: Date.now() });
      renderMessages(messagesEl, conversation);
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
    appendChatToSidebar(atomEl, conversation);
    // Move chat into sidebar visually if desired
  });

  discardBtn.addEventListener('click', () => { box.remove(); });
}

function closeAllMicroChats() {
  document.querySelectorAll('.micro-chat').forEach(e => e.remove());
}

function renderMessages(container, messages) {
  container.innerHTML = '';
  messages.forEach(m => {
    const div = document.createElement('div');
    div.className = `m ${m.role}`;
    div.textContent = m.text;
    container.appendChild(div);
  });
  container.scrollTop = container.scrollHeight;
}

async function saveConversationAsNode(atomEl, conversation) {
  const node = {
    node_id: crypto.randomUUID(),
    document_id: state.documentId,
    source_element_id: atomEl.dataset.atomId,
    canvas_position: {
      x: (atomEl.getBoundingClientRect().left - els.canvas.getBoundingClientRect().left) / state.zoom - state.panX / state.zoom,
      y: (atomEl.getBoundingClientRect().top - els.canvas.getBoundingClientRect().top) / state.zoom - state.panY / state.zoom,
      zoom_level: state.zoom
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
  el.title = '点击展开/收缩对话'; // 更新提示文字

  // 【核心修改】将原来的 openNodeConversation 改为新的 toggleNodeConversation
  el.addEventListener('click', () => toggleNodeConversation(node));
  enableNodeDrag(el, node);
  els.canvas.appendChild(el);
  redrawWires();
}

function enableNodeDrag(el, node) {
  let dragging = false; let start = { x: 0, y: 0 }; let origin = { x: 0, y: 0 };
  el.addEventListener('mousedown', (e) => {
    dragging = true; start = { x: e.clientX, y: e.clientY };
    const rect = el.getBoundingClientRect(); const parent = els.canvas.getBoundingClientRect();
    origin = { x: rect.left - parent.left, y: rect.top - parent.top };
    el.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', async (e) => {
    if (!dragging) return;
    const dx = (e.clientX - start.x) / state.zoom; const dy = (e.clientY - start.y) / state.zoom;
    const nx = origin.x + dx; const ny = origin.y + dy;
    el.style.left = `${nx}px`; el.style.top = `${ny}px`;
    node.canvas_position.x = nx; node.canvas_position.y = ny; redrawWires();
  });
  window.addEventListener('mouseup', async () => {
    if (!dragging) return; dragging = false; el.style.cursor = 'grab';
    try { await API.saveNode(state.documentId, node); } catch {}
  });
}

function redrawWires() {
  els.wires.innerHTML = '';
  state.nodes.forEach(node => {
    const nodeEl = [...document.querySelectorAll('.node')].find(e => e.dataset.nodeId === node.node_id);
    // Find source element by atom ID
    let srcEl = els.docHtml.querySelector(`[data-atom-id="${node.source_element_id}"]`);
    if (!srcEl) {
      // Fallback: try to find by data-atomId (alternative attribute)
      srcEl = els.docHtml.querySelector(`[data-atomId="${node.source_element_id}"]`);
    }
    if (!nodeEl || !srcEl) return;
    
    // Get positions relative to the canvas (not viewport)
    const nodeRect = nodeEl.getBoundingClientRect();
    const srcRect = srcEl.getBoundingClientRect();
    const canvasRect = els.canvas.getBoundingClientRect();
    
    // Calculate wire endpoints in canvas coordinates, accounting for transform
    const x1 = (nodeRect.left - canvasRect.left) / state.zoom;
    const y1 = (nodeRect.top - canvasRect.top) / state.zoom;
    const x2 = (srcRect.left - canvasRect.left) / state.zoom;
    const y2 = (srcRect.top - canvasRect.top) / state.zoom;
    
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const dx = Math.abs(x2 - x1) * 0.5; const dy = 40;
    const d = `M ${x1},${y1} C ${x1+dx},${y1+dy} ${x2-dx},${y2-dy} ${x2},${y2}`;
    path.setAttribute('d', d); path.setAttribute('class', 'wire');
    els.wires.appendChild(path);
  });
}

function openNodeConversation(node) {
  // closeAllMicroChats(); // 根据问题1的需要决定是否保留
  const tpl = els.microChatTemplate.content.cloneNode(true);
  const box = tpl.querySelector('.micro-chat');
  const nodeEl = [...document.querySelectorAll('.node')].find(e => e.dataset.nodeId === node.node_id);
  if (!nodeEl) return;
  box.dataset.nodeIdRef = node.node_id;
  const rect = nodeEl.getBoundingClientRect();
  const parentRect = els.canvas.getBoundingClientRect();
  
  const chatBoxWidth = 260; // 对话框宽度，定义在 styles.css
  const gap = 8; // 期望的间距

  // 【核心修改】计算新的 left 和 top 值
  // left = (节点左边界 - 父容器左边界) / 缩放 - 对话框宽度 / 缩放 - 间距 / 缩放
  const left = (rect.left - parentRect.left) / state.zoom - chatBoxWidth - (gap / state.zoom);
  const top = (rect.top - parentRect.top) / state.zoom;

  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  const messagesEl = box.querySelector('.messages');
  renderMessages(messagesEl, node.conversation_log || []);
  // wire actions
  box.querySelector('.save').addEventListener('click', async () => {
    // no-op save: persist current position
    try { await API.saveNode(state.documentId, node); } catch {}
    box.remove();
  });
  box.querySelector('.expand').addEventListener('click', () => {
    els.sidebar.classList.remove('hidden');
    appendChatToSidebar({ dataset: { atomId: node.source_element_id } }, node.conversation_log || []);
  });
  box.querySelector('.discard').addEventListener('click', () => {
    // Delete the node entirely
    if (node && node.node_id) {
      API.deleteNode(state.documentId, node.node_id).catch(() => {});
      state.nodes = state.nodes.filter(n => n.node_id !== node.node_id);
      const el = document.querySelector(`.node[data-node-id='${node.node_id}']`);
      if (el) el.remove();
      redrawWires();  // Redraw to remove any associated wires
    }
    box.remove();
  });
  els.canvas.appendChild(box);
}

function appendChatToSidebar(atomEl, conversation) {
  // Clear existing sidebar content
  els.sidebarContent.innerHTML = '';
  
  const tpl = els.microChatTemplate.content.cloneNode(true);
  const mc = tpl.querySelector('.micro-chat');
  mc.classList.add('sidebar');
  
  // Set up the chat display
  const messagesEl = mc.querySelector('.messages');
  renderMessages(messagesEl, conversation);
  
  // Add title
  const title = document.createElement('div');
  title.textContent = `与元素 ${atomEl?.dataset?.atomId || '未知'} 的对话`;
  title.style.cssText = 'font-weight: 600; padding: 8px 10px; border-bottom: 1px solid #eee; margin-bottom: 8px;';
  mc.insertBefore(title, mc.firstChild);
  
  // --- 【新增代码】为侧边栏按钮绑定事件 ---
  const saveBtn = mc.querySelector('.save');
  const discardBtn = mc.querySelector('.discard');

  // "保存并收缩"按钮的功能：可以定义为关闭侧边栏
  saveBtn.textContent = '关闭'; // 可以重命名按钮，使其功能更明确
  saveBtn.addEventListener('click', () => {
    els.sidebar.classList.add('hidden'); // 点击后隐藏侧边栏
  });

  // "不保留"按钮的功能：可以定义为清空侧边栏内容
  discardBtn.textContent = '清空'; // 重命名按钮
  discardBtn.addEventListener('click', () => {
    els.sidebarContent.innerHTML = ''; // 点击后清空侧边栏
  });
  // --- 新增代码结束 ---
  
  // Add to sidebar
  els.sidebarContent.appendChild(mc);
  
  // Ensure sidebar is visible
  els.sidebar.classList.remove('hidden');
}

async function loadDocument(id) {
  state.documentId = id;
  const html = await API.getDocHtml(id).catch(() => '<p style="color:#a00">无法加载文档</p>');
  els.docHtml.innerHTML = html;
  if (window.MathJax && window.MathJax.typesetPromise) {
    try { await window.MathJax.typesetPromise([els.docHtml]); } catch {}
  }
  annotateAtoms();
  await loadNodes(id);
}

async function loadNodes(id) {
  let nodes = [];
  try { nodes = await API.listNodes(id); }
  catch {
    const key = `nbweb:${id}:nodes`; nodes = JSON.parse(localStorage.getItem(key) || '[]');
  }
  state.nodes = nodes;
  // Render
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
    els.select.value = docs[0].document_id; await loadDocument(docs[0].document_id);
  } else {
    els.docHtml.innerHTML = '<p style="color:#666">请先上传HTML或PDF文档</p>';
  }
}

function initUI() {
  els.toggleSidebar.addEventListener('click', () => els.sidebar.classList.toggle('hidden'));
  // Debug: log sidebar state
  console.log('Sidebar elements:', {
    sidebar: els.sidebar,
    toggleBtn: els.toggleSidebar,
    content: els.sidebarContent
  });
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
      els.select.value = res.document_id; await loadDocument(res.document_id);
    }
  });
}

function boot() {
  initPanZoom();
  initUI();
  // center the canvas content initially
  const wrapper = els.canvasWrapper.getBoundingClientRect();
  state.panX = wrapper.width / 2 - 460; // since contentFrame width ~920
  state.panY = 60;
  setTransform();
  // Debug: ensure sidebar starts hidden
  els.sidebar.classList.add('hidden');
  refreshDocs();
}

boot();