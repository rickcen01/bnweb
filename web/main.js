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
  selectedElements: [],
  sidebarContext: {
    mode: 'document',
    conversation: [],
    sourceElement: null,
    sourceNodeId: null,
  },
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
  sidebarInputWrapper: document.getElementById('sidebarInputWrapper'),
  sidebarSelectedElements: document.getElementById('sidebarSelectedElements'),
  sidebarInput: document.querySelector('#sidebarInputWrapper input'),
  sidebarSendBtn: document.querySelector('#sidebarChatInstance .send'),
  sidebarDiscardBtn: document.querySelector('#sidebarChatInstance .discard'),
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
    if (e.target.closest('.micro-chat') || e.target.closest('.node') || e.target === els.sidebarResizer || e.target.classList.contains('resizer-handle')) return;
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

function toggleElementSelection(element) {
  const atomId = element.dataset.atomId;
  const index = state.selectedElements.findIndex(item => item.id === atomId);

  if (index > -1) {
    state.selectedElements.splice(index, 1);
    element.classList.remove('selected');
  } else {
    state.selectedElements.push({ id: atomId, html: element.dataset.originalHtml });
    element.classList.add('selected');
  }
  updateSelectedElementsUI();
}

function addElementSelectionById(atomId) {
  if (state.selectedElements.some(item => item.id === atomId)) return;
  const element = els.docHtml.querySelector(`[data-atom-id="${atomId}"]`);
  if (element) {
    state.selectedElements.push({ id: atomId, html: element.dataset.originalHtml });
    element.classList.add('selected');
    updateSelectedElementsUI();
  }
}

function updateSelectedElementsUI() {
  els.sidebarSelectedElements.innerHTML = '';
  els.sidebarInput.placeholder = state.selectedElements.length > 0
    ? '可继续输入问题，或继续选择...'
    : '拖拽或Ctrl+点击元素以选中...';

  state.selectedElements.forEach(item => {
    const pill = document.createElement('div');
    pill.className = 'selected-element-pill';
    pill.textContent = `@${item.id}`;
    
    const removeBtn = document.createElement('span');
    removeBtn.className = 'remove-pill';
    removeBtn.textContent = '×';
    removeBtn.title = '取消选择';
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      const element = els.docHtml.querySelector(`[data-atom-id="${item.id}"]`);
      if (element) toggleElementSelection(element);
    };
    
    pill.appendChild(removeBtn);
    els.sidebarSelectedElements.appendChild(pill);
  });
}

function clearElementSelection() {
  state.selectedElements.forEach(item => {
    const element = els.docHtml.querySelector(`[data-atom-id="${item.id}"]`);
    if (element) element.classList.remove('selected');
  });
  state.selectedElements = [];
  updateSelectedElementsUI();
}

