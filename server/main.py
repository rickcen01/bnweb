# server/main.py

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
import zipfile
import tempfile

import markdown2
from google import genai
import html2text

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Import MinerU gradio pipeline helpers directly
import sys
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
CHATS_DIR = os.path.join(DATA_DIR, 'chats')
WEB_DIR = os.path.join(ROOT_DIR, 'web')

os.makedirs(DOCS_DIR, exist_ok=True)
os.makedirs(NODES_DIR, exist_ok=True)
os.makedirs(CHATS_DIR, exist_ok=True)


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
    source_element_html: Optional[str] = None


class ChatSession(BaseModel):
    id: str
    name: str
    messages: List[Message]


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
# 【结构修改】静态文件服务现在直接指向DOCS_DIR，以支持子文件夹访问
app.mount("/api/documents_assets", StaticFiles(directory=DOCS_DIR), name="documents_assets")


@app.get("/api/documents")
def list_documents() -> List[Dict[str, Any]]:
    docs = []
    # 【结构修改】现在遍历documents目录下的子文件夹作为每个文档的标识
    for fname in os.listdir(DOCS_DIR):
        path = os.path.join(DOCS_DIR, fname)
        if os.path.isdir(path):
            docs.append({
                'document_id': fname, # document_id 现在是文件夹名
                'title': fname,
            })
    return docs


@app.get("/api/document/{document_id}", response_class=HTMLResponse)
def get_document(document_id: str):
    # 【结构修改】HTML文件路径现在是 {document_id}/{document_id}.html
    html_filename = f"{document_id}.html"
    path = os.path.join(DOCS_DIR, document_id, html_filename)
    if not os.path.isfile(path):
        raise HTTPException(404, detail="Document not found")
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


