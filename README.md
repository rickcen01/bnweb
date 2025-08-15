## nbweb: Infinite Canvas Cognitive Workspace (V2.0)

This is a web app that turns parsed document content (e.g., PDF→MD→HTML from `mineru2/MinerU`) into an infinite-canvas learning workspace. You can hover any atomic element to open a micro chat, save it as a movable knowledge node, and build a personalized knowledge map.

### Features
- Infinite pan/zoom canvas with a central content frame (fixed width, unlimited height)
- In-situ micro chatboxes anchored to any paragraph/image/table/etc.
- Three dispositions: Save & Collapse (→ knowledge node), Expand to Sidebar, Discard
- Draggable knowledge nodes with visual link back to source element
- Persistent storage per-document (server JSON or local fallback)
- Optional LLM proxy via server (uses `OPENAI_API_KEY`) with graceful stub fallback

### Layout
- `web/` — static frontend (HTML/CSS/JS)
- `server/` — FastAPI backend for persistence and chat proxy
- `data/` — created on first run to store uploaded docs and nodes

### Quick Start
1) Activate your Python env (optional but recommended):
   - Windows PowerShell:
     - If you have `D:\mineru2\venv`, activate it:
       - `D:\mineru2\venv\Scripts\activate`
2) Install dependencies:
   - `pip install -r requirements.txt`
3) (Optional) Configure LLM:
   - Set `OPENAI_API_KEY` as an environment variable before starting the server. If not set, the chat will return a local stub response.
4) Start the server:
   - `uvicorn server.main:app --host 0.0.0.0 --port 7861 --reload`
5) Open the app:
   - Visit `http://localhost:7861/`

### Using with MinerU
- Convert your PDF with MinerU however you prefer (e.g., via `mineru-gradio` or CLI) and obtain HTML output.
- Place the HTML into `nbweb/data/documents/` or use the in-app Upload button.
- Select the document from the top bar and start annotating.

### Notes
- If the server API is unreachable, the app falls back to localStorage for nodes. You can still use the canvas and micro chats (stubbed).
- Data model for a knowledge node:
```
{
  "node_id": string,
  "source_element_id": string,
  "canvas_position": { "x": number, "y": number, "zoom_level": number },
  "conversation_log": [ { "role": "user"|"assistant", "text": string, "timestamp": number } ],
  "user_annotations": string | null
}
```


