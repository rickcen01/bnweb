# server/main.py
import re 
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
import requests
import io

import markdown
from google import genai
from google.genai import types
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
    displayText: Optional[str] = None

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
app.mount("/api/documents_assets", StaticFiles(directory=DOCS_DIR), name="documents_assets")


@app.get("/api/documents")
def list_documents() -> List[Dict[str, Any]]:
    docs = []
    for fname in os.listdir(DOCS_DIR):
        path = os.path.join(DOCS_DIR, fname)
        if os.path.isdir(path):
            docs.append({
                'document_id': fname,
                'title': fname,
            })
    return docs


@app.get("/api/document/{document_id}", response_class=HTMLResponse)
def get_document(document_id: str):
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
                    md_for_ai_out_path = os.path.join(doc_dir, md_filename)
                    with open(md_for_ai_out_path, 'w', encoding='utf-8') as f:
                        f.write(clean_md_content)
                    
                    target_images_path = os.path.join(doc_dir, 'images')
                    shutil.move(source_media_path, target_images_path)

    if found_media_dir_name:
        web_accessible_path = f"/api/documents_assets/{doc_foldername}/images/"
        search_string = f'src="{found_media_dir_name}/'
        replace_string = f'src="{web_accessible_path}'
        md_content_for_html = md_content_for_html.replace(search_string, replace_string)
    # 【增加日志】在转换前打印Markdown内容的片段
    print("\n" + "="*20 + " [Markdown Conversion Log] " + "="*20)
    print("--- Markdown content snippet BEFORE conversion ---")
    # 为了避免日志过长，我们只打印前1000个字符
    print(md_content_for_html[:1000] + "...")
    print("-" * 50)

    html_for_frontend = markdown.markdown(
        md_content_for_html,
        extensions=[
            'tables',          # 启用表格
            'fenced_code',     # 启用代码块
            'nl2br',           # 将换行符转换成 <br>
            'pymdownx.arithmatex' # 启用数学公式
        ],
        extension_configs={
            'pymdownx.arithmatex': {
                'generic': True
            }
        }
    )
        # 【增加日志】在转换后打印HTML内容的片段
    print("--- HTML content snippet AFTER conversion by markdown2 ---")
    print(html_for_frontend[:1000] + "...")
    print("="*67 + "\n")
    
    html_out_path = os.path.join(doc_dir, html_filename)
    with open(html_out_path, 'w', encoding='utf-8') as f:
        f.write(html_for_frontend)
    
    if archive_zip_path and os.path.exists(archive_zip_path):
        os.remove(archive_zip_path)

    return {"status": "ok", "document_id": doc_foldername}


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
    image_url: Optional[str] = None


GEMINI_API_KEY = os.environ.get("GOOGLE_API_KEY")


def analyze_image_with_ai(client: genai.Client, image_url: str) -> Optional[str]:
    """
    根据给定的URL获取图片，并调用AI模型进行详细分析。
    """
    image_bytes = None
    mime_type = 'image/png'
    
    try:
        if image_url.startswith('/api/documents_assets/'):
            local_path = image_url.replace('/api/documents_assets/', '', 1)
            full_path = os.path.join(DOCS_DIR, local_path)
            
            print(f"--- [图片分析] 正在从本地路径读取图片: {full_path}")
            if os.path.exists(full_path):
                with open(full_path, 'rb') as f:
                    image_bytes = f.read()
                if full_path.lower().endswith(('.jpg', '.jpeg')):
                    mime_type = 'image/jpeg'
            else:
                print(f"--- [图片分析] 警告: 本地文件未找到: {full_path}")
                return "[图片分析失败：服务器未找到对应的图片文件]"

        elif image_url.startswith('http://') or image_url.startswith('https://'):
            print(f"--- [图片分析] 正在从URL下载图片: {image_url}")
            response = requests.get(image_url, stream=True)
            response.raise_for_status()
            image_bytes = response.content
            content_type = response.headers.get('Content-Type')
            if content_type:
                mime_type = content_type
        else:
            print(f"--- [图片分析] 错误: 不支持的图片URL格式: {image_url}")
            return "[图片分析失败：不支持的图片URL格式]"

        if not image_bytes:
            return "[图片分析失败：无法获取图片数据]"

        image_analysis_prompt = "Please carefully analyze this image and output a detailed, structured description of everything it contains. Do not summarize. Instead, list all visible elements and details. Your description should include: Objects and entities (what they are, where they are, their relationships), Text present in the image (transcribe exactly if possible), Numbers, symbols, equations, charts, or tables, Colors, shapes, sizes, positions, and layout, Any actions, interactions, or context clues, If the image includes diagrams, figures, or math/physics notations, describe them precisely. Output should be verbose and exhaustive, so that another model reading your output can fully reconstruct and understand the image without ever seeing it."

        image_part = types.Part.from_bytes(data=image_bytes, mime_type=mime_type)
        
        # --- [新增] 打印发送给AI的图片分析请求 ---
        print("\n" + "="*20 + " [AI Image Analysis Request] " + "="*20)
        print(f"--- Model: gemini-2.5-flash")
        print(f"--- Mime Type: {mime_type}")
        print(f"--- Prompt: {image_analysis_prompt}")
        print("="*65 + "\n")
        
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[image_part, image_analysis_prompt]
        )

        # --- [新增] 打印从AI收到的完整图片分析响应 ---
        print("\n" + "="*20 + " [AI Image Analysis Response] " + "="*20)
        print("--- Raw Response Object ---")
        print(response)
        print("="*67 + "\n")

        return response.text

    except Exception as e:
        print(f"--- [图片分析] 调用Gemini进行图片分析时出错: {e}")
        import traceback
        traceback.print_exc()
        return f"[图片分析失败: {e}]"