@app.post("/api/upload")
def upload_document(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(('.html', '.htm')):
        raise HTTPException(400, detail="Only HTML documents are supported")
    # 为了兼容性，普通HTML上传仍然放在根目录，不创建子文件夹
    dest = os.path.join(DOCS_DIR, file.filename)
    with open(dest, 'wb') as f:
        f.write(file.file.read())
    return {"status": "ok", "document_id": file.filename}


@app.post("/api/upload-pdf")
async def upload_pdf(file: UploadFile = File(...), max_pages: int = 200, backend: str = 'pipeline', language: str = 'ch'):
    if not file.filename.lower().endswith('.pdf'):
        raise HTTPException(400, detail="Only PDF is supported")

    tmp_dir = os.path.join(DATA_DIR, 'tmp')
    os.makedirs(tmp_dir, exist_ok=True)
    tmp_pdf_path = os.path.join(tmp_dir, f"{uuid.uuid4().hex}.pdf")
    with open(tmp_pdf_path, 'wb') as f:
        shutil.copyfileobj(file.file, f)

    if to_markdown is None:
        raise HTTPException(500, detail="MinerU not available in server environment")

    archive_zip_path = None
    try:
        md_content_from_mineru, md_text, archive_zip_path, preview_pdf_path = await to_markdown(
            tmp_pdf_path, end_pages=max_pages, is_ocr=False, formula_enable=True,
            table_enable=True, language=language, backend=backend, url=None,
        )
    except Exception as e:
        raise HTTPException(500, detail=f"MinerU conversion failed: {e}")
    finally:
        if os.path.exists(tmp_pdf_path):
            os.remove(tmp_pdf_path)

    # 【结构修改】这个名字现在是文档的父文件夹名，也是document_id
    doc_foldername = f"{Path(file.filename).stem}_{int(time.time())}"
    doc_dir = os.path.join(DOCS_DIR, doc_foldername)
    os.makedirs(doc_dir)

    html_filename = f"{doc_foldername}.html"
    md_filename = f"{doc_foldername}.md"
    
    md_content_for_html = md_content_from_mineru
    found_media_dir_name = None

    if archive_zip_path and os.path.exists(archive_zip_path):
        with tempfile.TemporaryDirectory() as temp_extract_dir:
            with zipfile.ZipFile(archive_zip_path, 'r') as zip_ref:
                zip_ref.extractall(temp_extract_dir)

            source_md_path = None
            for root, dirs, files in os.walk(temp_extract_dir):
                for f in files:
                    if f.endswith('.md'):
                        source_md_path = os.path.join(root, f)
                        break
                if source_md_path:
                    break
            
            if source_md_path:
                md_dir = os.path.dirname(source_md_path)
                source_media_path = None
                
                potential_images_path = os.path.join(md_dir, 'images')
                potential_assets_path = os.path.join(md_dir, 'assets')

                if os.path.isdir(potential_images_path):
                    source_media_path = potential_images_path
                    found_media_dir_name = 'images'
                elif os.path.isdir(potential_assets_path):
                    source_media_path = potential_assets_path
                    found_media_dir_name = 'assets'
                
                if found_media_dir_name:
                    with open(source_md_path, 'r', encoding='utf-8') as f:
                        clean_md_content = f.read()
                    
                    md_content_for_html = clean_md_content

                    # 【结构修改】MD文件中的路径应该是相对于它自己的文件夹，所以就是 'images/...'
                    # 无需替换，原始路径 'images/...' 就是正确的
                    md_for_ai_out_path = os.path.join(doc_dir, md_filename)
                    with open(md_for_ai_out_path, 'w', encoding='utf-8') as f:
                        f.write(clean_md_content) # 直接写入纯净的MD内容

                    # 【结构修改】将图片文件夹移动到新创建的文档专属文件夹下，并命名为 'images'
                    target_images_path = os.path.join(doc_dir, 'images')
                    shutil.move(source_media_path, target_images_path)

    if found_media_dir_name:
        # 【结构修改】将HTML引用的路径替换为服务器可访问的绝对URL路径
        web_accessible_path = f"/api/documents_assets/{doc_foldername}/images/"
        md_content_for_html = md_content_for_html.replace(f"]({found_media_dir_name}/", f"]({web_accessible_path}")

    html_for_frontend = markdown2.markdown(md_content_for_html, extras=["fenced-code-blocks", "tables"])
    html_out_path = os.path.join(doc_dir, html_filename)
    with open(html_out_path, 'w', encoding='utf-8') as f:
        f.write(html_for_frontend)
    
    if archive_zip_path and os.path.exists(archive_zip_path):
        os.remove(archive_zip_path)

    return {"status": "ok", "document_id": doc_foldername}


def _nodes_path(document_id: str) -> str:
    # 节点和聊天记录的JSON文件仍然存储在独立的目录中，不受影响
    return os.path.join(NODES_DIR, f"{document_id}.json")


def _read_nodes(document_id: str) -> List[Dict[str, Any]]:
    path = _nodes_path(document_id)
    if not os.path.exists(path): return []
    with open(path, 'r', encoding='utf-8') as f:
        try: return json.load(f)
        except Exception: return []


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
            nodes[i] = node.model_dump(); found = True; break
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

def _chats_path(document_id: str) -> str:
    return os.path.join(CHATS_DIR, f"{document_id}.json")

def _read_chats(document_id: str) -> List[Dict[str, Any]]:
    path = _chats_path(document_id)
    if not os.path.exists(path): return []
    with open(path, 'r', encoding='utf-8') as f:
        try: return json.load(f)
        except Exception: return []

def _write_chats(document_id: str, chats: List[Dict[str, Any]]):
    path = _chats_path(document_id)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(chats, f, ensure_ascii=False, indent=2)

@app.get("/api/chats/{document_id}", response_model=List[ChatSession])
def list_chats(document_id: str):
    return _read_chats(document_id)

@app.post("/api/chats/{document_id}")
def save_chat(document_id: str, chat: ChatSession):
    chats = _read_chats(document_id)
    found = False
    for i, c in enumerate(chats):
        if c.get('id') == chat.id:
            chats[i] = chat.model_dump(); found = True; break
    if not found:
        chats.append(chat.model_dump())
    _write_chats(document_id, chats)
    return {"status": "ok", "id": chat.id}

@app.delete("/api/chats/{document_id}/{chat_id}")
def delete_chat(document_id: str, chat_id: str):
    chats = _read_chats(document_id)
    chats = [c for c in chats if c.get('id') != chat_id]
    _write_chats(document_id, chats)
    return {"status": "ok"}


class ChatRequest(BaseModel):
    document_id: str
    messages: List[Message]
    source_element_id: Optional[str] = None
    source_element_html: Optional[str] = None
    selected_elements_html: Optional[List[str]] = None


GEMINI_API_KEY = os.environ.get("GOOGLE_API_KEY")

@app.post("/api/chat")
def chat(req: ChatRequest):
    last_user_message = next((m for m in reversed(req.messages) if m.role == 'user'), None)
    if not last_user_message:
        raise HTTPException(status_code=400, detail="No user message found")
    
    if not GEMINI_API_KEY:
        response_text = (
            f"[stub] 理解你的问题是: '{last_user_message.text}'"
            "。请设置 GOOGLE_API_KEY 环境变量以启用 Gemini AI。"
        )
        return {"role": "assistant", "text": response_text, "timestamp": time.time()}

    try:
        client = genai.Client(api_key=GEMINI_API_KEY)

        # 【结构修改】MD文件路径现在也基于document_id子文件夹
        md_filename = f"{req.document_id}.md"
        md_filepath = os.path.join(DOCS_DIR, req.document_id, md_filename)
        
        full_doc_md = ""
        if os.path.exists(md_filepath):
            with open(md_filepath, 'r', encoding='utf-8') as f:
                full_doc_md = f.read()
        else:
            full_doc_md = "[无法找到完整的Markdown文档上下文]"
            print(f"警告: 在路径 {md_filepath} 未找到对应的Markdown文件")

        h = html2text.HTML2Text()
        h.ignore_links = True
        
        focused_content_md = ""
        
        if req.selected_elements_html:
            md_parts = []
            for i, html_chunk in enumerate(req.selected_elements_html):
                element_md = h.handle(html_chunk)
                md_parts.append(f"--- 选中内容 {i+1} ---\n{element_md}")
            focused_content_md = "\n".join(md_parts)
        
        elif req.source_element_html:
            focused_content_md = h.handle(req.source_element_html)
        
        if focused_content_md:
            print("\n" + "+-"*28 + "+")
            print("|| CONVERTED MARKDOWN FROM SELECTED ELEMENTS SENT TO MODEL: ||")
            print("+-"*28 + "+")
            print(focused_content_md)
            print("+-"*28 + "+\n")

        server_history = []
        
        context_prompt_parts = [
            "你是一个教育与知识解释助手，擅长解析文档内容并结合上下文回答问题。",
            "我会给你提供[全文Markdown内容]作为主要背景，可能还会提供一段或多段用户当前聚焦的[聚焦内容]。",
            "你的任务是：优先基于[聚焦内容]回答问题，并结合[全文Markdown内容]提供必要的上下文信息。如果问题涉及多个[聚焦内容]，请综合它们进行回答。如果问题需要推导或分析，请分步骤展示推理过程。",
            "---",
            "[全文Markdown内容]",
            full_doc_md
        ]

        if focused_content_md:
            context_prompt_parts.extend([
                "\n---",
                "[聚焦内容]",
                focused_content_md
            ])
        
        full_context_string = "\n".join(context_prompt_parts)
        server_history.append({'role': 'user', 'parts': [{'text': full_context_string}]})
        server_history.append({'role': 'model', 'parts': [{'text': "好的，上下文已收到。请开始提问。"}]})

        for msg in req.messages:
            role = 'model' if msg.role == 'assistant' else 'user'
            server_history.append({'role': role, 'parts': [{'text': msg.text}]})
        
        last_user_message_for_model = server_history.pop()

        chat_session = client.chats.create(
            model="gemini-2.5-flash",
            history=server_history
        )

        prompt = last_user_message_for_model['parts'][0]['text']
        
        print("\n" + "="*50)
        print("====== V V V ====== SENDING TO GEMINI API ====== V V V ======")
        print(">>> CONVERSATION HISTORY (for model context):")
        print(json.dumps(server_history, ensure_ascii=False, indent=2))
        print("\n>>> CURRENT USER PROMPT:")
        print(prompt)
        print("====== ^ ^ ^ ====== END OF GEMINI API INPUT ====== ^ ^ ^ ======")
        print("="*50 + "\n")

        response = chat_session.send_message(prompt)

        response_dict = {}
        try:
            response_dict = type(response).to_dict(response)
        except Exception:
            try:
                response_dict = json.loads(str(response))
            except Exception:
                response_dict = {"raw_string_representation": str(response)}

        print("\n" + "="*50)
        print("====== V V V ====== GEMINI API FULL RESPONSE ====== V V V ======")
        print(json.dumps(response_dict, ensure_ascii=False, indent=2))
        print("====== ^ ^ ^ ====== END OF FULL RESPONSE ====== ^ ^ ^ ======")
        print("="*50 + "\n")

        ai_response_text = response.text

    except Exception as e:
        print(f"调用 Gemini API 时出错: {e}")
        import traceback
        traceback.print_exc()
        ai_response_text = f"调用AI服务时出错: {e}"

    return {"role": "assistant", "text": ai_response_text, "timestamp": time.time()}