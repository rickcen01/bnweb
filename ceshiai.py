from google import genai
import os

# 创建客户端
client = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])

# 调用模型
response = client.models.generate_content(
    model="gemini-2.5-flash",
    contents="你好",
)

# 输出结果
print(response.text)
