FROM node:24-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
ENV PORT=3000 NODE_ENV=production
EXPOSE 3000
# Apply migrations, then serve the API and the built web UI.
CMD ["sh", "-c", "pnpm --filter @impression/api db:migrate && exec pnpm --filter @impression/api exec tsx src/index.ts"]