@app.post("/api/chat")
def chat(req: ChatRequest):
    last_user_message = next((m for m in reversed(req.messages) if m.role == 'user'), None)
    if not last_user_message:
        raise HTTPException(status_code=400, detail="No user message found")
    
    # --- [新增] 打印从前端收到的完整请求体 ---
    print("\n" + "#"*25 + " [New Chat API Request Received] " + "#"*25)
    # 使用 Pydantic 的 model_dump_json 方法来格式化输出
    print(req.model_dump_json(indent=2))
    print("#"*81 + "\n")

    if not GEMINI_API_KEY:
        response_text = (f"[stub] 理解你的问题是: '{last_user_message.text}'。请设置 GOOGLE_API_KEY 环境变量以启用 Gemini AI。")
        return {"role": "assistant", "text": response_text, "timestamp": time.time()}

    try:
        client = genai.Client(api_key=GEMINI_API_KEY)
        
        image_description = None
        if req.image_url:
            print(f"--- [聊天请求] 检测到图片URL，开始分析: {req.image_url}")
            image_description = analyze_image_with_ai(client, req.image_url)

        h = html2text.HTML2Text()
        h.ignore_links = True
        
        focused_content_md = ""
        if req.selected_elements_html:
            md_parts = [h.handle(html) for html in req.selected_elements_html]
            focused_content_md = "\n".join(md_parts)
        elif req.source_element_html:
            focused_content_md = h.handle(req.source_element_html)

        is_first_turn = len(req.messages) == 1
        response_payload = {}
        ai_response_text = ""

        if is_first_turn:
            print("--- [聊天逻辑] 检测到为首次提问，正在构建完整上下文。 ---")
            
            md_filename = f"{req.document_id}.md"
            md_filepath = os.path.join(DOCS_DIR, req.document_id, md_filename)
            
            full_doc_md = ""
            if os.path.exists(md_filepath):
                with open(md_filepath, 'r', encoding='utf-8') as f:
                    full_doc_md = f.read()
            else:
                full_doc_md = "[无法找到完整的Markdown文档上下文]"
                print(f"警告: 在路径 {md_filepath} 未找到对应的Markdown文件")

            # 定义系统提示词
            system_prompt = """你是一个教育与知识解释，答题与解答助手，擅长解析文档内容并结合上下文回答问题。

            我会给你三部分信息：
            1. 文档全文的 Markdown 内容（可能包含文字、公式、图片、表格）
            2. 用户在文档中选中的“聚焦内容”
            3. 用户提出的问题

            你的任务是：
            - 优先基于“聚焦内容”回答问题，如果聚焦内容是图片，就优先基于图片内容描述回答问题
            - 结合全文内容补充必要的上下文信息
            - 如果问题需要推导或分析，分步骤展示推理过程
            - 如果涉及回答问题，请结合你自己的观点和文档信息解答
            - 如果涉及翻译，请保持原意并尽量符合目标语言的表达习惯
            - 如果用户要求用特定风格（如幽默、鲁迅风格），请保持该风格
            """

            # 构造上下文 parts
            context_parts = [system_prompt]

            # 图片描述（如果有）
            if image_description:
                context_parts.extend([
                    "\n---",
                    "[图片内容描述]",
                    "这是关于用户当前正在查看的图片的一份详细文字描述，结合它来回答问题。",
                    image_description
                ])

            # 全文 Markdown
            context_parts.extend([
                "\n---",
                "[全文Markdown内容]",
                full_doc_md
            ])

            # 聚焦内容（如果有）
            if focused_content_md:
                context_parts.extend([
                    "\n---",
                    "[聚焦内容]",
                    focused_content_md
                ])

            # 拼接成最终提示词
            initial_context_string = "\n".join(context_parts)
            user_question = req.messages[0].text

            prompt_for_model = f"{initial_context_string}\n\n---\n\n[用户问题]\n{user_question}\n\n请结合以上信息，给出清晰、准确且结构化的回答。"

            
            print("\n" + "="*50 + "\n>>> CURRENT USER PROMPT (FIRST TURN - FULL CONTEXT):\n" + prompt_for_model + "\n" + "="*50 + "\n")

            response = client.models.generate_content(model="gemini-2.5-flash", contents=[prompt_for_model])
            
            # --- [新增] 打印从AI收到的完整响应 (首次提问) ---
            print("\n" + "="*20 + " [AI Chat Response (First Turn)] " + "="*20)
            print("--- Raw Response Object ---")
            print(response)
            print("="*68 + "\n")

            ai_response_text = response.text
            
            # 修复第3步：解开被代码块包裹的<img>标签
            ai_response_text = re.sub(r'```[a-zA-Z]*\s*(<img[^>]*>)\s*```', r'\1', ai_response_text, flags=re.DOTALL)

            # 修复第1步：在获取AI回复后，再将Markdown转换为HTML
            ai_response_html = markdown.markdown(
                ai_response_text,
                extensions=['tables', 'fenced_code', 'nl2br', 'pymdownx.arithmatex'],
                extension_configs={'pymdownx.arithmatex': {'generic': True}}
            )
            
            # 修复第2步：修正HTML中的图片路径
            correct_image_path_prefix = f'src="/api/documents_assets/{req.document_id}/images/'
            ai_response_html = ai_response_html.replace('src="images/', correct_image_path_prefix)

            response_payload = {
                "role": "assistant", 
                "text": ai_response_text, 
                "htmlText": ai_response_html,
                "timestamp": time.time(),
                "first_user_message_override": prompt_for_model 
            }
        else:
            print("--- [聊天逻辑] 检测到为后续提问，将使用历史记录。 ---")
            history_for_model = [{'role': 'model' if msg.role == 'assistant' else 'user', 'parts': [{'text': msg.text}]} for msg in req.messages[:-1]]
            
            last_user_question = req.messages[-1].text
            prompt_for_model = last_user_question
            if focused_content_md:
                prompt_for_model = (f"请参考我新选中的内容，并结合我们之前的完整对话，回答我的问题。\n\n[新聚焦内容]\n{focused_content_md}\n\n---\n我的问题是：{last_user_question}")
            
            print("\n" + "="*50)
            print("====== V V V ====== SENDING TO GEMINI API ====== V V V ======")
            print(">>> CONVERSATION HISTORY (for model context):")
            print(json.dumps(history_for_model, ensure_ascii=False, indent=2))
            print("\n>>> CURRENT USER PROMPT:")
            print(prompt_for_model)
            print("====== ^ ^ ^ ====== END OF GEMINI API INPUT ====== ^ ^ ^ ======")
            print("="*50 + "\n")

            chat_session = client.chats.create(model="gemini-2.5-flash", history=history_for_model)
            response = chat_session.send_message(prompt_for_model)

            # --- [新增] 打印从AI收到的完整响应 (后续提问) ---
            print("\n" + "="*20 + " [AI Chat Response (Follow-up)] " + "="*20)
            print("--- Raw Response Object ---")
            print(response)
            print("="*69 + "\n")

            ai_response_text = response.text

            # 修复第3步：解开被代码块包裹的<img>标签
            ai_response_text = re.sub(r'```[a-zA-Z]*\s*(<img[^>]*>)\s*```', r'\1', ai_response_text, flags=re.DOTALL)

            # 修复第1步：在获取AI回复后，再将Markdown转换为HTML
            ai_response_html = markdown.markdown(
                ai_response_text,
                extensions=['tables', 'fenced_code', 'nl2br', 'pymdownx.arithmatex'],
                extension_configs={'pymdownx.arithmatex': {'generic': True}}
            )
            
            # 修复第2步：修正HTML中的图片路径
            correct_image_path_prefix = f'src="/api/documents_assets/{req.document_id}/images/'
            ai_response_html = ai_response_html.replace('src="images/', correct_image_path_prefix)

            response_payload = {
                "role": "assistant", 
                "text": ai_response_text, 
                "htmlText": ai_response_html,
                "timestamp": time.time()
            }

        return response_payload

    except Exception as e:
        print(f"调用 Gemini API 时出错: {e}")
        import traceback
        traceback.print_exc()
        ai_response_text = f"调用AI服务时出错: {e}"
        return {"role": "assistant", "text": ai_response_text, "timestamp": time.time()}