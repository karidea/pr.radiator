FROM node:lts-alpine AS BUILD_IMAGE

WORKDIR /usr/src/app

COPY package.json .
COPY package-lock.json .

RUN npm ci

COPY . .

RUN npm run build

FROM nginx:alpine

WORKDIR /usr/share/nginx/html

RUN rm -rf ./*

COPY --from=BUILD_IMAGE /usr/src/app/build .
