FROM node:22-alpine

WORKDIR /app

# 复制依赖文件并安装
COPY package*.json ./
RUN npm install --production && npm cache clean --force

# 👇 只需要复制 danmu_api/ 目录（已包含 configs/ 和 utils/）
COPY danmu_api/ ./danmu_api/

# 创建数据目录
RUN mkdir -p /app/data && chmod 755 /app/data

# 暴露端口
EXPOSE 9321 5321

# 启动命令
CMD ["node", "danmu_api/server.js"]
