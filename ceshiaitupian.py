from google import genai
from google.genai import types

client = genai.Client()

with open(r'D:\mineru2\nbweb\image.png', 'rb') as f:
    image_bytes = f.read()

contents = [
    types.Part.from_bytes(
        data=image_bytes,
        mime_type='image/jpeg',
    ),
    '图片内容是什么'
]

# 打印输入信息（不要访问 Part 的属性）
print("=== Input to model ===")
for c in contents:
    if isinstance(c, types.Part):
        print("<Image Part>")  # 只打印类型，不访问属性
    else:
        print(c)

# 调用模型
response = client.models.generate_content(
    model='gemini-2.5-flash',
    contents=contents
)

# 打印模型输出
print("\n=== Output from model ===")
print(response.text)

# 打印原始返回对象（可选）
print("\n=== Raw response ===")
print(response)
