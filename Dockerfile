FROM node:22-alpine

WORKDIR /app

# Copy repo files
COPY package.json ./
COPY server.js ./
COPY SKILL.md ./
COPY public ./public

# Expose port (Railway injects PORT dynamically)
ENV PORT=3000
EXPOSE 3000

# Start server
CMD ["node", "server.js"]

