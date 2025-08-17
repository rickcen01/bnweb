from google import genai

client = genai.Client()

# 上传图片文件
my_file = client.files.upload(file="D:\\mineru2\\nbweb\\image.png")

# 详细分析提示词
prompt = """
### 1. Image Type
Identify the general nature of the image (e.g., lecture slide, scientific diagram, data visualization, flowchart, manuscript page, schematic, map).

---

### 2. Core Subject
State the primary topic or purpose of the image.

---

### 3. Composition
Describe the overall layout and arrangement of elements
(e.g., "A three-column layout with a main central diagram flanked by text annotations and a data table on the right.").

---

### 4. Visual Style
Note the overall aesthetic
(e.g., "Monochromatic, technical line drawing," or "Full-color, realistic illustration.").

---

## 2. Verbatim Text Transcription
- Transcribe all textual content exactly as it appears.
- Preserve original language, capitalization, punctuation, and formatting (like **bolding** or *italics*) if possible.
- Use sub-headings to group text by its location or function within the image
(e.g., "Header Text," "Figure Captions," "Labels on Diagram," "Legend Text").

---

## 3. Analysis of Discrete Visual Elements
Analyze each significant non-textual element one by one.
Use a clear heading for each
(e.g., "Analysis of Bar Chart," "Analysis of Diagram A," "Analysis of the Map").

For each element, provide the following breakdown:

### a. Component Identification
- List all constituent parts, symbols, and icons.
- For a chart/graph: Identify axes (X, Y), data series (lines, bars, points), legend, gridlines, title.
- For a diagram (biology, chemistry, engineering): Identify all labeled parts, objects, arrows indicating flow or interaction, and symbolic representations.
- For a map: Identify landmasses, bodies of water, borders, scale, compass, key/legend, routes.

### b. Relationships and Structure
Describe how the components are connected and organized. Examples:
- "The flowchart shows a process flow from 'Start' to 'End' with three decision diamonds (if/then)."
- "The biological diagram shows the mitochondrion is located within the cell's cytoplasm."
- "The bar chart compares the GDP of five countries, with the Y-axis representing GDP in billions and the X-axis listing the countries."

### c. Precise Definition of Annotations and Data
This section is critical for accuracy.
For any label, describe exactly what object or area it points to.
For any axis on a graph, state its title, its range (minimum to maximum value), and its units.
For any scale on a map or diagram, transcribe its values and units.
For any arrow or connecting line, describe its start point, end point, and the type of relationship it signifies
(e.g., movement, causation, label).

---

## 4. Tables and Data Sets
If any tables are present, replicate them perfectly using Markdown format.
Include all headers, rows, and columns.

---

## 5. Formulas and Special Notation
- Transcribe any mathematical equations, chemical formulas, or other formal notation.
- Define each variable or symbol in the formula based on the surrounding context provided in the image.

---

## 6. Concluding Summary of Information
Briefly summarize the image's complete informational payload.
This is not an interpretation, but a final, holistic statement of what the image factually presents.
(e.g., "The image presents a quantitative comparison of sales figures from 2020-2022 across four regions and provides the mathematical formula used to calculate profit margin.").
"""


# 调用 Gemini
response = client.models.generate_content(
    model="gemini-2.5-flash",
    contents=[my_file, prompt]
)

print(response.text)
