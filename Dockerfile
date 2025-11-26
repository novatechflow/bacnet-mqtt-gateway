FROM node:20

EXPOSE 47808/tcp
EXPOSE 47808/udp

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

CMD [ "node", "src/app.js" ]
