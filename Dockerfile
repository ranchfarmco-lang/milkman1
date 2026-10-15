# The hub, built and served as one container.
#
# Stage one builds the web app with Bun; stage two serves the finished files
# with nginx. The data is deliberately *not* in here: the hub keeps it in Convex
# (see self-hosting/README.md — either a Convex project of your own, or the
# open-source backend in self-hosting/docker-compose.yml), so several devices
# opening the hub see the same family rather than a copy each.
#
#   docker compose -f self-hosting/docker-compose.yml up -d --build
#
# `VITE_CONVEX_URL` is the address the *browser* connects to, and it is baked in
# at build time because the browser is what opens the connection. It is not a
# secret — it is the same address the app shows you. On a machine that other
# devices reach, pass the address they use (a VPN name, say) rather than
# 127.0.0.1, which on a phone would mean the phone itself.
FROM oven/bun:1 AS build
WORKDIR /app

ARG VITE_CONVEX_URL=http://127.0.0.1:3210
ENV VITE_CONVEX_URL=$VITE_CONVEX_URL

COPY . .
RUN bun install
RUN bun run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
