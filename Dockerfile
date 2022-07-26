FROM node:16-alpine

WORKDIR /usr/src/sorrir/framework
COPY ./package.json .
COPY ./pnpm-lock.yaml .
COPY ./tsconfig.json .
COPY ./source ./source
COPY ./dist ./dist
RUN npm install -g pnpm && \
    pnpm install --frozen-lockfile --prod --silent --store-dir . && \
    rm -rf ./node_modules ./v3