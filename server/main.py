from fastapi import FastAPI, UploadFile, File, Form
from fastapi import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import os
import json
import time
import uuid
import shutil
from pathlib import Path

import markdown2
from google import genai  # 使用 google-genai 库
import html2text

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Import MinerU gradio pipeline helpers directly
import sys
# Expect folder structure: D:/mineru2/nbweb (this file), sibling D:/mineru2/MinerU
MINERU_DIR = os.path.join(os.path.dirname(ROOT_DIR), 'MinerU')
if MINERU_DIR not in sys.path:
    sys.path.insert(0, MINERU_DIR)
try:
    from mineru.cli.gradio_app import to_markdown
except Exception:
    to_markdown = None
DATA_DIR = os.path.join(ROOT_DIR, 'data')
DOCS_DIR = os.path.join(DATA_DIR, 'documents')
NODES_DIR = os.path.join(DATA_DIR, 'nodes')
WEB_DIR = os.path.join(ROOT_DIR, 'web')

os.makedirs(DOCS_DIR, exist_ok=True)
os.makedirs(NODES_DIR, exist_ok=True)


class Message(BaseModel):
    role: str
    text: str
    timestamp: float


class CanvasPosition(BaseModel):
    x: float
    y: float
    zoom_level: float


class KnowledgeNode(BaseModel):
    node_id: str
    document_id: str
    source_element_id: str
    canvas_position: CanvasPosition
    conversation_log: List[Message]
    user_annotations: Optional[str] = None


