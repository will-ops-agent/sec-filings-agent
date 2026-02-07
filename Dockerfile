# Bun + Railway-friendly
FROM oven/bun:1.2.2

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

ENV NODE_ENV=production

# Railway sets PORT
CMD ["bun", "run", "start"]
