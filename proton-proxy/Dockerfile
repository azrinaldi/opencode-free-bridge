FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    STATE_DIR=/state

# The Proton python packages live in Proton's own apt repo. Add it from the
# signed release .deb, verified against the checksum published by Proton.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/proton.deb \
      https://repo.protonvpn.com/debian/dists/stable/main/binary-all/protonvpn-stable-release_1.0.10_all.deb \
    && echo "c8a9fffb4ebdd63db08ce7f11c9b0ac394064ae6a210feb9ab63a0f7d8d060a7  /tmp/proton.deb" | sha256sum --check - \
    && dpkg -i /tmp/proton.deb \
    && rm /tmp/proton.deb

RUN apt-get update && apt-get install -y --no-install-recommends \
      wireguard-tools iproute2 iptables \
      python3 python3-proton-vpn-api-core python3-proton-keyring-linux \
      python3-proton-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY src/freehop-agent.py /app/freehop-agent.py
COPY src/freehop-proxy.py /app/freehop-proxy.py
COPY src/freehop-rotate.py /app/freehop-rotate.py
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

VOLUME /state
EXPOSE 18080
ENTRYPOINT ["/app/entrypoint.sh"]
