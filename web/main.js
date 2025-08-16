// web/main.js

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
  chat: async (payload) => fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(r => r.json()),
  // 【新增】对话历史相关API
  listChats: async (docId) => fetch(`/api/chats/${encodeURIComponent(docId)}`).then(r => r.json()),
  saveChat: async (docId, chat) => fetch(`/api/chats/${encodeURIComponent(docId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chat)
  }).then(r => r.json()),
};

const state = {
  zoom: 1,
  panX: 0,
  panY: 0,
  documentId: null,
  nodes: [],
  elementIdCounter: 0,
  // 【修改】管理侧边栏状态
  sidebarContext: {
    mode: 'document', // 'document' 或 'element'
    conversation: [],
    sourceElement: null,
    sourceNodeId: null, // <-- 【新增】记录对话来源的节点ID
  },
  // 【新增】管理侧边栏对话历史
  chats: [],
  activeChatId: null,
};

const els = {
  select: document.getElementById('documentSelect'),
  upload: document.getElementById('uploadInput'),
  uploadPdf: document.getElementById('uploadPdfInput'),
  toggleSidebar: document.getElementById('toggleSidebar'),
  sidebar: document.getElementById('sidebar'),
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
  sidebarTitle: document.getElementById('sidebarTitle'),
  resetSidebarBtn: document.getElementById('resetSidebarBtn'),
  sidebarChatInstance: document.getElementById('sidebarChatInstance'),
  sidebarMessages: document.querySelector('#sidebarChatInstance .messages'),
  sidebarInput: document.querySelector('#sidebarChatInstance .input input'),
  sidebarSendBtn: document.querySelector('#sidebarChatInstance .send'),
  sidebarDiscardBtn: document.querySelector('#sidebarChatInstance .discard'),
  // 【新增】侧边栏UI元素的引用
  sidebarChatSelector: document.getElementById('sidebarChatSelector'),
  chatHistorySelect: document.getElementById('chatHistorySelect'),
  newChatBtn: document.getElementById('newChatBtn'),
  saveNodeFromSidebarBtn: document.querySelector('#sidebarChatInstance .save-node'),
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
  state.elementIdCounter = 0;
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
    appendChatToSidebar(atomEl, conversation);
    box.remove();
  });
  discardBtn.addEventListener('click', () => { box.remove(); });
}

function closeAllMicroChats() {
  document.querySelectorAll('.micro-chat:not(.sidebar)').forEach(e => e.remove());
}

async function renderMessages(container, messages) {
  container.innerHTML = '';
  for (const m of messages) {
    const div = document.createElement('div');
    div.className = `m ${m.role}`;
    if (m.role === 'assistant' && window.marked) {
      div.innerHTML = marked.parse(m.text, { breaks: true });
    } else {
      div.textContent = m.text;
    }
    container.appendChild(div);
  }
  
  if (window.MathJax && window.MathJax.typesetPromise) {
    try { await window.MathJax.typesetPromise([container]); } catch (err) { console.error("MathJax typesetting error:", err); }
  }
  
  container.scrollTop = container.scrollHeight;
}

async function saveConversationAsNode(atomEl, conversation) {
  const node = {
    node_id: crypto.randomUUID(),
    document_id: state.documentId,
    source_element_id: atomEl.dataset.atomId,
    canvas_position: {
      x: (atomEl.getBoundingClientRect().right - els.canvas.getBoundingClientRect().left) / state.zoom + 30,
      y: (atomEl.getBoundingClientRect().top - els.canvas.getBoundingClientRect().top) / state.zoom,
      zoom_level: state.zoom
    },
    conversation_log: conversation,
    user_annotations: null,
    source_element_html: atomEl.dataset.originalHtml, // 【修改】保存HTML
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
    const d = `M ${x1},${y1} C ${x1 + 50},${y1} ${x2 - 150},${y2} ${x2},${y2}`;
    path.setAttribute('d', d);
    path.setAttribute('class', 'wire');
    els.wires.appendChild(path);
  });
}

// 【修改】重构节点对话功能，使其支持续聊
function openNodeConversation(node) {
  closeAllMicroChats();
  const tpl = els.microChatTemplate.content.cloneNode(true);
  const box = tpl.querySelector('.micro-chat');
  const nodeEl = document.querySelector(`.node[data-node-id="${node.node_id}"]`);
  if (!nodeEl) return;
  box.dataset.nodeIdRef = node.node_id;

  const chatBoxWidth = 320;
  const gap = 16;
  let left = parseFloat(nodeEl.style.left) + nodeEl.offsetWidth + gap;
  let top = parseFloat(nodeEl.style.top);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;

  const messagesEl = box.querySelector('.messages');
  const input = box.querySelector('input');
  const sendBtn = box.querySelector('.send');
  
  renderMessages(messagesEl, node.conversation_log || []);

  const send = async () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      node.conversation_log.push({ role: 'user', text, timestamp: Date.now() });
      await renderMessages(messagesEl, node.conversation_log);

      const payload = {
          document_id: state.documentId,
          source_element_id: node.source_element_id,
          messages: node.conversation_log,
          source_element_html: node.source_element_html || '',
      };
      try {
          const res = await API.chat(payload);
          node.conversation_log.push({ role: res.role || 'assistant', text: res.text, timestamp: res.timestamp || Date.now() });
          await API.saveNode(state.documentId, node); // 保存更新后的对话
          await renderMessages(messagesEl, node.conversation_log);
      } catch (err) {
          node.conversation_log.push({ role: 'assistant', text: '聊天服务不可用。', timestamp: Date.now() });
          await renderMessages(messagesEl, node.conversation_log);
      }
  };

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

  const saveBtn = box.querySelector('.save');
  saveBtn.textContent = '收起'; // 修改按钮文字
  saveBtn.addEventListener('click', () => box.remove());
  
  box.querySelector('.expand').addEventListener('click', () => {
    const sourceEl = els.docHtml.querySelector(`[data-atom-id="${node.source_element_id}"]`);
    appendChatToSidebar(sourceEl, node.conversation_log || [], node.node_id);
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

// 【修改】此函数现在用于将对话加载到侧边栏，并切换其模式
async function appendChatToSidebar(atomEl, conversation, nodeId = null) {
  state.sidebarContext = {
    mode: 'element',
    conversation: [...conversation],
    sourceElement: atomEl,
    sourceNodeId: nodeId
  };

  els.sidebarTitle.textContent = 'AI 对话 (聚焦内容)';
  els.sidebarInput.placeholder = '就选中内容继续提问...';
  els.resetSidebarBtn.classList.remove('hidden');
  els.sidebarChatSelector.classList.add('hidden'); // 隐藏历史选择
  els.saveNodeFromSidebarBtn.classList.remove('hidden'); // 显示创建节点按钮
  
  await renderMessages(els.sidebarMessages, state.sidebarContext.conversation);
  
  els.sidebar.classList.remove('hidden');
  els.sidebarResizer.classList.remove('hidden');
}


async function loadDocument(id) {
  state.documentId = id;
  closeAllMicroChats();
  const html = await API.getDocHtml(id).catch(() => '<p style="color:#a00">无法加载文档</p>');
  els.docHtml.innerHTML = html;
  annotateAtoms();
  if (window.MathJax && window.MathJax.typesetPromise) {
    try { await window.MathJax.typesetPromise([els.docHtml]); } catch {}
  }
  await loadNodes(id);
  await loadChats(id); // 【新增】加载对话历史
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
    if (!state.documentId || !docs.find(d => d.document_id === state.documentId)) {
        els.select.value = docs[0].document_id;
        await loadDocument(docs[0].document_id);
    }
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

async function resetSidebarToDocumentMode() {
    state.sidebarContext = {
        mode: 'document',
        conversation: [],
        sourceElement: null,
        sourceNodeId: null // <-- 【新增】重置时清除
    };
    els.sidebarTitle.textContent = 'AI 对话 (全文)';
    els.sidebarInput.placeholder = '就整篇文档提问...';
    els.resetSidebarBtn.classList.add('hidden');
    els.sidebarChatSelector.classList.remove('hidden'); // 显示历史选择
    els.saveNodeFromSidebarBtn.classList.add('hidden'); // 隐藏创建节点按钮
    
    // 恢复到当前激活的全局对话
    const activeChat = state.chats.find(c => c.id === state.activeChatId);
    state.sidebarContext.conversation = activeChat ? activeChat.messages : [];
    await renderMessages(els.sidebarMessages, state.sidebarContext.conversation);
}

// 【新增】系列函数用于管理侧边栏对话历史
async function loadChats(docId) {
    try {
        state.chats = await API.listChats(docId);
        renderChatHistoryDropdown();
        if (state.chats.length > 0) {
            await setActiveChat(state.chats[0].id);
        } else {
            await createNewChat();
        }
    } catch (e) {
        console.error("无法加载对话历史", e);
        await createNewChat();
    }
}

function renderChatHistoryDropdown() {
    els.chatHistorySelect.innerHTML = '';
    state.chats.forEach(chat => {
        const option = document.createElement('option');
        option.value = chat.id;
        option.textContent = chat.name;
        els.chatHistorySelect.appendChild(option);
    });
    if (state.activeChatId) {
        els.chatHistorySelect.value = state.activeChatId;
    }
}

async function setActiveChat(chatId) {
    state.activeChatId = chatId;
    const chat = state.chats.find(c => c.id === chatId);
    if (chat) {
        state.sidebarContext.conversation = chat.messages;
        await renderMessages(els.sidebarMessages, chat.messages);
        els.chatHistorySelect.value = chatId;
    }
}

async function createNewChat() {
    const newChat = {
        id: crypto.randomUUID(),
        name: `对话 ${state.chats.length + 1}`,
        messages: []
    };
    state.chats.push(newChat);
    state.activeChatId = newChat.id;
    await API.saveChat(state.documentId, newChat);
    renderChatHistoryDropdown();
    await setActiveChat(newChat.id);
}

// 【修改】初始化侧边栏的永久对话功能
function initSidebarChat() {
    const send = async () => {
        const text = els.sidebarInput.value.trim();
        if (!text) return;
        
        els.sidebarInput.value = '';
        state.sidebarContext.conversation.push({ role: 'user', text, timestamp: Date.now() });
        await renderMessages(els.sidebarMessages, state.sidebarContext.conversation);

        const payload = {
            document_id: state.documentId,
            messages: state.sidebarContext.conversation,
        };

        if (state.sidebarContext.mode === 'element' && state.sidebarContext.sourceElement) {
            payload.source_element_id = state.sidebarContext.sourceElement.dataset.atomId;
            payload.source_element_html = state.sidebarContext.sourceElement.dataset.originalHtml;
        }

        try {
            const res = await API.chat(payload);
            state.sidebarContext.conversation.push({ role: res.role || 'assistant', text: res.text, timestamp: res.timestamp || Date.now() });
            
            // 【修改】如果是在全局对话模式下，保存对话历史
            if (state.sidebarContext.mode === 'document') {
                const activeChat = state.chats.find(c => c.id === state.activeChatId);
                if (activeChat) {
                    activeChat.messages = state.sidebarContext.conversation;
                    await API.saveChat(state.documentId, activeChat);
                }
            }
            await renderMessages(els.sidebarMessages, state.sidebarContext.conversation);

        } catch (err) {
            state.sidebarContext.conversation.push({ role: 'assistant', text: '聊天服务不可用。', timestamp: Date.now() });
            await renderMessages(els.sidebarMessages, state.sidebarContext.conversation);
        }
    };

    els.sidebarSendBtn.addEventListener('click', send);
    els.sidebarInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    
    els.sidebarDiscardBtn.addEventListener('click', async () => {
        if (confirm('确定要清空当前对话吗？')) {
            state.sidebarContext.conversation = [];
            if (state.sidebarContext.mode === 'document') {
                const activeChat = state.chats.find(c => c.id === state.activeChatId);
                if (activeChat) {
                    activeChat.messages = [];
                    await API.saveChat(state.documentId, activeChat);
                }
            }
            renderMessages(els.sidebarMessages, []);
        }
    });

    els.resetSidebarBtn.addEventListener('click', resetSidebarToDocumentMode);
    
    // 【新增】处理对话历史切换和新建
    els.chatHistorySelect.addEventListener('change', () => setActiveChat(els.chatHistorySelect.value));
    els.newChatBtn.addEventListener('click', createNewChat);

    // 【新增】处理从侧边栏创建节点
    els.saveNodeFromSidebarBtn.addEventListener('click', async () => {
        if (state.sidebarContext.mode !== 'element' || !state.sidebarContext.sourceElement) {
            return;
        }

        const { sourceElement, conversation, sourceNodeId } = state.sidebarContext;

        if (sourceNodeId) {
            // 情况一：来源是现有节点，更新它
            const nodeToUpdate = state.nodes.find(n => n.node_id === sourceNodeId);
            if (nodeToUpdate) {
                nodeToUpdate.conversation_log = conversation; // 更新对话历史
                try {
                    await API.saveNode(state.documentId, nodeToUpdate);
                } catch(e) {
                    console.error("更新节点失败:", e);
                    // 可以在这里添加本地存储的后备逻辑
                }
            } else {
                console.error("要更新的节点未找到:", sourceNodeId);
            }
        } else {
            // 情况二：来源是新元素，创建新节点
            const node = await saveConversationAsNode(sourceElement, conversation);
            addNodeToCanvas(node);
        }
        
        // 操作完成后，重置侧边栏回到全局对话模式
        await resetSidebarToDocumentMode();
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
            
            const minWidth = 300;
            const maxWidth = 800;
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
  initSidebarChat();
  
  const wrapper = els.canvasWrapper.getBoundingClientRect();
  state.panX = (wrapper.width - 920) / 2;
  state.panY = 60;
  setTransform();
  
  els.sidebar.classList.add('hidden');
  els.sidebarResizer.classList.add('hidden');
  
  refreshDocs();
}

boot();