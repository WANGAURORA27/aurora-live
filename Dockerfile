# LiveBridge 生产镜像（多阶段，体积小）
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY public ./public

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY --from=build /app ./
# 密钥配置：挂载 profiles.json（不要把密钥打进镜像）
VOLUME ["/app/profiles.json"]
EXPOSE 8787
CMD ["node", "server.mjs"]