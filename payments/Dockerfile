FROM node:22-alpine

WORKDIR /workspace

# This image intentionally uses the repository root as its Docker build context.
# The payment workspace imports the private @curb/contracts workspace package.
COPY package.json package-lock.json ./
COPY mobile/package.json ./mobile/package.json
COPY payments/package.json ./payments/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json

RUN npm ci \
    --workspace @curb/contracts \
    --workspace @curb/payments \
    --include-workspace-root=false

COPY payments ./payments
COPY packages/contracts ./packages/contracts

RUN npm run typecheck --workspace @curb/contracts \
    && npm run typecheck --workspace @curb/payments --if-present \
    && npm cache clean --force

ENV NODE_ENV=production \
    PORT=3000

USER node
WORKDIR /workspace/payments

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