app = FastAPI(title="nbweb backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return JSONResponse({"status": "ok"})

@app.get("/", response_class=HTMLResponse)
def index():
    index_path = os.path.join(WEB_DIR, 'index.html')
    if not os.path.exists(index_path):
        raise HTTPException(500, detail="index.html missing")
    with open(index_path, 'r', encoding='utf-8') as f:
        return f.read()


app.mount("/web", StaticFiles(directory=WEB_DIR), name="web")


@app.get("/api/documents")
def list_documents() -> List[Dict[str, Any]]:
    docs = []
    for fname in os.listdir(DOCS_DIR):
        if not fname.lower().endswith(('.html', '.htm')):
            continue
        path = os.path.join(DOCS_DIR, fname)
        docs.append({
            'document_id': fname,
            'title': os.path.splitext(fname)[0],
        })
    return docs


@app.get("/api/document/{document_id}", response_class=HTMLResponse)
def get_document(document_id: str):
    path = os.path.join(DOCS_DIR, document_id)
    if not os.path.isfile(path):
        raise HTTPException(404, detail="Document not found")
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


@app.post("/api/upload")
def upload_document(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(('.html', '.htm')):
        raise HTTPException(400, detail="Only HTML documents are supported")
    dest = os.path.join(DOCS_DIR, file.filename)
    with open(dest, 'wb') as f:
        f.write(file.file.read())
    return {"status": "ok", "document_id": file.filename}


@app.post("/api/upload-pdf")
async def upload_pdf(file: UploadFile = File(...), max_pages: int = 200, backend: str = 'pipeline', language: str = 'ch'):
    if not file.filename.lower().endswith('.pdf'):
        raise HTTPException(400, detail="Only PDF is supported")

    # Save temp PDF
    tmp_dir = os.path.join(DATA_DIR, 'tmp')
    os.makedirs(tmp_dir, exist_ok=True)
    tmp_pdf_path = os.path.join(tmp_dir, f"{uuid.uuid4().hex}.pdf")
    with open(tmp_pdf_path, 'wb') as f:
        shutil.copyfileobj(file.file, f)

    if to_markdown is None:
        raise HTTPException(500, detail="MinerU not available in server environment")

    try:
        md_content, md_text, archive_zip_path, preview_pdf_path = await to_markdown(
            tmp_pdf_path,
            end_pages=max_pages,
            is_ocr=False,
            formula_enable=True,
            table_enable=True,
            language=language,
            backend=backend,
            url=None,
        )
    except Exception as e:
        raise HTTPException(500, detail=f"MinerU conversion failed: {e}")
    finally:
        try:
            os.remove(tmp_pdf_path)
        except Exception:
            pass

    # Convert markdown (already includes inline base64 images possibly) to HTML
    html = markdown2.markdown(md_content, extras=["fenced-code-blocks", "tables"])

    # Store HTML in documents dir
    title = f"{Path(file.filename).stem}_{int(time.time())}.html"
    out_path = os.path.join(DOCS_DIR, title)
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(html)

    return {"status": "ok", "document_id": title}


def _nodes_path(document_id: str) -> str:
    return os.path.join(NODES_DIR, f"{document_id}.json")


def _read_nodes(document_id: str) -> List[Dict[str, Any]]:
    path = _nodes_path(document_id)
    if not os.path.exists(path):
        return []
    with open(path, 'r', encoding='utf-8') as f:
        try:
            return json.load(f)
        except Exception:
            return []


def _write_nodes(document_id: str, nodes: List[Dict[str, Any]]):
    path = _nodes_path(document_id)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(nodes, f, ensure_ascii=False, indent=2)


@app.get("/api/nodes/{document_id}")
def list_nodes(document_id: str) -> List[Dict[str, Any]]:
    return _read_nodes(document_id)


@app.post("/api/nodes/{document_id}")
def create_or_update_node(document_id: str, node: KnowledgeNode):
    nodes = _read_nodes(document_id)
    found = False
    for i, n in enumerate(nodes):
        if n.get('node_id') == node.node_id:
            nodes[i] = node.model_dump()
            found = True
            break
    if not found:
        nodes.append(node.model_dump())
    _write_nodes(document_id, nodes)
    return {"status": "ok", "node_id": node.node_id}


@app.delete("/api/nodes/{document_id}/{node_id}")
def delete_node(document_id: str, node_id: str):
    nodes = _read_nodes(document_id)
    nodes = [n for n in nodes if n.get('node_id') != node_id]
    _write_nodes(document_id, nodes)
    return {"status": "ok"}


class ChatRequest(BaseModel):
    document_id: str
    source_element_id: str
    messages: List[Message]
    source_element_html: str
    full_document_html: str

# 从环境变量中读取 Gemini API 密钥
GEMINI_API_KEY = os.environ.get("GOOGLE_API_KEY")

@app.post("/api/chat")
def chat(req: ChatRequest):
    last_user_message = next((m for m in reversed(req.messages) if m.role == 'user'), None)
    if not last_user_message:
        raise HTTPException(status_code=400, detail="No user message found")
    
    user_question = last_user_message.text

    # 如果未配置 Gemini API 密钥，则返回占位回复
    if not GEMINI_API_KEY:
        response_text = (
            f"[stub] 我理解到你在该位置提出的问题是：{user_question}"
            "。当前返回为本地占位回复。请设置 GOOGLE_API_KEY 环境变量以启用 Gemini AI。"
        )
        return {
            "role": "assistant",
            "text": response_text,
            "timestamp": time.time(),
        }

    try:
        # 将接收到的 HTML 转换为 Markdown 以便AI更好地理解
        h = html2text.HTML2Text()
        h.ignore_links = True
        element_md = h.handle(req.source_element_html)
        full_doc_md = h.handle(req.full_document_html)

        # 构建发送给 Gemini 的提示
        prompt = f"""
你是一个智能问答助手。请根据以下提供的完整文档内容和用户当前聚焦的特定元素内容，来回答用户的问题。

[完整文档内容]
---
{full_doc_md}
---

[用户聚焦的元素内容]
---
{element_md}
---

[用户问题]
{user_question}

请根据上述信息，用中文回答用户的问题。
"""
        # --- 新增日志：打印发送给AI的完整提示 ---
        print("\n" + "="*50)
        print("====== V V V ====== SENDING TO GEMINI API ====== V V V ======")
        print(prompt)
        print("====== ^ ^ ^ ====== END OF GEMINI API INPUT ====== ^ ^ ^ ======")
        print("="*50 + "\n")
        # 严格按照用户指定的格式调用 Gemini API
        client = genai.Client(api_key=GEMINI_API_KEY)
        response = client.models.generate_content(
            model="gemini-2.5-flash",  # 使用推荐的模型标识符
            contents=prompt,
        )
        
        ai_response_text = response.text
        print("\n" + "="*50)
        print("====== V V V ====== RECEIVED FROM GEMINI API ====== V V V ======")
        print(response)
        print("====== ^ ^ ^ ====== END OF GEMINI API OUTPUT ====== ^ ^ ^ ======")
        print("="*50 + "\n")
        
        ai_response_text = response.text
    except Exception as e:
        print(f"Error calling Gemini API: {e}")
        ai_response_text = f"调用AI服务时出错: {e}"

    return {
        "role": "assistant",
        "text": ai_response_text,
        "timestamp": time.time(),
    }