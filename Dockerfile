FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV HOST=0.0.0.0
EXPOSE 3300
CMD ["node", "--use-system-ca", "server.js"]
