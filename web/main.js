// web/main.js

const API = {
  listDocs: async () => fetch('/api/documents').then(r => r.json()),
  getDocHtml: async (id) => fetch(`/api/document/${encodeURIComponent(id)}`).then(r => r.text()),
  upload: async (file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Upload failed');
    }
    return res.json();
  },
  uploadPdf: async (file) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/upload-pdf', { method: 'POST', body: form });
    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'PDF processing failed');
    }
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
  // 新增: 绘图笔记API
  getDrawings: async (docId) => fetch(`/api/drawings/${encodeURIComponent(docId)}`).then(r => r.json()),
  saveDrawings: async (docId, drawings) => fetch(`/api/drawings/${encodeURIComponent(docId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(drawings)
  }).then(r => r.json()),
};

const state = {
  zoom: 1,
  panX: 0,
  panY: 0,
  documentId: null,
  documents: [], 
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
  // 新增: 绘图状态
  drawing: {
    activeTool: null, // 'pen', 'highlighter', 'eraser'
    color: '#FF0000',
    strokeWidth: 5,
    isDrawing: false,
    paths: [],
    currentPath: null,
    redoStack: [], // <-- 新增这一行
  },
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
  processingOverlay: document.getElementById('processingOverlay'),
  processingText: document.getElementById('processingText'),
  contextSelectorContainer: document.getElementById('contextSelectorContainer'),
  contextRangeSelect: document.getElementById('contextRangeSelect'),
  customRangeInputs: document.getElementById('customRangeInputs'),
  customStartChar: document.getElementById('customStartChar'),
  customEndChar: document.getElementById('customEndChar'),
  // 新增: 绘图相关元素
  drawingCanvas: document.getElementById('drawingCanvas'),
  annotationToolbar: document.getElementById('annotationToolbar'),
  toolBtns: document.querySelectorAll('.tool-btn'),
  colorPicker: document.getElementById('colorPicker'),
  strokeWidth: document.getElementById('strokeWidth'),
  strokeWidthValue: document.getElementById('strokeWidthValue'),
  undoBtn: document.getElementById('undoBtn'),
  redoBtn: document.getElementById('redoBtn'),
};

// 新增: 绘图Canvas的2D上下文
const drawingCtx = els.drawingCanvas.getContext('2d');

function showProcessingOverlay(text) {
  els.processingText.textContent = text;
  els.processingOverlay.classList.remove('hidden');
}

function hideProcessingOverlay() {
  els.processingOverlay.classList.add('hidden');
}

function showThinkingIndicator(messagesContainer) {
  const thinkingEl = document.createElement('div');
  thinkingEl.className = 'm assistant thinking';
  thinkingEl.innerHTML = '<div class="dot-flashing"></div>';
  messagesContainer.appendChild(thinkingEl);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  return thinkingEl;
}

function hideThinkingIndicator(thinkingEl) {
  if (thinkingEl && thinkingEl.parentNode) {
    thinkingEl.parentNode.removeChild(thinkingEl);
  }
}

// 新增: 重绘绘图Canvas
function redrawDrawingCanvas() {
    if (!drawingCtx) return;
    // 适配高DPI屏幕
    const dpr = window.devicePixelRatio || 1;
    const rect = els.drawingCanvas.getBoundingClientRect();
    els.drawingCanvas.width = rect.width * dpr;
    els.drawingCanvas.height = rect.height * dpr;
    drawingCtx.scale(dpr, dpr);

    drawingCtx.clearRect(0, 0, els.drawingCanvas.width, els.drawingCanvas.height);

    // 应用与主画布相同的变换
    drawingCtx.save();
    drawingCtx.translate(state.panX, state.panY);
    drawingCtx.scale(state.zoom, state.zoom);

    // 绘制所有已保存的路径
    const pathsToDraw = [...state.drawing.paths];
    if (state.drawing.isDrawing && state.drawing.currentPath) {
        pathsToDraw.push(state.drawing.currentPath);
    }
    
    pathsToDraw.forEach(path => {
        drawingCtx.beginPath();
        drawingCtx.strokeStyle = path.color;
        drawingCtx.lineWidth = path.width;
        drawingCtx.lineCap = 'round';
        drawingCtx.lineJoin = 'round';
        
        if (path.tool === 'highlighter') {
            drawingCtx.globalCompositeOperation = 'multiply';
            drawingCtx.globalAlpha = 0.5; // 半透明效果
        } else if (path.tool === 'eraser') {
            drawingCtx.globalCompositeOperation = 'destination-out';
        } else {
            drawingCtx.globalCompositeOperation = 'source-over';
            drawingCtx.globalAlpha = 1.0;
        }

        if(path.points.length > 0) {
            drawingCtx.moveTo(path.points[0].x, path.points[0].y);
            for (let i = 1; i < path.points.length; i++) {
                drawingCtx.lineTo(path.points[i].x, path.points[i].y);
            }
        }
        drawingCtx.stroke();
    });

    drawingCtx.restore();
}

function setTransform() {
  els.canvas.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  els.zoomValue.textContent = `${Math.round(state.zoom * 100)}%`;
  redrawWires();
  redrawDrawingCanvas(); // 修改: 平移缩放时重绘笔记
}

function initPanZoom() {
  let isPanning = false;
  let last = { x: 0, y: 0 };
  els.canvasWrapper.addEventListener('mousedown', (e) => {
    // 修改: 绘图模式下不触发平移
    if (e.target.closest('.micro-chat') || e.target.closest('.node') || e.target === els.sidebarResizer || e.target.classList.contains('resizer-handle') || state.drawing.activeTool) return;
    isPanning = true; last = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    const dx = e.clientX - last.x; const dy = e.clientY - last.y; last = { x: e.clientX, y: e.clientY };
    state.panX += dx; state.panY += dy; setTransform();
  });
  window.addEventListener('mouseup', () => { isPanning = false; });
  els.canvasWrapper.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (state.drawing.activeTool) return; // 绘图模式下不触发滚轮

    // 如果按下了 Ctrl 键，则执行缩放操作
    if (e.ctrlKey) {
      const scale = Math.exp(-e.deltaY * 0.001);

      // 1. 获取鼠标相对于固定容器 (canvasWrapper) 的位置
      const wrapperRect = els.canvasWrapper.getBoundingClientRect();
      const mouseX = e.clientX - wrapperRect.left;
      const mouseY = e.clientY - wrapperRect.top;

      // 2. 计算鼠标指向的在画布上的“世界坐标”
      const worldX = (mouseX - state.panX) / state.zoom;
      const worldY = (mouseY - state.panY) / state.zoom;
      
      // 3. 更新缩放级别
      const newZoom = state.zoom * scale;
      
      // 4. 计算新的平移量，以确保“世界坐标”点在缩放后仍在鼠标下方
      state.panX = mouseX - worldX * newZoom;
      state.panY = mouseY - worldY * newZoom;
      state.zoom = newZoom;

    // 否则，执行上下滚动操作
    } else {
      // e.deltaY 在向下滚动时为正，向上滚动时为负
      // 我们从 panY 中减去它，以实现内容的自然滚动
      state.panY -= e.deltaY;
    }

    setTransform(); 
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
  const selector = 'p, img, table, thead, tbody, tr, pre, h1, h2, h3, h4, h5, h6, li, blockquote, code, figure, figcaption, math, svg, mjx-container';
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
    const thinkingIndicator = showThinkingIndicator(messagesEl);
    
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

      conversation.push({ role: res.role || 'assistant', text: res.text, htmlText: res.htmlText, timestamp: res.timestamp || Date.now() });
    } catch (err) {
      conversation.push({ role: 'assistant', text: '聊天服务不可用。', timestamp: Date.now() });
    } finally {
      hideThinkingIndicator(thinkingIndicator);
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
    
    if (m.role === 'assistant' && m.htmlText) {
      div.innerHTML = m.htmlText;
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

async function openNodeConversation(node) {
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
  els.canvas.appendChild(box);
  
  await renderMessages(messagesEl, node.conversation_log || []);

  const send = async () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      
      node.conversation_log.push({ role: 'user', text, displayText: text, timestamp: Date.now() });
      const currentConversationLength = node.conversation_log.length;
      await renderMessages(messagesEl, node.conversation_log);
      const thinkingIndicator = showThinkingIndicator(messagesEl);

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

          node.conversation_log.push({ role: res.role || 'assistant', text: res.text, htmlText: res.htmlText, timestamp: res.timestamp || Date.now() });
          await API.saveNode(state.documentId, node);
      } catch (err) {
          node.conversation_log.push({ role: 'assistant', text: '聊天服务不可用。', timestamp: Date.now() });
      } finally {
        hideThinkingIndicator(thinkingIndicator);
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
  els.contextSelectorContainer.classList.add('hidden');
  els.customRangeInputs.classList.add('hidden');
  
  await renderMessages(els.sidebarMessages, state.sidebarContext.conversation);
  
  els.sidebar.classList.remove('hidden');
  els.sidebarResizer.classList.remove('hidden');
}

function setupContextSelector(totalChars) {
    const CHUNK_SIZE = 8000;
    els.contextRangeSelect.innerHTML = '';
    
    const allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = `全文 (${totalChars}字)`;
    els.contextRangeSelect.appendChild(allOpt);

    for (let i = 0; i < totalChars; i += CHUNK_SIZE) {
        const start = i;
        const end = Math.min(i + CHUNK_SIZE, totalChars);
        const opt = document.createElement('option');
        opt.value = `${start}-${end}`;
        opt.textContent = `字 ${start + 1} - ${end}`;
        els.contextRangeSelect.appendChild(opt);
    }

    const customOpt = document.createElement('option');
    customOpt.value = 'custom';
    customOpt.textContent = '自定义范围...';
    els.contextRangeSelect.appendChild(customOpt);

    els.customStartChar.max = totalChars -1;
    els.customEndChar.max = totalChars;
    
    els.contextSelectorContainer.classList.remove('hidden');
}

async function loadDocument(id) {
  state.documentId = id;
  closeAllMicroChats();
  
  const currentDoc = state.documents.find(d => d.document_id === id);
  if (currentDoc && currentDoc.total_chars > 0) {
      setupContextSelector(currentDoc.total_chars);
  } else {
      els.contextSelectorContainer.classList.add('hidden');
  }
  els.customRangeInputs.classList.add('hidden');

  const html = await API.getDocHtml(id).catch(() => '<p style="color:#a00">无法加载文档</p>');
  els.docHtml.innerHTML = html;
  
  if (window.MathJax && window.MathJax.typesetPromise) {
    console.log('[MathJax Log] Attempting to typeset formulas in the main document content.');
    try {
      await window.MathJax.typesetPromise([els.docHtml]);
      console.log('[MathJax Log] Typesetting completed successfully for the main document.');
    } catch (err) {
      console.error('[MathJax Error] An error occurred during main document typesetting:', err);
    }
  } else {
    console.warn('[MathJax Log] MathJax library is not available.');
  }
  annotateAtoms();
  await loadNodes(id);
  await loadChats(id);
  await loadDrawings(id); // 新增: 加载绘图笔记
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

// 新增: 加载绘图笔记
async function loadDrawings(id) {
  try {
      const drawings = await API.getDrawings(id);
      state.drawing.paths = drawings || [];
  } catch (e) {
      console.error("无法加载绘图数据:", e);
      state.drawing.paths = [];
  }
  // 【新增】加载新绘图时，重置恢复栈并更新按钮状态
  state.drawing.redoStack = [];
  const updateUndoRedoButtonStates = els.undoBtn.disabled !== undefined ? () => {
      els.undoBtn.disabled = state.drawing.paths.length === 0;
      els.redoBtn.disabled = state.drawing.redoStack.length === 0;
  } : () => {};
  updateUndoRedoButtonStates();
  // 【新增结束】
  redrawDrawingCanvas();
}

async function refreshDocs() {
  const docs = await API.listDocs().catch(() => []);
  state.documents = docs; 
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
    showProcessingOverlay('正在上传 HTML...');
    try {
      await API.upload(f);
      await refreshDocs();
    } catch (err) {
      console.error("HTML upload failed", err);
      alert("HTML 上传失败: " + err.message);
    } finally {
      hideProcessingOverlay();
    }
  });

  els.uploadPdf.addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    showProcessingOverlay('正在解析 PDF，这可能需要一些时间...');
    let res;
    try {
      res = await API.uploadPdf(f);
      await refreshDocs();
      if (res && res.document_id) {
        els.select.value = res.document_id; 
        await loadDocument(res.document_id);
      }
    } catch (err)
 {
      console.error("PDF upload failed", err);
      alert("PDF 处理失败: " + err.message);
    } finally {
      hideProcessingOverlay();
    }
  });
  
  els.contextRangeSelect.addEventListener('change', (e) => {
      if (e.target.value === 'custom') {
          els.customRangeInputs.classList.remove('hidden');
      } else {
          els.customRangeInputs.classList.add('hidden');
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
    
    const currentDoc = state.documents.find(d => d.document_id === state.documentId);
    if (currentDoc && currentDoc.total_chars > 0) {
        els.contextSelectorContainer.classList.remove('hidden');
    }
    els.customRangeInputs.classList.add('hidden');
    els.contextRangeSelect.value = 'all';
    
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
      
      const payload = {
          document_id: state.documentId,
          messages: state.sidebarContext.conversation,
      };

      // 【关键修改】移除 isFirstTurn 判断，确保每次都检查上下文范围
      if (state.sidebarContext.mode === 'document') {
          const rangeSelection = els.contextRangeSelect.value;
          
          if (rangeSelection === 'custom') {
              const start = parseInt(els.customStartChar.value, 10);
              const end = parseInt(els.customEndChar.value, 10);
              const currentDoc = state.documents.find(d => d.document_id === state.documentId);
              const totalChars = currentDoc ? currentDoc.total_chars : Infinity;

              if (isNaN(start) || isNaN(end) || start < 0 || end <= start || end > totalChars) {
                  alert(`无效的自定义范围！\n\n请确保：\n- 起始和结束都已填写\n- 结束字数 > 起始字数\n- 范围在文档总字数 (${totalChars}) 之内`);
                  state.sidebarContext.conversation.pop();
                  return;
              }
              payload.char_start = start;
              payload.char_end = end;

          } else if (rangeSelection !== 'all') {
              const [start, end] = rangeSelection.split('-').map(Number);
              payload.char_start = start;
              payload.char_end = end;
          }
      }
      
      await renderMessages(els.sidebarMessages, state.sidebarContext.conversation);
      const thinkingIndicator = showThinkingIndicator(els.sidebarMessages);

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

          state.sidebarContext.conversation.push({ role: res.role || 'assistant', text: res.text, htmlText: res.htmlText,  timestamp: res.timestamp || Date.now() });
          
          if (state.sidebarContext.mode === 'document') {
              const activeChat = state.chats.find(c => c.id === state.activeChatId);
              if (activeChat) {
                  activeChat.messages = state.sidebarContext.conversation;
                  await API.saveChat(state.documentId, activeChat);
              }
          }
      } catch (err) {
          state.sidebarContext.conversation.push({ role: 'assistant', text: '聊天服务不可用。', timestamp: Date.now() });
      } finally {
        hideThinkingIndicator(thinkingIndicator);
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

// =====================================================================
// 新增: 绘图功能初始化 (已集成撤销/恢复功能)
// =====================================================================
function initDrawing() {
  let saveTimeout;

  // 防抖保存函数
  const debouncedSaveDrawings = () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
          if (state.documentId) {
              API.saveDrawings(state.documentId, state.drawing.paths).catch(err => {
                  console.error("保存绘图笔记失败:", err);
              });
          }
      }, 1500); // 1.5秒后自动保存
  };
  
  // 【新增】更新撤销/恢复按钮的可用状态
  const updateUndoRedoButtonStates = () => {
      els.undoBtn.disabled = state.drawing.paths.length === 0;
      els.redoBtn.disabled = state.drawing.redoStack.length === 0;
  };
  
  // 【新增】撤销上一步操作
  const undoLastPath = () => {
      if (state.drawing.paths.length > 0) {
          const lastPath = state.drawing.paths.pop();
          state.drawing.redoStack.push(lastPath);
          redrawDrawingCanvas();
          debouncedSaveDrawings();
          updateUndoRedoButtonStates();
      }
  };

  // 【新增】恢复上一步撤销的操作
  const redoLastPath = () => {
      if (state.drawing.redoStack.length > 0) {
          const pathToRedo = state.drawing.redoStack.pop();
          state.drawing.paths.push(pathToRedo);
          redrawDrawingCanvas();
          debouncedSaveDrawings();
          updateUndoRedoButtonStates();
      }
  };

  // 将鼠标屏幕坐标转换为画布世界坐标
  const getTransformedCoords = (e) => {
      const rect = els.drawingCanvas.getBoundingClientRect();
      return {
          x: (e.clientX - rect.left - state.panX) / state.zoom,
          y: (e.clientY - rect.top - state.panY) / state.zoom
      };
  };

  // 工具栏事件监听
  els.toolBtns.forEach(btn => {
      btn.addEventListener('click', () => {
          // 【修改】确保撤销/恢复按钮不激活工具状态
          if (btn.id === 'undoBtn' || btn.id === 'redoBtn') return;
          
          const tool = btn.dataset.tool;
          if (state.drawing.activeTool === tool) {
              state.drawing.activeTool = null;
              btn.classList.remove('active');
              els.drawingCanvas.classList.remove('active');
          } else {
              state.drawing.activeTool = tool;
              els.toolBtns.forEach(b => b.classList.remove('active'));
              btn.classList.add('active');
              els.drawingCanvas.classList.add('active');

              if (tool === 'highlighter') {
                  els.strokeWidth.value = 30;
              } else if (tool === 'eraser') {
                  els.strokeWidth.value = 25;
              }
              els.strokeWidth.dispatchEvent(new Event('input'));
          }
      });
  });

  els.colorPicker.addEventListener('input', (e) => {
      state.drawing.color = e.target.value;
  });

  els.strokeWidth.addEventListener('input', (e) => {
      const width = parseInt(e.target.value, 10);
      state.drawing.strokeWidth = width;
      els.strokeWidthValue.textContent = width;
  });

  // 绘图Canvas鼠标事件
  const handleMouseDown = (e) => {
      if (!state.drawing.activeTool || e.button !== 0) return;
      state.drawing.isDrawing = true;
      
      const startPoint = getTransformedCoords(e);
      state.drawing.currentPath = {
          tool: state.drawing.activeTool,
          color: state.drawing.color,
          width: state.drawing.strokeWidth,
          points: [startPoint]
      };
  };

  const handleMouseMove = (e) => {
      if (!state.drawing.isDrawing || !state.drawing.currentPath) return;
      
      const point = getTransformedCoords(e);
      state.drawing.currentPath.points.push(point);
      
      redrawDrawingCanvas();
  };

  const handleMouseUp = () => {
      if (!state.drawing.isDrawing || !state.drawing.currentPath) return;
      
      state.drawing.isDrawing = false;
      if (state.drawing.currentPath.points.length > 1) {
          state.drawing.paths.push(state.drawing.currentPath);
          // 【修改】当用户绘制新的笔迹时，清空恢复栈
          state.drawing.redoStack = []; 
      }
      state.drawing.currentPath = null;
      
      debouncedSaveDrawings();
      updateUndoRedoButtonStates(); // 【新增】更新按钮状态
  };
  
  els.drawingCanvas.addEventListener('mousedown', handleMouseDown);
  els.drawingCanvas.addEventListener('mousemove', handleMouseMove);
  els.drawingCanvas.addEventListener('mouseup', handleMouseUp);
  els.drawingCanvas.addEventListener('mouseleave', handleMouseUp);

  // 【新增】为新按钮添加点击事件监听
  els.undoBtn.addEventListener('click', undoLastPath);
  els.redoBtn.addEventListener('click', redoLastPath);

  // 【新增】增加键盘快捷键支持
  window.addEventListener('keydown', (e) => {
      // 避免在输入框中触发
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
          return;
      }

      const isCtrl = e.ctrlKey || e.metaKey; // 支持 Windows (Ctrl) 和 Mac (Cmd)
      if (isCtrl && e.key === 'z') {
          e.preventDefault();
          undoLastPath();
      }
      if (isCtrl && e.key === 'y') {
          e.preventDefault();
          redoLastPath();
      }
  });

  window.addEventListener('resize', redrawDrawingCanvas);
  updateUndoRedoButtonStates(); // 【新增】初始化按钮状态
}

function boot() {
  initPanZoom();
  initUI();
  initSidebar();
  initSidebarChat();
  initSidebarDropZone();
  initDrawing(); // 新增: 初始化绘图功能
  
  const wrapper = els.canvasWrapper.getBoundingClientRect();
  state.panX = (wrapper.width - 920) / 2;
  state.panY = 60;
  setTransform();
  
  els.sidebar.classList.add('hidden');
  els.sidebarResizer.classList.add('hidden');
  
  refreshDocs();
}

boot();