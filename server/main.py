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
# 【新增】允许直接访问documents目录，以便HTML能加载图片
app.mount("/api/documents_assets", StaticFiles(directory=DOCS_DIR), name="documents_assets")


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

    tmp_dir = os.path.join(DATA_DIR, 'tmp')
    os.makedirs(tmp_dir, exist_ok=True)
    tmp_pdf_path = os.path.join(tmp_dir, f"{uuid.uuid4().hex}.pdf")
    with open(tmp_pdf_path, 'wb') as f:
        shutil.copyfileobj(file.file, f)

    if to_markdown is None:
        raise HTTPException(500, detail="MinerU not available in server environment")

    try:
        # md_content_b64: 这是包含Base64图片的版本，用于生成自包含的HTML
        # archive_zip_path: 这是包含干净MD和图片文件的压缩包路径
        md_content_b64, md_text, archive_zip_path, preview_pdf_path = await to_markdown(
            tmp_pdf_path, end_pages=max_pages, is_ocr=False, formula_enable=True,
            table_enable=True, language=language, backend=backend, url=None,
        )
    except Exception as e:
        raise HTTPException(500, detail=f"MinerU conversion failed: {e}")
    finally:
        if os.path.exists(tmp_pdf_path):
            os.remove(tmp_pdf_path)

    base_filename = f"{Path(file.filename).stem}_{int(time.time())}"
    html_document_id = f"{base_filename}.html"

    # --- 任务1: 生成用于前端展示的、自包含的HTML (使用Base64图片) ---
    html_for_frontend = markdown2.markdown(md_content_b64, extras=["fenced-code-blocks", "tables"])
    html_out_path = os.path.join(DOCS_DIR, html_document_id)
    with open(html_out_path, 'w', encoding='utf-8') as f:
        f.write(html_for_frontend)

    # --- 任务2: 处理压缩包，生成用于AI的、干净的Markdown (使用图片路径) ---
    if archive_zip_path and os.path.exists(archive_zip_path):
        with tempfile.TemporaryDirectory() as temp_extract_dir:
            # 解压文件
            with zipfile.ZipFile(archive_zip_path, 'r') as zip_ref:
                zip_ref.extractall(temp_extract_dir)

            source_md_path = None
            source_assets_path = None
            # 寻找解压出来的.md文件和assets目录
            for root, dirs, files in os.walk(temp_extract_dir):
                for f in files:
                    if f.endswith('.md'):
                        source_md_path = os.path.join(root, f)
                if 'assets' in dirs:
                    source_assets_path = os.path.join(root, 'assets')
            
            if source_md_path:
                # 定义目标文件和目录名
                md_for_ai_filename = f"{base_filename}.md"
                target_assets_dirname = f"{base_filename}_assets"
                
                # 读取干净的MD内容
                with open(source_md_path, 'r', encoding='utf-8') as f:
                    clean_md_content = f.read()

                # 将MD中的 "assets/" 路径替换为新的、唯一的资源路径名
                # 这是关键一步，确保图片链接正确且不冲突
                # 注意图片链接格式是 `](assets/...`
                updated_md_content = clean_md_content.replace("](assets/", f"]({target_assets_dirname}/")

                # 保存更新后的、干净的MD文件
                md_for_ai_out_path = os.path.join(DOCS_DIR, md_for_ai_filename)
                with open(md_for_ai_out_path, 'w', encoding='utf-8') as f:
                    f.write(updated_md_content)

                # 如果有图片，将assets目录移动并重命名到documents目录下
                if source_assets_path and os.path.isdir(source_assets_path):
                    target_assets_path = os.path.join(DOCS_DIR, target_assets_dirname)
                    shutil.move(source_assets_path, target_assets_path)
    
    # 清理mineru生成的zip文件
    if archive_zip_path and os.path.exists(archive_zip_path):
        os.remove(archive_zip_path)

    return {"status": "ok", "document_id": html_document_id}


def _nodes_path(document_id: str) -> str:
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


class ChatRequest(BaseModel):
    document_id: str
    source_element_id: str
    messages: List[Message]
    source_element_html: str


GEMINI_API_KEY = os.environ.get("GOOGLE_API_KEY")

@app.post("/api/chat")
def chat(req: ChatRequest):
    last_user_message = next((m for m in reversed(req.messages) if m.role == 'user'), None)
    if not last_user_message:
        raise HTTPException(status_code=400, detail="No user message found")
    
    user_question = last_user_message.text

    if not GEMINI_API_KEY:
        response_text = (
            f"[stub] 我理解到你在该位置提出的问题是：{user_question}"
            "。当前返回为本地占位回复。请设置 GOOGLE_API_KEY 环境变量以启用 Gemini AI。"
        )
        return {"role": "assistant", "text": response_text, "timestamp": time.time()}

    try:
        h = html2text.HTML2Text()
        h.ignore_links = True
        element_md = h.handle(req.source_element_html)
        
        # 根据HTML文件名 (e.g., "doc_123.html") 推导出对应的MD文件名 ("doc_123.md")
        md_filename = Path(req.document_id).with_suffix('.md').name
        md_filepath = os.path.join(DOCS_DIR, md_filename)
        
        full_doc_md = ""
        if os.path.exists(md_filepath):
            with open(md_filepath, 'r', encoding='utf-8') as f:
                full_doc_md = f.read()
        else:
            full_doc_md = "[无法找到完整的Markdown文档上下文]"
            print(f"警告: 在路径 {md_filepath} 未找到对应的Markdown文件")

        prompt = f"""
你是一个教育与知识解释助手，擅长解析文档内容并结合上下文回答问题。

我会给你三部分信息：
1. 文档全文的 Markdown 内容（可能包含文字、公式、图片、表格）
2. 用户在文档中选中的“聚焦内容”
3. 用户提出的问题

你的任务是：
- 优先基于“聚焦内容”回答问题
- 结合全文内容补充必要的上下文信息
- 如果问题需要推导或分析，分步骤展示推理过程
- 如果无法从文档中找到答案，请明确说明，并避免编造
- 如果涉及翻译，请保持原意并尽量符合目标语言的表达习惯
- 如果用户要求用特定风格（如幽默、鲁迅风格），请保持该风格

以下是输入信息：

[全文Markdown内容]
{full_doc_md}

[聚焦内容]
{element_md}

[用户问题]
{user_question}

请基于以上信息，给出清晰、准确且结构化的回答。

"""
        print("\n" + "="*50)
        print("====== V V V ====== SENDING TO GEMINI API ====== V V V ======")
        print(prompt)  # 打印全部
        print("====== ^ ^ ^ ====== END OF GEMINI API INPUT ====== ^ ^ ^ ======")
        print("="*50 + "\n")


        client = genai.Client(api_key=GEMINI_API_KEY)
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
        )
        # ==== 新增：打印 AI 完整返回 ====
        import json
        try:
            response_dict = response.to_dict()  # SDK 提供的结构化输出
        except Exception:
            try:
                response_dict = json.loads(str(response))
            except Exception:
                response_dict = {"raw": str(response)}

        print("\n" + "="*50)
        print("====== V V V ====== GEMINI API FULL JSON ====== V V V ======")
        print(json.dumps(response_dict, ensure_ascii=False, indent=2))
        print("====== ^ ^ ^ ====== END OF FULL JSON ====== ^ ^ ^ ======")
        print("="*50 + "\n")
        ai_response_text = response.text
    except Exception as e:
        print(f"Error calling Gemini API: {e}")
        ai_response_text = f"调用AI服务时出错: {e}"

    return {"role": "assistant", "text": ai_response_text, "timestamp": time.time()}

