# 使用官方 Node.js 22 轻量版镜像作为基础镜像
FROM node:22-alpine

# 设置工作目录为项目根目录
WORKDIR /app

# 复制 package.json 和 package-lock.json（如果存在）
COPY package*.json ./

# 安装项目依赖
RUN npm install --production

# 👇 复制所有必要的目录和文件
COPY danmu_api/ ./danmu_api/
COPY utils/ ./utils/
COPY configs/ ./configs/

# 创建数据目录（可选，用于 SQLite 数据库）
RUN mkdir -p /app/data && chmod 755 /app/data

# 设置环境变量 TOKEN 默认值
ENV TOKEN=87654321

# 暴露端口（API 和代理）
EXPOSE 9321 5321

# 启动命令
CMD ["node", "danmu_api/server.js"]