function annotateAtoms() {
  state.elementIdCounter = 0;
  clearElementSelection();
  const selector = 'p, img, table, thead, tbody, tr, pre, h1, h2, h3, h4, h5, h6, li, blockquote, code, figure, figcaption, math, svg';
  const nodes = els.docHtml.querySelectorAll(selector);
  nodes.forEach((n) => {
    n.classList.add('atom');
    const id = `atom-${++state.elementIdCounter}`;
    n.dataset.atomId = id;
    n.dataset.originalHtml = n.outerHTML;
    n.setAttribute('draggable', 'true');

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

    n.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        toggleElementSelection(n);
      }
    });
    n.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', n.dataset.atomId);
      e.dataTransfer.effectAllowed = 'copy';
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
    
    conversation.push({ role: 'user', text, displayText: text, timestamp: Date.now() });
    const currentConversationLength = conversation.length;

    await renderMessages(messagesEl, conversation);
    
    const payload = {
      document_id: state.documentId,
      messages: conversation,
      source_element_html: atomEl.dataset.originalHtml,
    };
    
    const imageElement = atomEl.querySelector('img');
    if (imageElement) {
        payload.image_url = imageElement.getAttribute('src');
    }

    try {
      const res = await API.chat(payload);
      
      if (res.first_user_message_override && currentConversationLength > 0) {
        const userMessageIndex = currentConversationLength - 1;
        if (conversation[userMessageIndex] && conversation[userMessageIndex].role === 'user') {
          conversation[userMessageIndex].text = res.first_user_message_override;
        }
      }

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
      div.textContent = m.displayText || m.text;
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
  const nodeWidth = 28;
  const nodeHeight = 28;
  const node = {
    node_id: crypto.randomUUID(),
    document_id: state.documentId,
    source_element_id: atomEl.dataset.atomId,
    canvas_position: {
      x: (atomEl.getBoundingClientRect().left - els.canvas.getBoundingClientRect().left) / state.zoom - (nodeWidth / 2),
      y: (atomEl.getBoundingClientRect().top - els.canvas.getBoundingClientRect().top) / state.zoom - (nodeHeight / 2),
      zoom_level: state.zoom
    },
    conversation_log: conversation,
    user_annotations: null,
    source_element_html: atomEl.dataset.originalHtml,
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

function openNodeConversation(node) {
  closeAllMicroChats();
  const tpl = els.microChatTemplate.content.cloneNode(true);
  const box = tpl.querySelector('.micro-chat');
  const nodeEl = document.querySelector(`.node[data-node-id="${node.node_id}"]`);
  if (!nodeEl) return;
  box.dataset.nodeIdRef = node.node_id;

  const initialChatBoxWidth = 320;
  const gap = 16;
  let left = parseFloat(nodeEl.style.left) - initialChatBoxWidth - gap;
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
      
      node.conversation_log.push({ role: 'user', text, displayText: text, timestamp: Date.now() });
      const currentConversationLength = node.conversation_log.length;
      await renderMessages(messagesEl, node.conversation_log);

      const payload = {
          document_id: state.documentId,
          messages: node.conversation_log,
          source_element_html: node.source_element_html || '',
      };

      const sourceElement = document.querySelector(`[data-atom-id="${node.source_element_id}"]`);
      if (sourceElement){
          const imageElement = sourceElement.querySelector('img');
          if(imageElement) {
            payload.image_url = imageElement.src;
          }
      }
      
      try {
          const res = await API.chat(payload);

          if (res.first_user_message_override && currentConversationLength > 0) {
            const userMessageIndex = currentConversationLength - 1;
            if (node.conversation_log[userMessageIndex] && node.conversation_log[userMessageIndex].role === 'user') {
              node.conversation_log[userMessageIndex].text = res.first_user_message_override;
            }
          }

          node.conversation_log.push({ role: res.role || 'assistant', text: res.text, timestamp: res.timestamp || Date.now() });
          await API.saveNode(state.documentId, node);
          await renderMessages(messagesEl, node.conversation_log);
      } catch (err) {
          node.conversation_log.push({ role: 'assistant', text: '聊天服务不可用。', timestamp: Date.now() });
          await renderMessages(messagesEl, node.conversation_log);
      }
  };

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

  const saveBtn = box.querySelector('.save');
  saveBtn.textContent = '收起';
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

async function appendChatToSidebar(atomEl, conversation, nodeId = null) {
  clearElementSelection();
  state.sidebarContext = {
    mode: 'element',
    conversation: [...conversation],
    sourceElement: atomEl,
    sourceNodeId: nodeId
  };

  els.sidebarTitle.textContent = 'AI 对话 (聚焦内容)';
  els.sidebarInput.placeholder = '就选中内容继续提问...';
  els.resetSidebarBtn.classList.remove('hidden');
  els.sidebarChatSelector.classList.add('hidden');
  els.saveNodeFromSidebarBtn.classList.remove('hidden');
  
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
  await loadChats(id);
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
    clearElementSelection();
    state.sidebarContext = {
        mode: 'document',
        conversation: [],
        sourceElement: null,
        sourceNodeId: null
    };
    els.sidebarTitle.textContent = 'AI 对话 (全文)';
    els.sidebarInput.placeholder = '拖拽或Ctrl+点击元素以选中...';
    els.resetSidebarBtn.classList.add('hidden');
    els.sidebarChatSelector.classList.remove('hidden');
    els.saveNodeFromSidebarBtn.classList.add('hidden');
    
    const activeChat = state.chats.find(c => c.id === state.activeChatId);
    state.sidebarContext.conversation = activeChat ? activeChat.messages : [];
    await renderMessages(els.sidebarMessages, state.sidebarContext.conversation);
}

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

function initSidebarChat() {
  const send = async () => {
      const text = els.sidebarInput.value.trim();
      if (!text && state.selectedElements.length === 0) return;
      
      els.sidebarInput.value = '';

      let userMessageText = text;
      if (state.selectedElements.length > 0) {
          const elementTags = state.selectedElements.map(el => `@${el.id}`).join(' ');
          userMessageText = `${elementTags} ${text}`.trim();
      }
      
      state.sidebarContext.conversation.push({ role: 'user', text: userMessageText, displayText: userMessageText, timestamp: Date.now() });
      const currentConversationLength = state.sidebarContext.conversation.length;
      await renderMessages(els.sidebarMessages, state.sidebarContext.conversation);

      const payload = {
          document_id: state.documentId,
          messages: state.sidebarContext.conversation,
      };
      
      let imageUrl = null;
      if (state.selectedElements.length > 0) {
          payload.selected_elements_html = state.selectedElements.map(el => el.html);
          for (const item of state.selectedElements) {
              const tempDiv = document.createElement('div');
              tempDiv.innerHTML = item.html;
              const img = tempDiv.querySelector('img');
              if (img) {
                  imageUrl = img.getAttribute('src');
                  break;
              }
          }
      } else if (state.sidebarContext.mode === 'element' && state.sidebarContext.sourceElement) {
          payload.source_element_id = state.sidebarContext.sourceElement.dataset.atomId;
          payload.source_element_html = state.sidebarContext.sourceElement.dataset.originalHtml;
          
          const imageElement = state.sidebarContext.sourceElement.querySelector('img');
          if (imageElement) {
              imageUrl = imageElement.getAttribute('src');
          }
      }
      
      if (imageUrl) {
          payload.image_url = imageUrl;
      }

      clearElementSelection();

      console.log("[DEBUG] Sending from Sidebar. Payload:", JSON.stringify(payload, null, 2));

      try {
          const res = await API.chat(payload);
          
          if (res.first_user_message_override && currentConversationLength > 0) {
              const userMessageIndex = currentConversationLength - 1;
              if (state.sidebarContext.conversation[userMessageIndex] && state.sidebarContext.conversation[userMessageIndex].role === 'user') {
                  console.log("[DEBUG] Overriding first user message in history with full context from server.");
                  state.sidebarContext.conversation[userMessageIndex].text = res.first_user_message_override;
              }
          }

          state.sidebarContext.conversation.push({ role: res.role || 'assistant', text: res.text, timestamp: res.timestamp || Date.now() });
          
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
  els.chatHistorySelect.addEventListener('change', () => setActiveChat(els.chatHistorySelect.value));
  els.newChatBtn.addEventListener('click', createNewChat);
  els.saveNodeFromSidebarBtn.addEventListener('click', async () => {
      if (state.sidebarContext.mode !== 'element' || !state.sidebarContext.sourceElement) return;

      const { sourceElement, conversation, sourceNodeId } = state.sidebarContext;
      if (sourceNodeId) {
          const nodeToUpdate = state.nodes.find(n => n.node_id === sourceNodeId);
          if (nodeToUpdate) {
              nodeToUpdate.conversation_log = conversation;
              try {
                  await API.saveNode(state.documentId, nodeToUpdate);
              } catch(e) {
                  console.error("更新节点失败:", e);
              }
          }
      } else {
          const node = await saveConversationAsNode(sourceElement, conversation);
          addNodeToCanvas(node);
      }
      await resetSidebarToDocumentMode();
  });
}

function initSidebarDropZone() {
    const dropZone = els.sidebarInputWrapper;

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#007bff';
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.style.borderColor = '';
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '';
        const atomId = e.dataTransfer.getData('text/plain');
        if (atomId) {
            addElementSelectionById(atomId);
        }
    });

    dropZone.addEventListener('click', () => {
        els.sidebarInput.focus();
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
  initSidebarDropZone();
  
  const wrapper = els.canvasWrapper.getBoundingClientRect();
  state.panX = (wrapper.width - 920) / 2;
  state.panY = 60;
  setTransform();
  
  els.sidebar.classList.add('hidden');
  els.sidebarResizer.classList.add('hidden');
  
  refreshDocs();
}

boot();