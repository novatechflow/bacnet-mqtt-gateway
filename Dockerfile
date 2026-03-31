FROM node:20

EXPOSE 47808/tcp
EXPOSE 47808/udp

WORKDIR /usr/src/app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm_config_build_from_source=true npm install

COPY . .

CMD [ "node", "src/app.js" ]
