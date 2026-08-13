FROM node:22-alpine
WORKDIR /app
COPY dist/server.mjs ./server.mjs
ENV NODE_ENV=production
EXPOSE 8430
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.CBRAIN_AGENT_GATEWAY_PORT||8430)+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
